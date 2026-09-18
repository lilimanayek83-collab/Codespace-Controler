import os
import re
import json
import hmac
import hashlib
import urllib.parse
import asyncio
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId
from bson.errors import InvalidId
from ptyprocess import PtyProcessUnicode

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
MONGO_URI = os.getenv("MONGO_URI")
PORT = int(os.getenv("PORT", "3000"))

if not BOT_TOKEN:
    print("WARNING: BOT_TOKEN not set - Telegram auth will fail")
if not MONGO_URI:
    print("WARNING: MONGO_URI not set - DB calls will fail")

app = FastAPI()

mongo_client = AsyncIOMotorClient(MONGO_URI)
db = mongo_client["codespace_miniapp"]

GITHUB_API = "https://api.github.com"
DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"
DEV_USER = {"id": 999999999, "first_name": "DevUser"}
print(f"DEV_MODE is {'ON — Telegram auth is bypassed!' if DEV_MODE else 'off'}")


# ---------- Telegram WebApp initData validation ----------
def validate_init_data(init_data: str):
    """Verifies the initData string the Mini App sends actually came from
    Telegram for this bot, per Telegram's documented HMAC scheme.
    In DEV_MODE, an empty/missing initData (i.e. opened in a plain browser,
    not through Telegram) is treated as a fixed dev user so you can test
    on your PC before wiring up Telegram at all."""
    if not init_data or init_data in ("undefined", "null"):
        return DEV_USER if DEV_MODE else None
    try:
        pairs = dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))
        received_hash = pairs.pop("hash", None)
        if not received_hash:
            return None

        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

        if computed_hash != received_hash:
            return None

        user_json = pairs.get("user")
        if not user_json:
            return None
        return json.loads(user_json)
    except Exception:
        return None


def require_user(request: Request) -> dict:
    init_data = request.headers.get("x-telegram-init-data")
    user = validate_init_data(init_data)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or missing Telegram auth")
    return user


def to_object_id(id_str: str) -> ObjectId:
    try:
        return ObjectId(id_str)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail="Invalid id")


# ---------- Token store (plaintext, as requested) ----------
@app.get("/api/tokens")
async def list_tokens(request: Request):
    user = require_user(request)
    cursor = db.tokens.find({"telegramId": user["id"]}, {"label": 1, "createdAt": 1})
    tokens = []
    async for doc in cursor:
        tokens.append({"_id": str(doc["_id"]), "label": doc["label"], "createdAt": doc["createdAt"].isoformat()})
    user_doc = await db.users.find_one({"telegramId": user["id"]})
    return {"tokens": tokens, "activeTokenId": user_doc.get("activeTokenId") if user_doc else None}


@app.post("/api/tokens")
async def add_token(request: Request):
    user = require_user(request)
    body = await request.json()
    label, token = body.get("label"), body.get("token")
    if not label or not token:
        raise HTTPException(status_code=400, detail="label and token are required")

    doc = {"telegramId": user["id"], "label": label, "token": token, "createdAt": datetime.now(timezone.utc)}
    result = await db.tokens.insert_one(doc)

    existing = await db.users.find_one({"telegramId": user["id"]})
    if not existing:
        await db.users.insert_one({"telegramId": user["id"], "activeTokenId": str(result.inserted_id)})

    return {"_id": str(result.inserted_id), "label": label}


@app.post("/api/tokens/{token_id}/activate")
async def activate_token(token_id: str, request: Request):
    user = require_user(request)
    oid = to_object_id(token_id)
    doc = await db.tokens.find_one({"_id": oid, "telegramId": user["id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Token not found")
    await db.users.update_one(
        {"telegramId": user["id"]}, {"$set": {"activeTokenId": token_id}}, upsert=True
    )
    return {"ok": True}


@app.delete("/api/tokens/{token_id}")
async def delete_token(token_id: str, request: Request):
    user = require_user(request)
    oid = to_object_id(token_id)
    await db.tokens.delete_one({"_id": oid, "telegramId": user["id"]})
    user_doc = await db.users.find_one({"telegramId": user["id"]})
    if user_doc and user_doc.get("activeTokenId") == token_id:
        await db.users.update_one({"telegramId": user["id"]}, {"$set": {"activeTokenId": None}})
    return {"ok": True}


async def get_active_token(telegram_id: int):
    user_doc = await db.users.find_one({"telegramId": telegram_id})
    if not user_doc or not user_doc.get("activeTokenId"):
        return None
    try:
        oid = ObjectId(user_doc["activeTokenId"])
    except (InvalidId, TypeError):
        return None
    token_doc = await db.tokens.find_one({"_id": oid, "telegramId": telegram_id})
    return token_doc["token"] if token_doc else None


# ---------- GitHub Codespaces API ----------
async def gh_request(token: str, path: str, method: str = "GET", json_body: dict | None = None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(method, f"{GITHUB_API}{path}", headers=headers, json=json_body)
    data = {}
    if resp.text:
        try:
            data = resp.json()
        except ValueError:
            data = {}
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=data.get("message", f"GitHub API error {resp.status_code}"))
    return data


# ---------- Billing (GitHub Codespaces usage, via GitHub's own billing API) ----------
# Uses GitHub's Enhanced Billing Platform endpoint:
#   GET /users/{username}/settings/billing/usage?year=YYYY&month=MM
# which returns metered usageItems (product/sku/unitType/quantity/...).
# We sum every item where product == "Codespaces" and the unit is a time
# unit (minutes or hours) to get "hours used this month" per account.
# Notes:
#  - This is GitHub's own metered usage, not a live stopwatch on a running
#    session, so it updates on GitHub's schedule (usually within the hour),
#    not the instant.
#  - The token needs the "Plan" user permission (read) if it's a fine-grained
#    PAT, or just be a valid classic PAT for that same user. If billing isn't
#    enabled for that account, GitHub returns an error which we surface
#    per-account instead of failing the whole request.
async def fetch_account_billing(token: str, label: str, token_id: str) -> dict:
    entry = {
        "tokenId": token_id,
        "label": label,
        "login": None,
        "period": None,
        "total_hours": 0.0,
        "breakdown": [],
        "error": None,
    }
    try:
        me = await gh_request(token, "/user")
        login = me.get("login")
        entry["login"] = login

        now = datetime.now(timezone.utc)
        usage = await gh_request(
            token, f"/users/{login}/settings/billing/usage?year={now.year}&month={now.month}"
        )
        entry["period"] = f"{now.year}-{now.month:02d}"

        totals_minutes: dict[str, float] = {}
        total_minutes = 0.0
        for item in usage.get("usageItems", []):
            if (item.get("product") or "").strip().lower() != "codespaces":
                continue
            unit = (item.get("unitType") or "").strip().lower()
            qty = item.get("quantity", 0) or 0
            if unit.startswith("minute"):
                minutes = qty
            elif unit.startswith("hour"):
                minutes = qty * 60
            else:
                continue  # skip non-time units, e.g. GB-month storage
            sku = item.get("sku") or "Codespaces"
            totals_minutes[sku] = totals_minutes.get(sku, 0.0) + minutes
            total_minutes += minutes

        entry["total_hours"] = round(total_minutes / 60, 2)
        entry["breakdown"] = [
            {"sku": sku, "hours": round(minutes / 60, 2)}
            for sku, minutes in sorted(totals_minutes.items())
        ]
    except HTTPException as e:
        entry["error"] = str(e.detail)
    except Exception as e:
        entry["error"] = str(e)
    return entry


@app.get("/api/billing")
async def get_billing(request: Request):
    user = require_user(request)
    cursor = db.tokens.find({"telegramId": user["id"]})
    token_docs = [doc async for doc in cursor]
    results = await asyncio.gather(
        *[
            fetch_account_billing(doc["token"], doc["label"], str(doc["_id"]))
            for doc in token_docs
        ]
    )
    return list(results)


# ---------- Keep Awake (defeat GitHub's idle auto-stop) ----------
# GitHub stops a codespace after a period of no activity (max configurable
# idle_timeout_minutes is 240 = 4 hours; it cannot be disabled outright).
# The reliable workaround: periodically run a harmless command over
# `gh codespace ssh`, which counts as activity and resets the idle timer,
# so the codespace stays up indefinitely until the user taps Stop.
# State is in-memory only (per running server process) — restarting the
# server clears any active keep-alive loops.
KEEPALIVE_INTERVAL_SECONDS = 600  # 10 minutes
keepalive_tasks: dict[str, asyncio.Task] = {}


def _keepalive_key(telegram_id: int, name: str) -> str:
    return f"{telegram_id}:{name}"


async def _keepalive_loop(name: str, token: str):
    env = os.environ.copy()
    env["GH_TOKEN"] = token
    env["GITHUB_TOKEN"] = token
    try:
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL_SECONDS)
            try:
                proc = await asyncio.create_subprocess_exec(
                    "gh", "codespace", "ssh", "-c", name, "--", "true",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    env=env,
                )
                await asyncio.wait_for(proc.communicate(), timeout=60)
            except Exception:
                pass  # codespace may be mid-transition; just retry next cycle
    except asyncio.CancelledError:
        pass


@app.post("/api/codespaces/{name}/keepalive/start")
async def keepalive_start(name: str, request: Request):
    user = require_user(request)
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")
    key = _keepalive_key(user["id"], name)
    existing = keepalive_tasks.get(key)
    if existing and not existing.done():
        return {"ok": True, "already_running": True}
    keepalive_tasks[key] = asyncio.create_task(_keepalive_loop(name, token))
    return {"ok": True}


@app.post("/api/codespaces/{name}/keepalive/stop")
async def keepalive_stop(name: str, request: Request):
    user = require_user(request)
    key = _keepalive_key(user["id"], name)
    task = keepalive_tasks.pop(key, None)
    if task:
        task.cancel()
    return {"ok": True}


@app.get("/api/codespaces")
async def list_codespaces(request: Request):
    user = require_user(request)
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token. Add one first.")
    data = await gh_request(token, "/user/codespaces")
    codespaces = data.get("codespaces", [])
    for cs in codespaces:
        key = _keepalive_key(user["id"], cs["name"])
        task = keepalive_tasks.get(key)
        cs["keepalive_active"] = bool(task and not task.done())
    return codespaces


def _parse_owner_repo(owner: str, repo: str) -> tuple[str, str]:
    """Lets either field be a full GitHub URL (e.g. pasted into the repo
    box) instead of requiring exact owner/repo splitting by the user."""
    for candidate in (repo, owner):
        if candidate and ("github.com" in candidate or candidate.startswith("http")):
            m = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s#?]+)", candidate)
            if m:
                return m.group(1), re.sub(r"\.git$", "", m.group(2))
    return owner, repo


async def _find_existing_codespace(token: str, owner: str, repo: str):
    """Returns an already-existing codespace for this repo (on the token's
    account) if one exists, so we reuse it instead of creating a duplicate."""
    data = await gh_request(token, "/user/codespaces")
    full_name = f"{owner}/{repo}".lower()
    for cs in data.get("codespaces", []):
        if (cs.get("repository", {}).get("full_name") or "").lower() == full_name:
            return cs
    return None


async def _repo_accessible(token: str, owner: str, repo: str) -> bool:
    try:
        await gh_request(token, f"/repos/{owner}/{repo}")
        return True
    except HTTPException as e:
        if e.status_code == 404:
            return False
        raise


async def _ensure_own_repo(token: str, my_login: str, owner: str, repo: str) -> tuple[str, str]:
    """Returns (owner, repo) to actually create the codespace against.
    If the token's account can already see the repo directly (it owns it,
    or is a collaborator/org member), uses it as-is. Otherwise forks it
    into the token's own account (reusing an existing fork if present) and
    creates the codespace there instead."""
    if owner.lower() == my_login.lower():
        return owner, repo

    if await _repo_accessible(token, owner, repo):
        return owner, repo

    if await _repo_accessible(token, my_login, repo):
        existing_fork = await gh_request(token, f"/repos/{my_login}/{repo}")
        if existing_fork.get("fork"):
            return my_login, repo

    await gh_request(token, f"/repos/{owner}/{repo}/forks", method="POST")
    for _ in range(10):
        await asyncio.sleep(2)
        if await _repo_accessible(token, my_login, repo):
            break
    return my_login, repo


@app.post("/api/codespaces/create")
async def create_codespace(request: Request):
    user = require_user(request)
    body = await request.json()
    owner, repo = body.get("owner"), body.get("repo")
    ref = body.get("ref", "main")
    machine = body.get("machine", "basicLinux32gb")
    # 240 is GitHub's maximum idle_timeout_minutes (4 hours) for personal
    # accounts. Combined with the Keep Awake toggle below, the codespace
    # effectively never auto-stops while you have it toggled on.
    idle_timeout_minutes = body.get("idle_timeout_minutes", 240)
    if not owner or not repo:
        raise HTTPException(status_code=400, detail="owner and repo required")
    owner, repo = _parse_owner_repo(owner.strip(), repo.strip())

    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")

    me = await gh_request(token, "/user")
    my_login = me["login"]

    # Reuse an existing codespace for this repo instead of making a new one.
    existing = await _find_existing_codespace(token, owner, repo)
    if existing:
        if existing.get("state") not in ("Available", "Starting"):
            existing = await gh_request(
                token, f"/user/codespaces/{existing['name']}/start", method="POST"
            )
        return existing

    # Not owned/accessible directly? Fork it into the token's account first.
    target_owner, target_repo = await _ensure_own_repo(token, my_login, owner, repo)
    created = await gh_request(
        token,
        f"/repos/{target_owner}/{target_repo}/codespaces",
        method="POST",
        json_body={"ref": ref, "machine": machine, "idle_timeout_minutes": idle_timeout_minutes},
    )
    return created


@app.post("/api/codespaces/{name}/start")
async def start_codespace(name: str, request: Request):
    user = require_user(request)
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")
    return await gh_request(token, f"/user/codespaces/{name}/start", method="POST")


@app.post("/api/codespaces/{name}/stop")
async def stop_codespace(name: str, request: Request):
    user = require_user(request)
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")
    key = _keepalive_key(user["id"], name)
    task = keepalive_tasks.pop(key, None)
    if task:
        task.cancel()
    return await gh_request(token, f"/user/codespaces/{name}/stop", method="POST")


@app.delete("/api/codespaces/{name}")
async def delete_codespace(name: str, request: Request):
    user = require_user(request)
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")
    key = _keepalive_key(user["id"], name)
    task = keepalive_tasks.pop(key, None)
    if task:
        task.cancel()
    await gh_request(token, f"/user/codespaces/{name}", method="DELETE")
    return {"ok": True}


# One-shot command execution fallback (no interactive shell) via `gh` CLI.
@app.post("/api/codespaces/{name}/exec")
async def exec_command(name: str, request: Request):
    user = require_user(request)
    body = await request.json()
    command = body.get("command")
    if not command:
        raise HTTPException(status_code=400, detail="command required")
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")

    env = os.environ.copy()
    env["GH_TOKEN"] = token
    env["GITHUB_TOKEN"] = token

    proc = await asyncio.create_subprocess_exec(
        "gh", "codespace", "ssh", "-c", name, "--", command,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        proc.kill()
        return {"stdout": "", "stderr": "", "error": "timed out"}
    return {"stdout": stdout.decode(errors="replace"), "stderr": stderr.decode(errors="replace"), "error": None}


# ---------- Multiple named terminals per codespace ----------
# Each "terminal" the mini app opens is its own tmux session on the
# codespace (named cs-<id>), so two terminals run fully independently —
# e.g. cloudflared in Terminal 1 and bot.py in Terminal 2 — and neither is
# affected by connecting/disconnecting/killing the other.
TERMINAL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _sanitize_terminal_id(raw) -> str:
    raw = str(raw or "1").strip()
    return raw if TERMINAL_ID_RE.match(raw) else "1"


async def _ssh_exec(token: str, name: str, command: str, timeout: int = 30) -> str:
    env = os.environ.copy()
    env["GH_TOKEN"] = token
    env["GITHUB_TOKEN"] = token
    proc = await asyncio.create_subprocess_exec(
        "gh", "codespace", "ssh", "-c", name, "--", command,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return ""
    return stdout.decode(errors="replace")


@app.get("/api/codespaces/{name}/terminals")
async def list_terminals(name: str, request: Request):
    """Lists tmux sessions (terminals) already running on the codespace, so
    the mini app can restore tabs after being closed/reopened or opened on
    a different device — the sessions live on the codespace, not the app."""
    user = require_user(request)
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")
    output = await _ssh_exec(token, name, "tmux list-sessions -F '#S' 2>/dev/null || true")
    ids = [line.strip()[len("cs-"):] for line in output.splitlines() if line.strip().startswith("cs-")]
    return {"terminals": sorted(ids, key=lambda x: (len(x), x))}


@app.delete("/api/codespaces/{name}/terminals/{terminal_id}")
async def kill_terminal(name: str, terminal_id: str, request: Request):
    """Ends the tmux session for one terminal (and whatever is running in
    it) without touching any other terminal on the same codespace."""
    user = require_user(request)
    token = await get_active_token(user["id"])
    if not token:
        raise HTTPException(status_code=400, detail="No active GitHub token.")
    tid = _sanitize_terminal_id(terminal_id)
    await _ssh_exec(token, name, f"tmux kill-session -t cs-{tid} 2>/dev/null || true")
    return {"ok": True}


# ---------- Interactive terminal over WebSocket ----------
# Client connects to /ws/terminal, sends one auth+init frame:
#   {initData, codespaceName, terminalId, cols, rows}
# then {type:'input', data} / {type:'resize', cols, rows}
@app.websocket("/ws/terminal")
async def terminal_ws(websocket: WebSocket):
    await websocket.accept()
    proc: PtyProcessUnicode | None = None
    reader_task: asyncio.Task | None = None

    try:
        first_raw = await websocket.receive_text()
        msg = json.loads(first_raw)

        user = validate_init_data(msg.get("initData"))
        if not user:
            await websocket.send_text(json.dumps({"type": "error", "data": "Auth failed"}))
            await websocket.close()
            return

        token = await get_active_token(user["id"])
        if not token:
            await websocket.send_text(json.dumps({"type": "error", "data": "No active GitHub token"}))
            await websocket.close()
            return

        cs_name = msg.get("codespaceName")
        if not cs_name:
            await websocket.send_text(json.dumps({"type": "error", "data": "codespaceName required"}))
            await websocket.close()
            return

        env = os.environ.copy()
        env["GH_TOKEN"] = token
        env["GITHUB_TOKEN"] = token

        rows, cols = msg.get("rows", 30), msg.get("cols", 80)
        terminal_id = _sanitize_terminal_id(msg.get("terminalId"))
        tmux_session = f"cs-{terminal_id}"
        # Attach to (or create) a persistent tmux session on the codespace
        # instead of a bare shell. This is what keeps any running task alive
        # when the WebSocket drops (app backgrounded/minimised) — the pty
        # process we spawn locally dies with the disconnect, but tmux on the
        # remote side does not, so the task keeps running and the next
        # connection just re-attaches to it.
        # tmux may not be preinstalled on the codespace image, so install it
        # on first connect (no-op after that) instead of requiring a manual
        # step in every new codespace.
        # tmux uses the alt-screen buffer, which makes xterm.js turn mouse-
        # wheel scroll into raw Up/Down arrow-key bytes. With tmux's own
        # mouse mode off (the default), those bytes just get forwarded into
        # whatever is running instead of scrolling — hence the ^[[A/^[[B
        # spam. Enabling mouse mode makes tmux capture the wheel itself.
        # Written to ~/.tmux.conf once so it survives stop/start of the
        # codespace, not just this session.
        remote_cmd = (
            "command -v tmux >/dev/null 2>&1 || "
            "(sudo apt-get update -qq && sudo apt-get install -y -qq tmux); "
            "grep -q '^set -g mouse on' ~/.tmux.conf 2>/dev/null || "
            "echo 'set -g mouse on' >> ~/.tmux.conf; "
            "tmux set-option -g mouse on 2>/dev/null; "
            f"tmux new-session -A -s {tmux_session}"
        )
        proc = PtyProcessUnicode.spawn(
            [
                "gh", "codespace", "ssh", "-c", cs_name,
                "--", "-t", remote_cmd,
            ],
            env=env, dimensions=(rows, cols),
        )

        loop = asyncio.get_event_loop()

        async def reader():
            while proc.isalive():
                try:
                    data = await loop.run_in_executor(None, proc.read, 4096)
                except EOFError:
                    break
                if data:
                    await websocket.send_text(json.dumps({"type": "data", "data": data}))
            try:
                await websocket.send_text(json.dumps({"type": "exit", "data": proc.exitstatus}))
            except Exception:
                pass

        reader_task = asyncio.create_task(reader())

        while True:
            raw = await websocket.receive_text()
            parsed = json.loads(raw)
            if parsed.get("type") == "input":
                proc.write(parsed["data"])
            elif parsed.get("type") == "resize":
                proc.setwinsize(parsed.get("rows", 30), parsed.get("cols", 80))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "data": str(e)}))
        except Exception:
            pass
    finally:
        if reader_task:
            reader_task.cancel()
        if proc is not None and proc.isalive():
            proc.terminate(force=True)


# Static frontend (Mini App UI) — mounted last so it never shadows /api or /ws
app.mount("/", StaticFiles(directory="public", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT)