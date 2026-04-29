"""Chat message list with tool previews and permission banner."""
from nicegui import ui

from openagenticskyzer.app.state import state, ChatMessage

_TOOL_TAG_STYLES = {
    "write":  ("bg-green-900 text-green-400",  "WRITE"),
    "run":    ("bg-blue-900  text-blue-400",   "RUN"),
    "read":   ("bg-orange-900 text-orange-400", "READ"),
    "search": ("bg-purple-900 text-purple-400", "SEARCH"),
}


def _render_diff(diff_text: str):
    """Affiche un unified diff avec lignes colorées (+vert, -rouge, @@ violet)."""
    with ui.element("div").style(
        "font-family:monospace;font-size:11px;line-height:1.5;"
        "overflow-x:auto;padding:4px 8px;border-top:1px solid #1e1e1e"
    ):
        for line in diff_text.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                ui.label(line).style("color:#6b7280;white-space:pre")
            elif line.startswith("@@"):
                ui.label(line).style("color:#7c3aed;white-space:pre")
            elif line.startswith("+"):
                ui.label(line).style(
                    "color:#4ade80;background:#052e16;display:block;white-space:pre"
                )
            elif line.startswith("-"):
                ui.label(line).style(
                    "color:#f87171;background:#2d0a0a;display:block;white-space:pre"
                )
            else:
                ui.label(line).style("color:#6b7280;white-space:pre")


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
                ui.label(msg.tool_detail or "").classes("text-xs text-gray-500 truncate flex-1")
            if msg.content:
                ui.label(msg.content).classes(
                    "px-2 py-1 text-xs font-mono text-gray-400 whitespace-pre-wrap"
                )
            if msg.tool_diff:
                _render_diff(msg.tool_diff)
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
    if not state.messages and not state.agent_running:
        with ui.column().classes("flex-1 items-center justify-center"):
            ui.label("◈ openagent").classes("text-2xl font-bold text-purple-500")
            ui.label("Ouvre un dossier pour commencer.").classes("text-xs text-gray-600 mt-1")
        return

    for msg in state.messages:
        _render_message(msg)

    if state.agent_running:
        for msg in state.live_log:
            _render_message(msg)
        if state.is_streaming and state.streaming_content:
            # Affichage streaming token par token
            with ui.row().classes("w-full gap-2"):
                ui.label("AI").classes(
                    "w-7 h-7 rounded-full bg-purple-600 text-white text-xs font-bold "
                    "flex items-center justify-center flex-shrink-0"
                )
                ui.markdown(state.streaming_content).classes(
                    "flex-1 max-w-3xl px-3 py-2 rounded-lg text-xs text-gray-300 leading-relaxed"
                ).style("background:#1a1a1a;border-radius:2px 10px 10px 10px")
        else:
            # Typing dots (en attente ou entre tool calls)
            with ui.row().classes("w-full gap-2 items-center"):
                ui.label("AI").classes(
                    "w-7 h-7 rounded-full bg-purple-600 text-white text-xs font-bold "
                    "flex items-center justify-center flex-shrink-0"
                )
                ui.html('<div class="typing-dots"><span></span><span></span><span></span></div>')
                if state.live_tokens > 0:
                    ui.label(f"{state.live_tokens} tokens").classes("text-xs text-gray-600 ml-1")
    ui.run_javascript("if(typeof applyHighlight==='function') setTimeout(applyHighlight, 150)")


def render_chat():
    with ui.element("div").style(
        "flex:1 1 0;min-height:0;position:relative;display:flex;flex-direction:column;overflow:hidden"
    ):
        with ui.scroll_area().classes("w-full").style("flex:1 1 0;background:#0d0d0d") as scroll:
            with ui.column().classes("w-full gap-3 p-5"):
                chat_messages()
                permission_banner()

        # Bouton flottant scroll-to-bottom (visible uniquement quand pas en bas)
        ui.html(
            '<button id="oa-scroll-btn" title="Aller en bas"'
            ' onclick="(function(){var s=document.querySelector(\'.q-scrollarea__container\');'
            'if(s)s.scrollTop=s.scrollHeight;})()"'
            ' style="display:none;position:absolute;bottom:10px;right:10px;z-index:20;'
            'width:28px;height:28px;border-radius:50%;background:#7c3aed;color:#fff;'
            'border:none;cursor:pointer;font-size:14px;align-items:center;'
            'justify-content:center;box-shadow:0 2px 8px #0008">↓</button>'
        )

    return scroll
