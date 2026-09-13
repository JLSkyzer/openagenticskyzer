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
from openagenticskyzer.app.components.chat import render_chat, chat_messages, active_branch_label
from openagenticskyzer.app.components.context_bar import render_context_bar
from openagenticskyzer.app.components.input_bar import render_input_bar
from openagenticskyzer.app.components.artifact_panel import artifact_panel
from openagenticskyzer.app.components.settings import render_settings
from openagenticskyzer.app.components.command_palette import render_command_palette
from openagenticskyzer.app.components.downloads import make_downloads_top_btn
from openagenticskyzer.app.exporter import export_markdown, export_html, export_json
from openagenticskyzer.app.components.onboarding import onboarding_wizard, should_show_onboarding
from openagenticskyzer.app.theme import _apply_theme

# ── Vendor local (highlight.js + mermaid) ─────────────────────────────────────

_VENDOR_DIR = pathlib.Path.home() / ".openagenticskyzer" / "vendor"
_VENDOR_FILES = {
    "atom-one-dark.min.css": "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css",
    "highlight.min.js":      "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js",
    "mermaid.min.js":        "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
}


def _ensure_vendor() -> None:
    """Télécharge highlight.js et mermaid dans ~/.openagenticskyzer/vendor/ si absents."""
    import urllib.request
    _VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    for fname, url in _VENDOR_FILES.items():
        dest = _VENDOR_DIR / fname
        if not dest.exists():
            try:
                urllib.request.urlretrieve(url, dest)
            except Exception:
                pass


# ── Endpoint upload paste/drag-drop ──────────────────────────────────────────

from nicegui import app as _nga
from fastapi import UploadFile, File


@_nga.post("/api/attach-file")
async def _attach_file_api(file: UploadFile = File(...)):
    from openagenticskyzer.app.file_processor import process_upload
    raw = await file.read()
    result = process_upload(file.filename or "pasted.png", raw)
    if result:
        state.attached_files.append(result)
        return {"ok": True, "name": result.name}
    return {"ok": False, "error": "Format non supporté"}


_SCROLL_JS = """
<script>
(function(){
  window._oaAutoScroll = true;
  window._oaRefreshing = false;
  var _scrollTimer;

  function updateBtn(atBottom) {
    var b = document.getElementById('oa-scroll-btn');
    if (b) b.style.display = atBottom ? 'none' : 'flex';
  }

  function setup(){
    var s = document.querySelector('.oa-chat-scroll .q-scrollarea__container');
    if (!s) { setTimeout(setup, 400); return; }

    // Scroll initial en bas
    s.scrollTop = s.scrollHeight;
    updateBtn(true);

    // Suivi du scroll utilisateur
    // (ignore si DOM en cours de rebuild : scrollHeight très petit)
    s.addEventListener('scroll', function(){
      if (window._oaRefreshing || s.scrollHeight < 200) return;
      var atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 80;
      updateBtn(atBottom);
      window._oaAutoScroll = atBottom;
    });

    // Auto-scroll sur nouveau contenu — observe le conteneur directement
    var observer = new MutationObserver(function(){
      if (!window._oaAutoScroll || window._oaRefreshing) return;
      clearTimeout(_scrollTimer);
      _scrollTimer = setTimeout(function(){
        if (window._oaAutoScroll && !window._oaRefreshing) {
          s.scrollTop = s.scrollHeight;
        }
      }, 80);
    });
    observer.observe(s, { childList: true, subtree: true });
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
.nicegui-markdown pre {
    background: #1e1e2e !important;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 12px 16px;
    overflow-x: auto;
}
.nicegui-markdown code {
    font-family: 'JetBrains Mono', 'Fira Code', monospace !important;
    font-size: 0.8rem;
}
.nicegui-markdown pre code { background: none !important; padding: 0; }
.hljs { background: transparent !important; }
"""

_URL = "http://127.0.0.1:8765"
_TOP = 38
_LOCK_PORT = 19876  # port dédié au verrou single-instance
_PROFILE_DIR = pathlib.Path.home() / ".openagenticskyzer" / "browser_profile"
_browser_proc = None  # processus navigateur en cours


# ── Export de conversation ────────────────────────────────────────────────────

def _do_export(fmt: str) -> None:
    """Exporte la conversation courante dans le dossier actif et ouvre le fichier."""
    fn = {"md": export_markdown, "html": export_html, "json": export_json}[fmt]
    try:
        path = fn()
    except Exception as exc:
        ui.notify(f"Échec de l'export : {exc}", type="negative")
        return
    if os.name == "nt":
        os.startfile(path)
    ui.notify(f"Exporté : {path.name}", type="positive")


# ── Page NiceGUI ──────────────────────────────────────────────────────────────

@ui.page("/")
def main_page(client: Client):
    ui.add_head_html(f"<style>{CSS}</style>")
    def _v(fname: str, cdn: str) -> str:
        return f"/vendor/{fname}" if (_VENDOR_DIR / fname).exists() else cdn

    ui.add_head_html(f"""
<link rel="stylesheet" href="{_v('atom-one-dark.min.css', 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css')}">
<script src="{_v('highlight.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')}"></script>
<script src="{_v('mermaid.min.js', 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js')}"></script>
<script>
  mermaid.initialize({{startOnLoad: false, theme: 'dark'}});
  function applyHighlight() {{
    document.querySelectorAll('pre code:not(.hljs)').forEach(function(el){{ hljs.highlightElement(el); }});
  }}
</script>
""")
    ui.add_head_html("""
<script>
(function(){
  function _oaAttachFile(file) {
    var fd = new FormData();
    fd.append('file', file, file.name || 'pasted.png');
    fetch('/api/attach-file', {method:'POST', body:fd})
      .then(function(r){return r.json();})
      .catch(function(){});
  }

  // Coller (Ctrl+V) — images et fichiers
  document.addEventListener('paste', function(e) {
    var items = e.clipboardData ? e.clipboardData.items : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); _oaAttachFile(f); }
      }
    }
  });

  // Drag-and-drop sur la zone de saisie (.oa-input-col)
  function _col() { return document.querySelector('.oa-input-col'); }
  document.addEventListener('dragover', function(e) {
    var col = _col();
    if (col && (col === e.target || col.contains(e.target))) {
      e.preventDefault();
      col.style.outline = '2px dashed #7c3aed';
      col.style.background = '#1a1020';
    }
  });
  document.addEventListener('dragleave', function(e) {
    var col = _col();
    if (col && !col.contains(e.relatedTarget)) {
      col.style.outline = '';
      col.style.background = '';
    }
  });
  document.addEventListener('drop', function(e) {
    var col = _col();
    if (col) { col.style.outline = ''; col.style.background = ''; }
    if (!col || !(col === e.target || col.contains(e.target))) return;
    e.preventDefault();
    var files = e.dataTransfer ? e.dataTransfer.files : [];
    for (var i = 0; i < files.length; i++) { _oaAttachFile(files[i]); }
  });
})();
</script>
""")
    ui.add_head_html(_SCROLL_JS)

    cfg = load_global_config()
    _apply_theme()
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
                # Idem pour les branches : au démarrage à froid, aucune branche ne peut
                # encore exister, mais on reset par cohérence avec les autres call-sites
                # qui remplacent state.messages (voir tasks/lessons.md).
                from openagenticskyzer.app.components.chat import reset_branches
                reset_branches()
                state.context_tokens, state.context_pct = compute_context_pct(state.messages, state.current_provider)
                # Charge le .env du dossier (clés API + config spécifiques au projet)
                try:
                    from dotenv import load_dotenv as _ld
                    _ld(os.path.join(last, ".env"), override=True)
                except Exception:
                    pass

    with ui.element("div").style(
        "width:100%;height:100vh;"
        "display:flex;flex-direction:column;overflow:hidden;background:var(--bg,#0d0d0d)"
    ):
        # Top bar
        with ui.element("div").style(
            f"width:100%;height:{_TOP}px;min-height:{_TOP}px;flex-shrink:0;"
            "background:var(--surface,#161616);border-bottom:1px solid var(--border,#2a2a2a);"
            "display:flex;align-items:center;padding:0 12px;gap:8px"
        ):
            ui.label("◈ openagent").classes("text-sm font-bold text-purple-500")
            if state.active_folder:
                ui.label(f"▸ {os.path.basename(state.active_folder)}").classes("text-xs text-gray-600")
            ui.element("div").style("flex:1")
            # Bouton statique (non-refreshable) — évite la destruction du dialog au refresh
            _dl_lbl = make_downloads_top_btn()
            with ui.button().classes(
                "h-7 px-2 bg-gray-900 border border-gray-800 text-gray-500 text-xs rounded"
            ):
                ui.label("⬇").classes("text-xs leading-none")
                with ui.menu():
                    ui.label(f"Depuis : {active_branch_label()}").classes(
                        "text-xs text-gray-500 px-2 py-1"
                    )
                    ui.menu_item("Markdown (.md)", lambda: _do_export("md"))
                    ui.menu_item("HTML (.html)", lambda: _do_export("html"))
                    ui.menu_item("JSON (.json)", lambda: _do_export("json"))
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
            artifact_panel()

        render_command_palette()

    if should_show_onboarding():
        onboarding_wizard()

        def _scroll_chat_to_bottom():
            try:
                scroll.scroll_to(percent=100)
            except Exception:
                pass
            ui.run_javascript("""
            const root = document.querySelector('.oa-chat-scroll');
            const el = root?.querySelector('.q-scrollarea__container') || root?.querySelector('.q-scrollarea') || document.querySelector('.q-scrollarea__container') || document.querySelector('.q-scrollarea');
            if (el) {
                el.scrollTop = el.scrollHeight;
                setTimeout(() => { el.scrollTop = el.scrollHeight; }, 60);
            }
            """)

        ui.button("↓", on_click=_scroll_chat_to_bottom).classes(
            "fixed w-10 h-10 rounded-full bg-purple-600 hover:bg-purple-700 text-white font-bold"
        ).style(
            "z-index:30000;right:120px;bottom:94px;padding:0;box-shadow:0 8px 24px rgba(0,0,0,0.35);display:none"
        ).props("id=oa-scroll-btn")


    # Timer en dehors de tout bloc with — pas de parent slot, ne peut pas être supprimé
    # Scroll initial en bas (backup Python si JS pas encore prêt)
    def _initial_scroll():
        try:
            scroll.scroll_to(percent=100)
        except Exception:
            pass
    ui.timer(0.8, _initial_scroll, once=True)

    _SAVE_SCROLL_JS = (
        "window._oaRefreshing=true;"
        "var _sc=document.querySelector('.oa-chat-scroll .q-scrollarea__container');"
        "window._oaSavedScroll=_sc?_sc.scrollTop:0;"
    )
    _RESTORE_SCROLL_JS = (
        "window._oaRefreshing=false;"
        "var _sc=document.querySelector('.oa-chat-scroll .q-scrollarea__container');"
        "if(_sc){setTimeout(function(){"
        "  if(window._oaAutoScroll){_sc.scrollTop=_sc.scrollHeight;}"
        "  else{_sc.scrollTop=window._oaSavedScroll||0;}"
        "},60);}"
    )

    def _tick():
        try:
            if state.agent_running:
                ui.run_javascript(_SAVE_SCROLL_JS)
                chat_messages.refresh()
                ui.run_javascript(_RESTORE_SCROLL_JS)
            if state.downloads:
                from openagenticskyzer.app.components.sidebar import downloads_panel
                downloads_panel.refresh()
                active = sum(1 for d in state.downloads if not d.done and not d.error)
                _dl_lbl.set_text(f"📥 {active}" if active else "📥")
        except Exception:
            pass

    _t = ui.timer(0.5, _tick)
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
    _ensure_vendor()
    _nga.add_static_files("/vendor", str(_VENDOR_DIR))

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
        favicon="◈"
    )


def main_app() -> None:
    """Point d'entrée principal pour l'app GUI."""
    launch_app()
