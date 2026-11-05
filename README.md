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
- **GitHub CLI (`gh`) on PATH** — required. The app uses it to wait for Docker
  inside a new codespace and for the SSH terminal. `gh` is a system program,
  **not** a Python package, so `pip install -r requirements.txt` will NOT
  install it. Without it, creating a codespace fails with
  `ENGINE ERROR: [Errno 2] No such file or directory: 'gh'`
  (see Troubleshooting below).

Install `gh` (Ubuntu/Debian) from the official GitHub repo. The default
`apt install gh` from Ubuntu is an old version (2.46), so use this instead:

```bash
sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install gh -y
```

Verify:

```bash
which gh        # should print /usr/bin/gh
gh --version
```

You do **not** need to run `gh auth login`. The app passes the active GitHub
token to `gh` through `GH_TOKEN` on every call.

## 2. Install

```bash
cd Codespace-Controler
cp .env.example .env
# edit .env: BOT_TOKEN, PUBLIC_URL (must be HTTPS), MONGO_URI
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
sudo apt update && sudo apt install cloudflared -y
```

`requirements.txt` (Python packages only):

```
fastapi
uvicorn[standard]
motor
pymongo
python-dotenv
python-telegram-bot
httpx
ptyprocess
```

### Optional: one-shot setup script

On a fresh server you can put everything (system packages, `gh`, venv, pip
install) into a `setup.sh` so nothing gets forgotten:

```bash
#!/bin/bash
set -e

sudo apt update
sudo apt install -y python3-venv python3-pip wget

sudo mkdir -p -m 755 /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update
sudo apt install -y gh

python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "Setup done. gh version: $(gh --version | head -1)"
```

```bash
chmod +x setup.sh
./setup.sh
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

### Run it non-stop with systemd (recommended on EC2)

Create `/etc/systemd/system/codespace.service`:

```ini
[Unit]
Description=Codespace Control Center
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/Codespace-Controler
EnvironmentFile=/home/ubuntu/Codespace-Controler/.env
Environment="PATH=/home/ubuntu/Codespace-Controler/venv/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/ubuntu/Codespace-Controler/venv/bin/python bot.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The `PATH` line matters: systemd services run with a minimal PATH, and it must
include `/usr/bin` so the service can find `gh`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable codespace
sudo systemctl start codespace
sudo systemctl status codespace
journalctl -u codespace -f      # live logs
```

After any code change or after installing/updating `gh`, restart it:

```bash
sudo systemctl restart codespace
```

## 4. Expose HTTPS

Telegram Mini Apps require HTTPS. Options:
- Deploy to any host with a domain + TLS (Railway, Render, Fly.io, a VPS with Caddy/nginx + Let's Encrypt)
- Use a Cloudflare tunnel (`cloudflared`) pointing at the app's port
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

## Troubleshooting

**`ENGINE ERROR: [Errno 2] No such file or directory: 'gh'`**
The GitHub CLI isn't installed, or isn't on the PATH of the process running
the app. The codespace itself is created fine (Provisioning → Available); the
failure happens at the next step ("Waiting for Docker daemon"), which calls
`gh`. Fix:

1. Check: `which gh`. If it prints nothing, install `gh` (section 1).
2. If `gh` is installed but the error persists, the service PATH is missing
   `/usr/bin`. Add the `Environment="PATH=..."` line shown in the systemd
   section, then `sudo systemctl daemon-reload && sudo systemctl restart codespace`.
3. Restart the service after installing so it picks up the new binary.

**`Error: dpkg was interrupted, you must manually run 'sudo dpkg --configure -a'`**
An earlier package install was interrupted. Run:

```bash
sudo dpkg --configure -a
sudo apt --fix-broken install -y    # only if it reports broken dependencies
```

If you get a "Could not get lock" error, another apt process (often
`unattended-upgrades`) is running. Wait a few minutes and retry.

**Auth or scope errors from `gh`**
Test a token directly: `GH_TOKEN=ghp_yourtoken gh codespace list`. If it
complains about scopes, regenerate the token with the `codespace` scope
(plus `repo`). The code must pass the token via `GH_TOKEN` in the subprocess
environment, e.g. `env = {**os.environ, "GH_TOKEN": token}`.

**Optional startup check** (fails fast with a clear message instead of in the
middle of creating a codespace):

```python
import shutil

if not shutil.which("gh"):
    raise RuntimeError("GitHub CLI 'gh' is not installed. Run setup.sh or see README section 1.")
```

## Data model (MongoDB, db: `codespace_miniapp`)

- `tokens`: `{ _id, telegramId, label, token, createdAt }` — token stored as-is
- `users`: `{ telegramId, activeTokenId }`

## Security notes

- Every API call and the terminal WebSocket validates Telegram's `initData`
  HMAC signature against `BOT_TOKEN`, so only real Telegram Mini App
  sessions for your bot can reach the API.
- Because tokens are stored unencrypted, restrict MongoDB network access
  (IP allowlist) and rotate tokens if the DB is ever exposed.
