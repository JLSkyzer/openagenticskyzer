"""Chat message list with tool previews and permission banner."""
from nicegui import ui

from openagentic_ai.app.state import state, ChatMessage

_TOOL_TAG_STYLES = {
    "write":  ("bg-green-900 text-green-400",  "WRITE"),
    "run":    ("bg-blue-900  text-blue-400",   "RUN"),
    "read":   ("bg-orange-900 text-orange-400", "READ"),
    "search": ("bg-purple-900 text-purple-400", "SEARCH"),
}


def _render_message(msg: ChatMessage):
    if msg.role == "user":
        with ui.row().classes("justify-end w-full"):
            ui.label(msg.content).classes(
                "max-w-xl px-3 py-2 rounded-lg text-xs text-purple-200 bg-indigo-950"
            )
        return

    if msg.role == "tool":
        tag_style, tag_text = _TOOL_TAG_STYLES.get(msg.tool_tag or "read", ("bg-gray-800 text-gray-400", "TOOL"))
        with ui.element("div").classes("mx-8 my-1 rounded-lg overflow-hidden border border-gray-800").style("background:#0f1117"):
            with ui.row().classes("px-2 py-1 items-center gap-2").style("background:#161620;border-bottom:1px solid #2a2a2a"):
                ui.label(tag_text).classes(f"text-xs font-bold px-1 rounded {tag_style}")
                ui.label(msg.tool_detail or "").classes("text-xs text-gray-500")
                if msg.tool_tag == "write" and msg.tool_diff:
                    ui.label(msg.tool_diff).classes("text-xs text-green-400 ml-auto")
            if msg.content:
                ui.label(msg.content[:300]).classes(
                    "px-2 py-1 text-xs font-mono text-gray-400 whitespace-pre-wrap"
                )
        return

    # AI message
    with ui.row().classes("w-full gap-2"):
        ui.label("AI").classes(
            "w-7 h-7 rounded-full bg-purple-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0"
        )
        ui.label(msg.content).classes(
            "flex-1 max-w-3xl px-3 py-2 rounded-lg text-xs text-gray-300 leading-relaxed"
        ).style("background:#1a1a1a;border-radius:2px 10px 10px 10px")


@ui.refreshable
def permission_banner():
    """Orange banner shown when a permission request is pending."""
    req = state.pending_permission
    if req is None:
        return
    tool_name = req.tool_name
    args_preview = str(req.args.get("command", req.args.get("path", req.args)))[:60]
    with ui.row().classes("mx-6 my-1 items-center gap-2 px-3 py-2 rounded-lg border border-yellow-800").style("background:#1a120a"):
        ui.label("⚠️").classes("text-sm")
        ui.label("L'IA veut exécuter : ").classes("text-xs text-yellow-500")
        ui.label(f"{tool_name}({args_preview})").classes("text-xs font-bold text-yellow-300")
        with ui.row().classes("ml-auto gap-1"):
            ui.button("Toujours", on_click=lambda: _resolve(True, always=True)).classes(
                "text-xs bg-blue-900 text-blue-300 px-2 py-1"
            )
            ui.button("Autoriser", on_click=lambda: _resolve(True)).classes(
                "text-xs bg-green-900 text-green-300 px-2 py-1"
            )
            ui.button("Refuser", on_click=lambda: _resolve(False)).classes(
                "text-xs bg-red-900 text-red-400 px-2 py-1"
            )


def _resolve(allow: bool, always: bool = False):
    if state.pending_permission:
        state.pending_permission.resolve(allow, always)
        state.pending_permission = None
        permission_banner.refresh()


@ui.refreshable
def chat_messages():
    if not state.messages:
        with ui.column().classes("flex-1 items-center justify-center"):
            ui.label("◈ openagent").classes("text-2xl font-bold text-purple-500")
            ui.label("Ouvre un dossier pour commencer.").classes("text-xs text-gray-600 mt-1")
        return
    for msg in state.messages:
        _render_message(msg)


def render_chat():
    with ui.scroll_area().classes("flex-1 w-full").style("background:#0d0d0d") as scroll:
        with ui.column().classes("w-full gap-3 p-5"):
            chat_messages()
            permission_banner()
    return scroll
