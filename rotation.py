"""VPS-style services on rotating GitHub accounts.

A *service* = one repo + branch + machine + on-switch preset + commands, plus an
ordered list of GitHub accounts. It runs on account 1; when a switch happens
arrives it applies the preset on that account (stop / delete), then continues on
account 2, ... account n, then back to account 1.

Per account (steps 1-6):
  1. pointer -> current account
  2. that account already has a codespace for the repo?
       preset Stop   -> start it (resume)  | preset Delete -> delete it, create new
       none          -> create new
  3. run the commands one by one (prefix `bg:` = detached tmux session)
  4. on switch: preset Stop -> stop codespace | Delete -> delete it
  5. pointer -> next account (wraps)
  6. repeat

State lives in MongoDB (`services` collection) so restarts keep the pointer.
"""
import asyncio
import os
import re
import shlex
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import APIRouter, HTTPException, Request

LOG_MAX = 100
WAIT_AVAILABLE_SECONDS = 600
CMD_TIMEOUT = 1800
SCHEDULER_TICK = 30

db = gh = require_user = ka_tasks = ka_loop = ka_key = None
_locks: dict[str, asyncio.Lock] = {}
_tasks: set[asyncio.Task] = set()
router = APIRouter()


_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def group_commands(entries) -> list[str]:
    """One command per line, EXCEPT heredoc blocks (`cat > f <<'EOF'` ... `EOF`)
    which are kept together as a single multi-line command."""
    lines = [l for e in entries for l in str(e).split("\n")]
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        m = _HEREDOC.search(line)
        if not m:
            out.append(line.strip())
            i += 1
            continue
        term, block = m.group(2), [line.strip()]
        i += 1
        while i < len(lines):
            block.append(lines[i])
            i += 1
            if lines[i - 1].strip() == term:
                break
        out.append("\n".join(block))
    return out


def _label(cmd: str) -> str:
    """Log label only - never log heredoc bodies (they usually hold secrets)."""
    first = cmd.split("\n", 1)[0]
    extra = cmd.count("\n")
    first = first if len(first) <= 80 else first[:77] + "..."
    return first + (f"  [+{extra} lines hidden]" if extra else "")


def _now() -> datetime:
    return datetime.utcnow()


def _mode(cfg: dict) -> str:
    m = cfg.get("switchMode")
    if m in ("off", "timer", "clock"):
        return m
    return "timer" if (cfg.get("autoSwitchMinutes") or 0) > 0 else "off"  # configs saved before clock mode


def _next_switch(cfg: dict):
    """Naive-UTC datetime of the next automatic switch (None = no auto switch)."""
    mode = _mode(cfg)
    if mode == "timer":
        m = cfg.get("autoSwitchMinutes") or 0
        return _now() + timedelta(minutes=m) if m > 0 else None
    if mode == "clock":
        try:
            hh, mm = (int(x) for x in cfg["clockTime"].split(":"))
            tz = ZoneInfo(cfg.get("timezone") or "UTC")
        except Exception:
            return None
        now_local = datetime.now(tz)
        t = now_local.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if t <= now_local:
            t += timedelta(days=1)  # wall-clock arithmetic, DST-safe
        return t.astimezone(timezone.utc).replace(tzinfo=None)
    return None


def _oid(s) -> ObjectId:
    try:
        return ObjectId(s)
    except (InvalidId, TypeError):
        raise HTTPException(400, "Invalid id")


# ---------- state helpers ----------
async def _get(sid: ObjectId) -> dict:
    doc = await db.services.find_one({"_id": sid})
    if not doc:
        raise HTTPException(404, "Service not found")
    return doc


async def _set(sid, **fields):
    await db.services.update_one({"_id": sid}, {"$set": fields})


async def _log(sid, msg: str):
    print(f"[service {sid}] {msg}")
    entry = f"{_now():%H:%M:%S} {msg}"
    await db.services.update_one(
        {"_id": sid}, {"$push": {"log": {"$each": [entry], "$slice": -LOG_MAX}}}
    )


async def _token_for(uid: int, token_id: str):
    try:
        doc = await db.tokens.find_one({"_id": ObjectId(token_id), "telegramId": uid})
    except (InvalidId, TypeError):
        return None, "?"
    return (doc["token"], doc["label"]) if doc else (None, "?")


def _public(cfg: dict) -> dict:
    sw = cfg.get("switchAt")
    return {
        "id": str(cfg["_id"]), "name": cfg.get("name"),
        "repo": f"{cfg.get('owner')}/{cfg.get('repo')}", "ref": cfg.get("ref", ""),
        "machine": cfg.get("machine"), "onSwitch": cfg.get("onSwitch", "stop"),
        "commands": cfg.get("commands", []), "accounts": cfg.get("accounts", []),
        "pointer": cfg.get("pointer", 0), "running": cfg.get("running", False),
        "status": cfg.get("status", "idle"), "log": cfg.get("log", []),
        "autoSwitchMinutes": cfg.get("autoSwitchMinutes", 0),
        "switchMode": _mode(cfg), "clockTime": cfg.get("clockTime", ""),
        "timezone": cfg.get("timezone", ""),
        "switchAt": (sw.isoformat() + "Z") if sw else None,
        "active": cfg.get("active"),
    }


# ---------- remote execution ----------
async def _ssh(token: str, name: str, command: str, timeout: int):
    env = os.environ.copy()
    env["GH_TOKEN"] = token
    env["GITHUB_TOKEN"] = token
    proc = await asyncio.create_subprocess_exec(
        "gh", "codespace", "ssh", "-c", name, "--", command,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "timed out"
    return proc.returncode, out.decode(errors="replace")


async def _ssh_retry(token, name, remote, timeout):
    rc, out = 255, ""
    for _ in range(3):  # ssh can flap right after the codespace comes up
        rc, out = await _ssh(token, name, remote, timeout)
        if rc != 255:
            break
        await asyncio.sleep(10)
    return rc, out


async def _wait_state(sid, tok, name, want="Available", timeout=WAIT_AVAILABLE_SECONDS) -> bool:
    loop = asyncio.get_event_loop()
    end, last = loop.time() + timeout, None
    while loop.time() < end:
        try:
            st = (await gh(tok, f"/user/codespaces/{name}")).get("state")
        except HTTPException:
            st = last  # transient (e.g. 404 right after create) - keep waiting
        if st != last:
            await _log(sid, f"  codespace state: {st}")
            last = st
        if st == want:
            return True
        if st in ("Failed", "Unavailable", "Deleted"):
            return False
        await asyncio.sleep(5)
    return False


# ---------- teardown (step 4) ----------
async def _teardown(sid, cfg, tok, name):
    t = ka_tasks.pop(ka_key(cfg["telegramId"], name), None)
    if t:
        t.cancel()
    try:
        if cfg.get("onSwitch") == "delete":
            await _log(sid, f"Step 4: preset Delete -> deleting {name}")
            await gh(tok, f"/user/codespaces/{name}", method="DELETE")
        else:
            await _log(sid, f"Step 4: preset Stop -> stopping {name}")
            await gh(tok, f"/user/codespaces/{name}/stop", method="POST")
    except HTTPException as e:
        await _log(sid, f"  teardown warning: {e.detail}")


async def _teardown_active(sid, cfg):
    act = cfg.get("active")
    if not act:
        return
    tok, _ = await _token_for(cfg["telegramId"], act["tokenId"])
    if not tok:
        await _log(sid, "  active account token missing - cannot stop/delete codespace")
        return
    await _teardown(sid, cfg, tok, act["name"])


# ---------- activate one account (steps 1-3) ----------
async def _activate(sid, idx: int) -> bool:
    cfg = await _get(sid)
    uid = cfg["telegramId"]
    token_id = cfg["accounts"][idx]
    tok, label = await _token_for(uid, token_id)
    await _set(sid, pointer=idx, status=f"starting on account {idx + 1}")
    await _log(sid, f"Step 1: pointer -> account {idx + 1} ({label})")
    if not tok:
        await _log(sid, "  account token not found")
        return False

    owner, repo = cfg["owner"], cfg["repo"]
    full = f"{owner}/{repo}".lower()
    name = None
    try:
        data = await gh(tok, "/user/codespaces")
        existing = next(
            (c for c in data.get("codespaces", [])
             if (c.get("repository", {}).get("full_name") or "").lower() == full), None)

        if existing and cfg.get("onSwitch") == "delete":
            await _log(sid, f"Step 2: existing codespace + preset Delete -> deleting {existing['name']}")
            await gh(tok, f"/user/codespaces/{existing['name']}", method="DELETE")
            existing = None

        if existing:
            name = existing["name"]
            state = existing.get("state")
            if state == "ShuttingDown":
                await _wait_state(sid, tok, name, want="Shutdown", timeout=120)
                state = "Shutdown"
            if state == "Shutdown":
                await _log(sid, f"Step 2: existing codespace + preset Stop -> resuming {name}")
                await gh(tok, f"/user/codespaces/{name}/start", method="POST")
            else:
                await _log(sid, f"Step 2: existing codespace {name} is {state}")
        else:
            await _log(sid, f"Step 2: creating new codespace for {owner}/{repo}")
            body = {"machine": cfg.get("machine") or "standardLinux32gb", "idle_timeout_minutes": 240}
            if cfg.get("ref"):
                body["ref"] = cfg["ref"]
            created = await gh(tok, f"/repos/{owner}/{repo}/codespaces", method="POST", json_body=body)
            name = created["name"]
    except HTTPException as e:
        await _log(sid, f"  GitHub error: {e.detail}")
        if name:
            await _teardown(sid, cfg, tok, name)
        return False

    await _set(sid, active={"idx": idx, "name": name, "tokenId": token_id})
    if not await _wait_state(sid, tok, name):
        await _log(sid, "  codespace never became Available")
        await _teardown(sid, cfg, tok, name)
        await _set(sid, active=None)
        return False

    ka_tasks[ka_key(uid, name)] = asyncio.create_task(ka_loop(name, tok))

    workdir = f"/workspaces/{repo}"
    commands = group_commands(cfg.get("commands") or [])
    if any(re.search(r"\bdocker\b", c) for c in commands):
        # "Available" != dockerd up yet; wait for the daemon before running docker commands
        await _log(sid, "Waiting for Docker daemon...")
        await _set(sid, status=f"account {idx + 1}: waiting for Docker")
        rc, _out = await _ssh_retry(
            tok, name, "for i in $(seq 1 90); do docker info >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1", 240)
        await _log(sid, "  Docker ready" if rc == 0 else "  Docker still not ready - running commands anyway")

    for n, cmd in enumerate(commands, 1):
        bg = cmd.startswith("bg:")
        if bg:
            cmd = cmd[3:].strip()
        inner = f"cd {shlex.quote(workdir)} && {cmd}"
        if bg:
            sess = f"svc{n}"
            remote = (
                "command -v tmux >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq tmux); "
                f"tmux kill-session -t {sess} 2>/dev/null; "
                f"tmux new-session -d -s {sess} {shlex.quote('bash -lc ' + shlex.quote(inner))}"
            )
        else:
            remote = f"bash -lc {shlex.quote(inner)}"
        await _log(sid, f"Step 3: [{n}] {'(bg) ' if bg else ''}{_label(cmd)}")
        await _set(sid, status=f"account {idx + 1}: running command {n}")
        rc, out = await _ssh_retry(tok, name, remote, CMD_TIMEOUT)
        if rc != 0:
            await _log(sid, f"  command {n} failed (rc={rc}): {out.strip()[-300:]}")
            await _teardown(sid, cfg, tok, name)
            await _set(sid, active=None)
            return False

    await _log(sid, f"Step 3 done: service running on account {idx + 1} ({name})")
    return True


async def _run_from(sid, start_idx: int) -> bool:
    cfg = await _get(sid)
    n = len(cfg["accounts"])
    for attempt in range(n):
        i = (start_idx + attempt) % n
        if await _activate(sid, i):
            await _set(
                sid, running=True, pointer=i, status=f"running on account {i + 1}",
                switchAt=_next_switch(cfg),
            )
            return True
        await _log(sid, f"Account {i + 1} failed - trying next")
    await _set(sid, running=False, active=None, switchAt=None, status="all accounts failed")
    return False


# ---------- operations ----------
def _lock(sid) -> asyncio.Lock:
    return _locks.setdefault(str(sid), asyncio.Lock())


async def op_start(sid):
    async with _lock(sid):
        cfg = await _get(sid)
        await _log(sid, "=== service start ===")
        await _run_from(sid, min(cfg.get("pointer", 0), len(cfg["accounts"]) - 1))


async def op_switch(sid, target: int | None = None):
    async with _lock(sid):
        cfg = await _get(sid)
        n = len(cfg["accounts"])
        if not n:
            return
        await _log(sid, "=== switch ===")
        await _teardown_active(sid, cfg)
        await _set(sid, active=None, status="switching")
        nxt = target if target is not None else (cfg.get("pointer", 0) + 1) % n
        await _log(sid, f"Step 5: next pointer -> account {nxt + 1}")
        await _run_from(sid, nxt)


async def op_stop(sid):
    async with _lock(sid):
        cfg = await _get(sid)
        await _teardown_active(sid, cfg)
        await _set(sid, running=False, active=None, switchAt=None, status="stopped")
        await _log(sid, "=== service stopped ===")


def _spawn(sid, coro):
    async def guard():
        try:
            await coro
        except Exception as e:  # never let a background crash vanish silently
            await _log(sid, f"ENGINE ERROR: {e}")
            await _set(sid, status=f"error: {e}")
    t = asyncio.create_task(guard())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


def _busy_check(sid):
    if _lock(sid).locked():
        raise HTTPException(409, "Service is busy (starting/switching). Wait for it to finish.")


async def _scheduler():
    while True:
        await asyncio.sleep(SCHEDULER_TICK)
        try:
            async for cfg in db.services.find({"running": True, "switchAt": {"$ne": None}}):
                sw, sid = cfg.get("switchAt"), cfg["_id"]
                if sw and sw <= _now() and not _lock(sid).locked():
                    await _log(sid, "auto-switch timer fired")
                    _spawn(sid, op_switch(sid))
        except Exception as e:
            print(f"[service scheduler] {e}")


# ---------- routes ----------
def _parse_repo(s: str):
    s = (s or "").strip()
    m = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s#?]+)", s)
    if m:
        return m.group(1), re.sub(r"\.git$", "", m.group(2))
    parts = s.strip("/").split("/")
    if len(parts) == 2 and all(parts):
        return parts[0], re.sub(r"\.git$", "", parts[1])
    return None


async def _owned(request: Request, service_id: str):
    user = require_user(request)
    cfg = await _get(_oid(service_id))
    if cfg["telegramId"] != user["id"]:
        raise HTTPException(404, "Service not found")
    return user["id"], cfg


async def _validate(uid: int, body: dict) -> dict:
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Give the service a name")
    parsed = _parse_repo(body.get("repo"))
    if not parsed:
        raise HTTPException(400, "Repo must be owner/repo or a GitHub URL")
    on_switch = body.get("onSwitch", "stop")
    if on_switch not in ("stop", "delete"):
        raise HTTPException(400, "Invalid on-switch preset")
    accounts = body.get("accounts") or []
    if not accounts:
        raise HTTPException(400, "Add at least one account")
    for i, tid in enumerate(accounts, 1):
        tok, _ = await _token_for(uid, tid)
        if not tok:
            raise HTTPException(400, f"Account {i}: pick a saved GitHub account")
    try:
        mins = max(0, int(body.get("autoSwitchMinutes") or 0))
    except (TypeError, ValueError):
        mins = 0
    mode = body.get("switchMode") or ("timer" if mins > 0 else "off")
    if mode not in ("off", "timer", "clock"):
        raise HTTPException(400, "Invalid auto-switch mode")
    clock_time = (body.get("clockTime") or "").strip()
    tz_name = (body.get("timezone") or "UTC").strip()
    if mode == "timer" and mins <= 0:
        raise HTTPException(400, "Timer: enter minutes (1 or more)")
    if mode == "clock":
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", clock_time)
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            raise HTTPException(400, "Clock: set a time like 04:00")
        try:
            ZoneInfo(tz_name)
        except Exception:
            raise HTTPException(400, f"Unknown timezone: {tz_name}")
    return {
        "name": name, "owner": parsed[0], "repo": parsed[1],
        "ref": (body.get("ref") or "").strip(),
        "machine": body.get("machine") or "standardLinux32gb",
        "onSwitch": on_switch,
        "commands": group_commands(body.get("commands") or []),
        "accounts": accounts, "autoSwitchMinutes": mins,
        "switchMode": mode, "clockTime": clock_time, "timezone": tz_name,
    }


@router.get("/api/services")
async def list_services(request: Request):
    user = require_user(request)
    out = []
    async for cfg in db.services.find({"telegramId": user["id"]}):
        p = _public(cfg)
        p["log"] = []
        out.append(p)
    return out


@router.post("/api/services")
async def create_service(request: Request):
    user = require_user(request)
    fields = await _validate(user["id"], await request.json())
    doc = {
        **fields, "telegramId": user["id"], "pointer": 0, "running": False,
        "status": "idle", "log": [],
        "switchAt": None, "active": None, "createdAt": _now(),
    }
    res = await db.services.insert_one(doc)
    return _public(await _get(res.inserted_id))


@router.get("/api/services/{service_id}")
async def get_service(service_id: str, request: Request):
    _, cfg = await _owned(request, service_id)
    return _public(cfg)


@router.put("/api/services/{service_id}")
async def update_service(service_id: str, request: Request):
    uid, cfg = await _owned(request, service_id)
    fields = await _validate(uid, await request.json())
    act = cfg.get("active")
    if cfg.get("running") and act:
        accs = fields["accounts"]
        if act["idx"] >= len(accs) or accs[act["idx"]] != act["tokenId"]:
            raise HTTPException(409, "Can't remove/reorder the live account. Stop the service first.")
    fields["pointer"] = min(cfg.get("pointer", 0), len(fields["accounts"]) - 1)
    if cfg.get("running"):
        fields["switchAt"] = _next_switch(fields)
    await _set(cfg["_id"], **fields)
    return _public(await _get(cfg["_id"]))


@router.delete("/api/services/{service_id}")
async def delete_service(service_id: str, request: Request):
    _, cfg = await _owned(request, service_id)
    if cfg.get("running") or cfg.get("active"):
        raise HTTPException(409, "Stop the service first")
    await db.services.delete_one({"_id": cfg["_id"]})
    return {"ok": True}


@router.post("/api/services/{service_id}/start")
async def start_service(service_id: str, request: Request):
    _, cfg = await _owned(request, service_id)
    if cfg.get("running"):
        raise HTTPException(409, "Already running")
    _busy_check(cfg["_id"])
    _spawn(cfg["_id"], op_start(cfg["_id"]))
    return {"ok": True}


@router.post("/api/services/{service_id}/switch")
async def switch_service(service_id: str, request: Request):
    _, cfg = await _owned(request, service_id)
    if not cfg.get("running"):
        raise HTTPException(409, "Service is not running")
    _busy_check(cfg["_id"])
    _spawn(cfg["_id"], op_switch(cfg["_id"]))
    return {"ok": True}


@router.post("/api/services/{service_id}/stop")
async def stop_service(service_id: str, request: Request):
    _, cfg = await _owned(request, service_id)
    _busy_check(cfg["_id"])
    _spawn(cfg["_id"], op_stop(cfg["_id"]))
    return {"ok": True}


@router.post("/api/services/{service_id}/pointer")
async def set_pointer(service_id: str, request: Request):
    """User-controlled pointer. Idle: just moves it. Running: switches straight
    to that account (current codespace handled by its preset first)."""
    _, cfg = await _owned(request, service_id)
    body = await request.json()
    try:
        idx = int(body.get("index"))
    except (TypeError, ValueError):
        raise HTTPException(400, "index required")
    if not 0 <= idx < len(cfg["accounts"]):
        raise HTTPException(400, "index out of range")
    if cfg.get("running"):
        if idx == cfg.get("pointer"):
            return {"ok": True}
        _busy_check(cfg["_id"])
        _spawn(cfg["_id"], op_switch(cfg["_id"], target=idx))
    else:
        await _set(cfg["_id"], pointer=idx)
    return {"ok": True}


def setup(app, *, db, gh, require_user, ka_tasks, ka_loop, ka_key):
    globals().update(db=db, gh=gh, require_user=require_user,
                     ka_tasks=ka_tasks, ka_loop=ka_loop, ka_key=ka_key)
    app.include_router(router)

    # Wrap the app lifespan (add_event_handler/on_event are gone in newer Starlette)
    orig = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(a):
        task = asyncio.create_task(_scheduler())
        try:
            async with orig(a) as state:
                yield state
        finally:
            task.cancel()
    app.router.lifespan_context = lifespan