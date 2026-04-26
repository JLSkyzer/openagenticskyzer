"""Context usage bar shown between chat and input."""
from nicegui import ui
from openagentic_ai.app.state import state
from openagentic_ai.app.storage import load_global_config


def trigger_compact():
    """Manually compact the conversation (stub — wired in main.py)."""
    from openagentic_ai.app.components.chat import chat_messages
    if len(state.messages) > 4:
        state.messages = state.messages[-4:]
    state.context_pct = max(0.0, state.context_pct - 50.0)
    state.context_tokens = max(0, state.context_tokens - state.context_tokens // 2)
    chat_messages.refresh()
    context_bar.refresh()
    ui.notify("Contexte compressé.", type="positive")


@ui.refreshable
def context_bar():
    cfg = load_global_config()
    if not cfg.get("show_context_bar", True):
        return

    pct = min(100.0, state.context_pct)
    tokens = state.context_tokens
    color = "bg-purple-600" if pct < 70 else ("bg-yellow-500" if pct < 90 else "bg-red-500")

    with ui.row().classes("w-full items-center gap-2 px-6 py-1").style(
        "background:#0f0f0f;border-top:1px solid #1e1e1e;min-height:28px"
    ):
        ui.label("🧠 Contexte").classes("text-xs text-gray-600")
        with ui.element("div").classes("flex-1 h-1 rounded bg-gray-800").style("max-width:120px"):
            ui.element("div").classes(f"h-1 rounded {color}").style(f"width:{pct:.0f}%")
        ui.label(f"{pct:.0f}% · ~{tokens:,} tokens").classes("text-xs text-gray-600")

        if pct >= cfg.get("compact_threshold", 70):
            ui.button("⚡ Auto-compact", on_click=trigger_compact).classes(
                "text-xs text-purple-400 border border-purple-900 bg-transparent px-2 py-0.5 ml-auto"
            )


def render_context_bar():
    context_bar()
