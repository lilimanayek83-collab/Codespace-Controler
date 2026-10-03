import os
import re
import subprocess
import threading
import time
import uvicorn
from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, MenuButtonWebApp
from telegram.ext import Application, CommandHandler

from server import app as fastapi_app  # the API + Mini App static server

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
PORT = int(os.getenv("PORT", "3000"))

# PUBLIC_URL_MODE=auto  -> bot.py launches `cloudflared tunnel` itself and
#                          reads the https://*.trycloudflare.com URL from it
# PUBLIC_URL_MODE=manual -> uses PUBLIC_URL from .env as-is (old behavior)
PUBLIC_URL_MODE = os.getenv("PUBLIC_URL_MODE", "auto").strip().lower()
MANUAL_PUBLIC_URL = (os.getenv("PUBLIC_URL") or "").strip()
CLOUDFLARED_PATH = os.getenv("CLOUDFLARED_PATH", "cloudflared").strip() or "cloudflared"
TUNNEL_TIMEOUT = int(os.getenv("TUNNEL_TIMEOUT", "30"))

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN missing in .env")

PUBLIC_URL = None          # resolved in main() before the bot starts
_tunnel_process = None     # cloudflared subprocess handle, for cleanup

_TUNNEL_URL_RE = re.compile(r"https://[a-zA-Z0-9\-]+\.trycloudflare\.com")


def start_cloudflare_tunnel(port: int, timeout: int = 30) -> str:
    """Launches `cloudflared tunnel --url http://localhost:<port>` and parses
    the generated https://*.trycloudflare.com URL out of its log output."""
    global _tunnel_process
    try:
        _tunnel_process = subprocess.Popen(
            [CLOUDFLARED_PATH, "tunnel", "--url", f"http://localhost:{port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        raise RuntimeError(
            f"cloudflared not found (tried to run '{CLOUDFLARED_PATH}'). "
            "Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) "
            "or set PUBLIC_URL_MODE=manual and PUBLIC_URL in .env instead."
        )

    found = {}

    def _reader():
        for line in _tunnel_process.stdout:
            print(f"[cloudflared] {line}", end="")
            if "url" not in found:
                match = _TUNNEL_URL_RE.search(line)
                if match:
                    found["url"] = match.group(0)

    threading.Thread(target=_reader, daemon=True).start()

    deadline = time.time() + timeout
    while time.time() < deadline:
        if "url" in found:
            return found["url"]
        if _tunnel_process.poll() is not None:
            raise RuntimeError(
                "cloudflared exited before printing a public URL - check the "
                "[cloudflared] log lines above for the reason."
            )
        time.sleep(0.2)

    raise RuntimeError(f"Timed out after {timeout}s waiting for cloudflared to print a public URL.")


def stop_cloudflare_tunnel():
    if _tunnel_process and _tunnel_process.poll() is None:
        _tunnel_process.terminate()
        try:
            _tunnel_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _tunnel_process.kill()


def resolve_public_url() -> str:
    if PUBLIC_URL_MODE == "manual":
        if not MANUAL_PUBLIC_URL:
            raise RuntimeError("PUBLIC_URL_MODE=manual but PUBLIC_URL is empty in .env")
        print(f"PUBLIC_URL_MODE=manual -> using {MANUAL_PUBLIC_URL}")
        return MANUAL_PUBLIC_URL

    print("PUBLIC_URL_MODE=auto -> starting cloudflared quick tunnel...")
    url = start_cloudflare_tunnel(PORT, TUNNEL_TIMEOUT)
    print(f"Cloudflare tunnel ready: {url}")
    return url


def run_server():
    """Runs the FastAPI backend (API + terminal websocket + static Mini App)
    in a background thread so a single `python bot.py` starts everything.
    loop="asyncio" avoids uvloop, which otherwise clobbers the main
    thread's event loop policy that python-telegram-bot needs."""
    uvicorn.run(fastapi_app, host="0.0.0.0", port=PORT, log_level="info", loop="asyncio")


async def start(update, context):
    keyboard = InlineKeyboardMarkup(
        [[InlineKeyboardButton("🚀 Open Control Panel", web_app=WebAppInfo(url=PUBLIC_URL))]]
    )
    await update.message.reply_text("Codespace Control Center", reply_markup=keyboard)


async def post_init(application: Application):
    # Persistent menu button next to the message box
    await application.bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(text="Codespaces", web_app=WebAppInfo(url=PUBLIC_URL))
    )


def main():
    global PUBLIC_URL

    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()
    print(f"Backend server starting on :{PORT}")
    time.sleep(1)  # give uvicorn a moment to bind before cloudflared proxies to it

    PUBLIC_URL = resolve_public_url()

    application = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    application.add_handler(CommandHandler("start", start))

    try:
        print("Bot polling started")
        application.run_polling()
    finally:
        stop_cloudflare_tunnel()


if __name__ == "__main__":
    main()