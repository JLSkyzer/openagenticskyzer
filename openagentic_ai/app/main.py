"""NiceGUI entry point for the openagenticskyzer desktop app."""
from nicegui import ui

from openagentic_ai.app.state import state
from openagentic_ai.app.storage import load_global_config
from openagentic_ai.app.components.sidebar import render_sidebar
from openagentic_ai.app.components.chat import render_chat
from openagentic_ai.app.components.context_bar import render_context_bar
from openagentic_ai.app.components.input_bar import render_input_bar


CSS = """
body { background: #0d0d0d; font-family: 'Segoe UI', system-ui, sans-serif; }
.nicegui-content { padding: 0 !important; }
"""


@ui.page("/")
def main_page():
    ui.add_head_html(f"<style>{CSS}</style>")

    cfg = load_global_config()
    state.permission_mode = cfg.get("permission_mode", "demander")

    with ui.row().classes("w-full h-screen").style("gap:0"):
        render_sidebar()
        with ui.column().classes("flex-1 h-full").style("gap:0;overflow:hidden"):
            render_chat()
            render_context_bar()
            render_input_bar()


def launch_app():
    """Called from agent.py --app flag."""
    try:
        import webview  # noqa: F401 — validates pywebview is installed
    except ImportError:
        print(
            "pywebview not installed. Run: pip install openagenticskyzer[app]\n"
            "Falling back to browser mode."
        )
        ui.run(host="127.0.0.1", port=8765, title="openagent", show=True, reload=False)
        return

    ui.run(
        native=True,
        window_size=(1300, 820),
        title="openagent",
        reload=False,
        dark=True,
    )
