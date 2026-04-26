"""NiceGUI entry point for the openagenticskyzer desktop app."""
import os
from nicegui import ui

from openagentic_ai.app.state import state
from openagentic_ai.app.storage import load_global_config, load_folder_index
from openagentic_ai.app.components.sidebar import render_sidebar
from openagentic_ai.app.components.chat import render_chat
from openagentic_ai.app.components.context_bar import render_context_bar
from openagentic_ai.app.components.input_bar import render_input_bar
from openagentic_ai.app.components.settings import render_settings

CSS = """
body { background: #0d0d0d; font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; }
.nicegui-content { padding: 0 !important; }
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
"""


@ui.page("/")
def main_page():
    ui.add_head_html(f"<style>{CSS}</style>")

    cfg = load_global_config()
    state.permission_mode = cfg.get("permission_mode", "demander")

    # Auto-load last folder
    index = load_folder_index()
    if index and not state.active_folder:
        last = index[0].get("path", "")
        if last and os.path.isdir(last):
            state.active_folder = last

    # Top bar
    with ui.row().classes("w-full items-center px-3 py-1 gap-2").style(
        "height:38px;background:#161616;border-bottom:1px solid #2a2a2a;flex-shrink:0"
    ):
        ui.label("◈ openagent").classes("text-sm font-bold text-purple-500")
        if state.active_folder:
            ui.label(f"▸ {os.path.basename(state.active_folder)}").classes("text-xs text-gray-600")
        ui.element("div").classes("flex-1")
        ui.button("⚙️", on_click=render_settings).classes(
            "w-7 h-7 bg-gray-900 border border-gray-800 text-purple-400 text-xs rounded"
        )

    # Main layout
    with ui.row().classes("w-full flex-1").style("gap:0;overflow:hidden;height:calc(100vh - 38px)"):
        render_sidebar()
        with ui.column().classes("flex-1 h-full").style("gap:0;overflow:hidden"):
            render_chat()
            render_context_bar()
            render_input_bar()


def launch_app():
    try:
        import webview  # noqa: F401
        native = True
    except ImportError:
        print(
            "pywebview non installé. Lancement en mode navigateur.\n"
            "Pour la fenêtre native : pip install openagenticskyzer[app]"
        )
        native = False

    ui.run(
        native=native,
        window_size=(1300, 820),
        title="openagent",
        reload=False,
        dark=True,
        host="127.0.0.1",
        port=8765,
    )
