"""NiceGUI entry point for the openagenticskyzer desktop app."""
import os
import pathlib
import socket
import sys
import threading
from nicegui import ui, Client

from openagenticskyzer.app.state import state
from openagenticskyzer.app.storage import load_global_config, load_folder_index
from openagenticskyzer.app.components.sidebar import render_sidebar
from openagenticskyzer.app.components.chat import render_chat, chat_messages
from openagenticskyzer.app.components.context_bar import render_context_bar
from openagenticskyzer.app.components.input_bar import render_input_bar
from openagenticskyzer.app.components.settings import render_settings
from openagenticskyzer.app.components.downloads import make_downloads_top_btn

_SCROLL_JS = """
<script>
(function(){
  window._oaAutoScroll = true;
  var _scrollTimer;

  function setup(){
    var s = document.querySelector('.q-scrollarea__container');
    var btn = document.getElementById('oa-scroll-btn');
    if (!s || !btn) { setTimeout(setup, 400); return; }

    // Scroll initial en bas
    s.scrollTop = s.scrollHeight;

    // Bouton ↓ : revenir en bas + reprendre l'auto-scroll
    btn.onclick = function(){
      window._oaAutoScroll = true;
      s.scrollTop = s.scrollHeight;
      btn.style.display = 'none';
    };

    // Suivi du scroll utilisateur
    s.addEventListener('scroll', function(){
      var atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 80;
      btn.style.display = atBottom ? 'none' : 'flex';
      window._oaAutoScroll = atBottom;
    });

    // Auto-scroll quand le contenu change (nouveau message IA)
    // — seulement si l'utilisateur est déjà en bas
    var target = s.firstElementChild || s;
    var observer = new MutationObserver(function(){
      if (!window._oaAutoScroll) return;
      clearTimeout(_scrollTimer);
      _scrollTimer = setTimeout(function(){ s.scrollTop = s.scrollHeight; }, 40);
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  document.addEventListener('DOMContentLoaded', function(){ setTimeout(setup, 600); });
})();
</script>
"""

CSS = """
html, body {
    height: 100%;
    width: 100%;
    margin: 0;
    overflow: hidden;
    background: #0d0d0d;
    font-family: 'Segoe UI', system-ui, sans-serif;
}
.nicegui-content,
.q-page,
.q-page-container {
    padding: 0 !important;
    margin: 0 !important;
    width: 100% !important;
    max-width: none !important;
    height: 100% !important;
    overflow: hidden !important;
    min-height: unset !important;
}
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
.typing-dots { display:flex;align-items:center;gap:4px;padding:10px 4px }
.typing-dots span {
    display:inline-block;width:7px;height:7px;
    background:#7c3aed;border-radius:50%;
    animation:tdot 1.2s infinite both;
}
.typing-dots span:nth-child(2){animation-delay:.2s}
.typing-dots span:nth-child(3){animation-delay:.4s}
@keyframes tdot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1.15)}}
"""

_URL = "http://127.0.0.1:8765"
_TOP = 38
_LOCK_PORT = 19876  # port dédié au verrou single-instance
_PROFILE_DIR = pathlib.Path.home() / ".openagenticskyzer" / "browser_profile"
_browser_proc = None  # processus navigateur en cours


# ── Page NiceGUI ──────────────────────────────────────────────────────────────

@ui.page("/")
def main_page(client: Client):
    ui.add_head_html(f"<style>{CSS}</style>")
    ui.add_head_html(_SCROLL_JS)

    cfg = load_global_config()
    state.permission_mode = cfg.get("permission_mode", "demander")

    if cfg.get("restore_last_folder", True):
        index = load_folder_index()
        if index and not state.active_folder:
            last = index[0].get("path", "")
            if last and os.path.isdir(last):
                state.active_folder = last
                # Restaure le modèle et l'historique chat associés à ce dossier
                from openagenticskyzer.app.storage import load_folder_config, load_chat_history, compute_context_pct
                from openagenticskyzer.app.state import ChatMessage
                folder_cfg = load_folder_config(last)
                state.current_model = folder_cfg.get("current_model") or None
                state.current_provider = folder_cfg.get("current_provider") or None
                history_data = load_chat_history(last)
                state.messages = [ChatMessage(**entry) for entry in history_data]
                state.context_tokens, state.context_pct = compute_context_pct(state.messages, state.current_provider)
                # Charge le .env du dossier (clés API + config spécifiques au projet)
                try:
                    from dotenv import load_dotenv as _ld
                    _ld(os.path.join(last, ".env"), override=True)
                except Exception:
                    pass

    with ui.element("div").style(
        "width:100%;height:100vh;"
        "display:flex;flex-direction:column;overflow:hidden;background:#0d0d0d"
    ):
        # Top bar
        with ui.element("div").style(
            f"width:100%;height:{_TOP}px;min-height:{_TOP}px;flex-shrink:0;"
            "background:#161616;border-bottom:1px solid #2a2a2a;"
            "display:flex;align-items:center;padding:0 12px;gap:8px"
        ):
            ui.label("◈ openagent").classes("text-sm font-bold text-purple-500")
            if state.active_folder:
                ui.label(f"▸ {os.path.basename(state.active_folder)}").classes("text-xs text-gray-600")
            ui.element("div").style("flex:1")
            # Bouton statique (non-refreshable) — évite la destruction du dialog au refresh
            _dl_lbl = make_downloads_top_btn()
            ui.button("⚙️", on_click=render_settings).classes(
                "w-7 h-7 bg-gray-900 border border-gray-800 text-purple-400 text-xs rounded"
            )

        # Zone principale
        with ui.element("div").style(
            f"width:100%;height:calc(100vh - {_TOP}px);"
            "display:flex;flex-direction:row;overflow:hidden"
        ):
            render_sidebar()
            with ui.element("div").style(
                "flex:1;min-width:0;height:100%;"
                "display:flex;flex-direction:column;overflow:hidden"
            ):
                scroll = render_chat()
                render_context_bar()
                render_input_bar()


    # Timer en dehors de tout bloc with — pas de parent slot, ne peut pas être supprimé
    # Scroll initial en bas (backup Python si JS pas encore prêt)
    def _initial_scroll():
        try:
            scroll.scroll_to(percent=100)
        except Exception:
            pass
    ui.timer(0.8, _initial_scroll, once=True)

    def _tick():
        try:
            if state.agent_running:
                chat_messages.refresh()
                # scroll géré côté JS via MutationObserver (_oaAutoScroll)
            if state.downloads:
                from openagenticskyzer.app.components.sidebar import downloads_panel
                downloads_panel.refresh()
                active = sum(1 for d in state.downloads if not d.done and not d.error)
                _dl_lbl.set_text(f"📥 {active}" if active else "📥")
        except Exception:
            pass

    _t = ui.timer(0.4, _tick)
    client.on_disconnect(lambda: _t.cancel())


# ── Single instance ───────────────────────────────────────────────────────────

def _acquire_lock() -> socket.socket | None:
    """Tente de lier un socket local pour garantir une seule instance."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    try:
        sock.bind(("127.0.0.1", _LOCK_PORT))
        sock.listen(1)
        return sock
    except OSError:
        sock.close()
        return None


# ── Tray icon ─────────────────────────────────────────────────────────────────

def _make_tray_image():
    """Génère une icône violet/blanc 64×64 avec PIL."""
    from PIL import Image, ImageDraw
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Cercle fond violet
    d.ellipse([2, 2, size - 2, size - 2], fill=(88, 28, 135))
    # Losange blanc (◈ simplifié)
    cx, cy = size // 2, size // 2
    outer = 20
    inner = 10
    d.polygon([(cx, cy - outer), (cx + outer, cy), (cx, cy + outer), (cx - outer, cy)],
              fill=(255, 255, 255))
    d.polygon([(cx, cy - inner), (cx + inner, cy), (cx, cy + inner), (cx - inner, cy)],
              fill=(88, 28, 135))
    return img


def _run_tray(lock_sock: socket.socket) -> None:
    """Lance l'icône dans la barre système (bloque le thread principal)."""
    import pystray

    def on_open(icon, item):
        threading.Thread(target=_open_app_window, daemon=True).start()

    def on_quit(icon, item):
        # Ferme la fenêtre navigateur et tous ses processus enfants
        if _browser_proc is not None:
            try:
                import subprocess as _sp
                _sp.Popen(
                    ["taskkill", "/F", "/T", "/PID", str(_browser_proc.pid)],
                    creationflags=0x08000000,  # CREATE_NO_WINDOW
                )
            except Exception:
                pass
        os._exit(0)

    tray = pystray.Icon(
        name="openagent",
        icon=_make_tray_image(),
        title="◈ openagent",
        menu=pystray.Menu(
            pystray.MenuItem("Ouvrir openagent", on_open, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quitter", on_quit),
        ),
    )
    tray.run()


# ── Fenêtre navigateur ────────────────────────────────────────────────────────

def _open_app_window() -> None:
    """Ouvre Edge ou Chrome en mode --app avec profil dédié."""
    global _browser_proc
    import subprocess
    import shutil

    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    exe = next((p for p in candidates if shutil.os.path.exists(p)), None)

    if exe:
        _PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        _browser_proc = subprocess.Popen([
            exe,
            f"--app={_URL}",
            f"--user-data-dir={_PROFILE_DIR}",
            "--window-size=1300,820",
            "--window-position=100,50",
        ])
    else:
        import webbrowser
        webbrowser.open(_URL)


def _poll_and_open() -> None:
    """Attend que le serveur réponde (HTTP) avant d'ouvrir la fenêtre — évite 'connection lost'."""
    import time
    import urllib.request

    for _ in range(40):  # max 20 s
        try:
            urllib.request.urlopen(f"http://127.0.0.1:8765", timeout=0.5)
            break
        except Exception:
            time.sleep(0.5)

    _open_app_window()


# ── Point d'entrée ────────────────────────────────────────────────────────────

def _init_data_dir() -> None:
    """Lit data_dir dans la config et initialise persistence + cleanup."""
    from openagenticskyzer.app.storage import load_global_config, cleanup_old_sessions

    # Charge le .env global dès le démarrage (clés API cloud disponibles sans ouvrir la popup)
    try:
        from dotenv import load_dotenv as _ld
        _ld(str(pathlib.Path.home() / ".env"), override=False)
    except Exception:
        pass

    cfg = load_global_config()

    data_dir = cfg.get("data_dir", "").strip()
    if data_dir and pathlib.Path(data_dir).is_dir():
        try:
            from openagenticskyzer.context.persistence import set_data_dir
            set_data_dir(data_dir)
        except Exception:
            pass

    retention = int(cfg.get("session_retention_days", 30))
    if retention > 0:
        try:
            cleanup_old_sessions(retention)
        except Exception:
            pass


def launch_app() -> None:
    # 0. Initialiser data_dir + nettoyage des sessions expirées
    _init_data_dir()

    # 1. Verrou single-instance
    lock = _acquire_lock()
    if lock is None:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                0,
                "openagent est déjà en cours d'exécution.\n\nVérifiez la barre des tâches système.",
                "openagent",
                0x40,  # MB_ICONINFORMATION
            )
        except Exception:
            print("openagent est déjà en cours d'exécution.", file=sys.stderr)
        sys.exit(0)

    # 2. Tray icon dans un thread daemon
    #    (pystray Win32 fonctionne hors thread principal)
    threading.Thread(target=_run_tray, args=(lock,), daemon=True).start()

    # 3. Fenêtre navigateur : poll HTTP jusqu'à ce que le serveur réponde
    threading.Thread(target=_poll_and_open, daemon=True).start()

    # 4. NiceGUI dans le thread principal (asyncio Windows stable ici)
    _run_nicegui()

    # Reach ici uniquement si ui.run() sort (Ctrl+C CLI)
    os._exit(0)


def _patch_sio_timeout() -> None:
    """Augmente les timeouts Socket.IO/Engine.IO pour les LLM locaux lents."""
    try:
        from nicegui import core
        _eio = getattr(core.sio, "eio", None)
        if _eio is not None:
            for _attr in ("ping_timeout", "heartbeat_timeout"):
                try:
                    setattr(_eio, _attr, 300)
                except Exception:
                    pass
            for _attr in ("ping_interval", "heartbeat_interval"):
                try:
                    setattr(_eio, _attr, 60)
                except Exception:
                    pass
    except Exception:
        pass


def _run_nicegui() -> None:
    # Patch avant ui.run() (cas où core.sio est déjà initialisé)
    _patch_sio_timeout()

    # Patch post-démarrage via le hook FastAPI startup — garantit que le patch
    # s'applique APRÈS que uvicorn/socketio aient complètement initialisé leurs objets.
    from nicegui import app as _nga
    _nga.on_startup(_patch_sio_timeout)

    ui.run(
        native=False,
        show=False,
        host="127.0.0.1",
        port=8765,
        title="openagent",
        reload=False,
        dark=True,
        favicon="◈",
    )
