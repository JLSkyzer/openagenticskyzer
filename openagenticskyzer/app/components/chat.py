"""Chat message list with tool previews and permission banner."""
import asyncio

from nicegui import ui

from openagenticskyzer.app.state import state, ChatMessage


def _trigger_edit(idx: int):
    from openagenticskyzer.app.components.input_bar import edit_message
    edit_message(idx)


def _trigger_regenerate():
    from openagenticskyzer.app.components.input_bar import regenerate
    asyncio.ensure_future(regenerate())


_TOOL_TAG_STYLES = {
    "write":  ("bg-green-900 text-green-400",  "WRITE"),
    "run":    ("bg-blue-900  text-blue-400",   "RUN"),
    "read":   ("bg-orange-900 text-orange-400", "READ"),
    "search": ("bg-purple-900 text-purple-400", "SEARCH"),
}


def _render_diff(diff_text: str):
    """Affiche un unified diff avec lignes colorées (+vert, -rouge, @@ violet) — scrollable."""
    with ui.element("div").style(
        "font-family:monospace;font-size:11px;line-height:1.5;"
        "overflow-x:auto;overflow-y:auto;padding:4px 8px;border-top:1px solid #1e1e1e;"
        "max-height:400px;background:#0a0a0a;border-radius:4px;border:1px solid #2a2a2a;"
        "margin-top:4px"
    ):
        for line in diff_text.splitlines():
            if line.startswith("+++") or line.startswith("---"):
                ui.label(line).style("color:#6b7280;white-space:pre;display:block")
            elif line.startswith("@@"):
                ui.label(line).style("color:#7c3aed;white-space:pre;display:block;font-weight:bold")
            elif line.startswith("+"):
                ui.label(line).style(
                    "color:#4ade80;background:#052e16;display:block;white-space:pre;padding:2px 4px"
                )
            elif line.startswith("-"):
                ui.label(line).style(
                    "color:#f87171;background:#2d0a0a;display:block;white-space:pre;padding:2px 4px"
                )
            else:
                ui.label(line).style("color:#9ca3af;white-space:pre;display:block;padding:0px 4px")


def _render_message(msg: ChatMessage, idx: int = -1, is_last_ai: bool = False):
    if msg.role == "user":
        with ui.column().classes("items-end w-full gap-1 group"):
            if not state.agent_running:
                with ui.row().classes("opacity-0 group-hover:opacity-100 gap-1 transition-opacity"):
                    ui.button("✏️", on_click=lambda: _trigger_edit(idx)).classes(
                        "w-6 h-6 bg-gray-800 text-gray-400 hover:text-white text-xs rounded"
                    ).tooltip("Éditer ce message")
            if getattr(msg, "images", None):
                with ui.row().classes("justify-end flex-wrap gap-2"):
                    for uri in msg.images:
                        ui.html(
                            f'<img src="{uri}" style="max-width:220px;max-height:160px;'
                            f'border-radius:8px;object-fit:cover;display:block">'
                        )
            if msg.content:
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
    with ui.column().classes("w-full gap-1"):
        with ui.row().classes("w-full gap-2"):
            ui.label("AI").classes(
                "w-7 h-7 rounded-full bg-purple-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0"
            )
            ui.markdown(msg.content).classes(
                "flex-1 max-w-3xl px-3 py-2 rounded-lg text-xs text-gray-300 leading-relaxed"
            ).style("background:#1a1a1a;border-radius:2px 10px 10px 10px")
        if is_last_ai and not state.agent_running:
            ui.button("🔄", on_click=lambda: _trigger_regenerate()).classes(
                "text-xs text-gray-500 hover:text-purple-400 bg-transparent mt-1 ml-9"
            ).tooltip("Régénérer cette réponse")


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
    """Rendu des messages du chat — se recrée intelligemment."""
    if not state.messages and not state.agent_running:
        with ui.column().classes("flex-1 items-center justify-center"):
            ui.label("◈ openagent").classes("text-2xl font-bold text-purple-500")
            ui.label("Ouvre un dossier pour commencer.").classes("text-xs text-gray-600 mt-1")
        return

    # Messages finalisés
    last_ai_idx = -1
    for _idx, _m in enumerate(state.messages):
        if _m.role == "ai":
            last_ai_idx = _idx

    for idx, msg in enumerate(state.messages):
        _render_message(msg, idx, idx == last_ai_idx)

    # Messages en cours (live_log + streaming)
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
        with ui.scroll_area().classes("w-full oa-chat-scroll").style(
            "flex:1 1 0;background:#0d0d0d"
        ) as scroll:
            with ui.column().classes("w-full gap-3 p-5"):
                chat_messages()
                permission_banner()

    return scroll
