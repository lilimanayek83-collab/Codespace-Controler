# Codespace Control Center — Telegram Mini App (Python)

Same app as before, rebuilt on Python: **FastAPI** + **Motor** (async MongoDB)
for the backend, **python-telegram-bot** for the bot. The frontend
(`public/`) is unchanged — it just talks to the same REST/WebSocket routes.

Tokens are stored **exactly as given, in plain text**, in MongoDB — no
encoding/encryption — per your request. Lock down DB network access, since
anyone with DB access can read live GitHub tokens.

## 1. Requirements on the server

- Python 3.10+
- MongoDB (Atlas URI or self-hosted)
- GitHub CLI (`gh`) on PATH — used for the SSH terminal
  ```bash
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list
  sudo apt update && sudo apt install gh
  ```

## 2. Install

```bash
cd codespace-miniapp-py
cp .env.example .env
# edit .env: BOT_TOKEN, PUBLIC_URL (must be HTTPS), MONGO_URI
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 3. Run

One command starts everything — `bot.py` launches the FastAPI backend
(API + terminal websocket + static Mini App) in a background thread, then
starts the bot's polling loop in the main thread:

```bash
python bot.py
```

If you'd rather run the backend as its own process (e.g. behind a real
process manager, with the bot separate), you still can:
`python server.py` (or `uvicorn server:app --host 0.0.0.0 --port 3000`) plus
`python bot.py` in a second process — just don't run both at once on the
same `PORT`, since `bot.py` already starts the server itself.

## 4. Expose HTTPS

Telegram Mini Apps require HTTPS. Options:
- Deploy to any host with a domain + TLS (Railway, Render, Fly.io, a VPS with Caddy/nginx + Let's Encrypt)
- Or, if running inside a GitHub Codespace, use its forwarded HTTPS URL as `PUBLIC_URL`

Set that URL as `PUBLIC_URL` in `.env` before starting `bot.py`.

## 5. Register with BotFather (optional)

`/mybots` → your bot → **Bot Settings** → **Menu Button** → set `PUBLIC_URL`.
`bot.py` also sets this programmatically on startup, so it's optional.

## 6. Using it

Same as before: **Accounts** tab to save/switch GitHub tokens (needs
`codespace` + `repo` scopes), **Codespaces** tab to list/start/stop/delete
and create new ones, **Terminal** tab for a live shell into any codespace.

## Notes on the terminal

- The backend spawns `gh codespace ssh -c <name>` via `ptyprocess`, with
  `GH_TOKEN` set to the active token for that request — `gh` on your server
  never needs its own persistent login.
- If `ptyprocess` has issues on your host (e.g. Windows), use the REST
  fallback: `POST /api/codespaces/:name/exec {"command": "..."}` runs one
  command non-interactively and returns stdout/stderr.

## Data model (MongoDB, db: `codespace_miniapp`)

- `tokens`: `{ _id, telegramId, label, token, createdAt }` — token stored as-is
- `users`: `{ telegramId, activeTokenId }`

## Security notes

- Every API call and the terminal WebSocket validates Telegram's `initData`
  HMAC signature against `BOT_TOKEN`, so only real Telegram Mini App
  sessions for your bot can reach the API.
- Because tokens are stored unencrypted, restrict MongoDB network access
  (IP allowlist) and rotate tokens if the DB is ever exposed.

## Rotation (multi-account slots)

Rotate tab: add slots (GitHub account + `owner/repo` + machine + on-switch preset + commands).
Order = rotation order; after the last slot it wraps to the first.

1. Pointer selects the slot/account.
2. Existing codespace for that repo? preset **Stop** -> start it; preset **Delete** -> delete + recreate. None -> create.
3. Commands run one by one in `/workspaces/<repo>` (prefix `bg:` = detached in tmux).
4. Switch signal (button, `POST /api/rotation/signal {"key": "..."}`, or auto-timer): preset Stop -> stop, Delete -> delete.
5. Pointer moves to next slot, repeat. "Point here" moves the pointer manually.

State is stored in MongoDB collection `rotation`.
