"""Input bar — textarea, model picker button, send button."""
import asyncio
from nicegui import ui, run

from openagentic_ai.app.state import state, ChatMessage
from openagentic_ai.app.components.model_modal import open_model_modal


async def _send_message(text: str, input_el, send_lbl=None):
    """Append user message, run agent, append AI response."""
    if not text.strip() or state.agent_running:
        return
    if not state.active_folder:
        ui.notify("Ouvre un dossier d'abord.", type="warning")
        return

    import os
    os.chdir(state.active_folder)

    from openagentic_ai.app.components.chat import chat_messages, permission_banner
    from openagentic_ai.app.components.context_bar import context_bar

    state.messages.append(ChatMessage(role="user", content=text))
    input_el.set_value("")
    state.agent_running = True
    if send_lbl:
        send_lbl.set_text("⏳")
    chat_messages.refresh()

    def _on_permission_request(req):
        state.pending_permission = req
        permission_banner.refresh()

    try:
        from openagentic_ai.agent import build_agent
        from openagentic_ai.permissions import PermissionManager
        from openagentic_ai.app.storage import load_global_config, load_folder_config

        global_cfg = load_global_config()
        folder_cfg = load_folder_config(state.active_folder)
        mode = folder_cfg.get("agent_mode", "inherit")
        if mode == "inherit":
            mode = global_cfg.get("agent_mode", "auto")

        max_tokens = global_cfg.get("max_tokens")
        perm_manager = PermissionManager(
            mode=state.permission_mode,
            is_cli=False,
            on_request=_on_permission_request,
        )

        agent = build_agent(mode=mode, max_tokens=max_tokens, permission_manager=perm_manager)

        history = [
            {"role": m.role if m.role != "ai" else "assistant", "content": m.content}
            for m in state.messages[:-1]
            if m.role in ("user", "ai")
        ]

        result = await run.io_bound(
            agent.invoke,
            {"messages": history + [{"role": "user", "content": text}]},
            {"recursion_limit": 300},
        )

        ai_text = ""
        for msg in reversed(result.get("messages", [])):
            content = getattr(msg, "content", "")
            if content and not getattr(msg, "tool_calls", None):
                ai_text = content if isinstance(content, str) else str(content)
                break

        if ai_text:
            state.messages.append(ChatMessage(role="ai", content=ai_text))

        total_chars = sum(
            len(m.content) for m in state.messages if m.role in ("user", "ai")
        )
        from openagentic_ai.utils.utils import _DEFAULT_CTX_LIMITS
        max_ctx = _DEFAULT_CTX_LIMITS.get(state.current_provider or "ollama", 32_000)
        state.context_tokens = total_chars // 4
        state.context_pct = min(100.0, state.context_tokens / max_ctx * 100)

    except Exception as exc:
        state.messages.append(ChatMessage(role="ai", content=f"❌ Erreur : {exc}"))
    finally:
        state.agent_running = False
        state.pending_permission = None
        if send_lbl:
            send_lbl.set_text("➤")
        chat_messages.refresh()
        permission_banner.refresh()
        context_bar.refresh()


def render_input_bar():
    with ui.column().classes("w-full px-3 pb-3 pt-2 gap-1").style(
        "background:#111;border-top:1px solid #1e1e1e"
    ):
        with ui.row().classes("w-full items-end gap-2"):
            input_el = ui.textarea(placeholder="Un message… (Entrée pour envoyer)").classes(
                "flex-1 text-xs rounded-lg"
            ).style(
                "background:#1a1a1a;border:1px solid #2a2a2a;color:#e0e0e0;min-height:40px;max-height:140px;padding:8px 12px"
            ).props("rows=1 autogrow")

            model_label = state.current_model or "Aucun modèle"
            ui.button(
                f"● {model_label[:20]} ▾",
                on_click=open_model_modal
            ).classes(
                "text-xs text-gray-400 border border-gray-700 bg-gray-900 hover:border-purple-500 px-2 h-10 rounded-lg flex-shrink-0"
            )

            send_lbl = ui.label("➤")
            send_btn = ui.button(on_click=lambda: None).classes(
                "w-10 h-10 bg-purple-600 hover:bg-purple-700 rounded-lg flex-shrink-0"
            )
            send_btn.clear()
            with send_btn:
                send_lbl

        ui.label("Entrée pour envoyer · Shift+Entrée nouvelle ligne").classes("text-xs text-gray-700 px-1")

        def _send_wrapper():
            asyncio.ensure_future(_send_message(input_el.value, input_el, send_lbl))

        input_el.on("keydown.enter.prevent", _send_wrapper)
        send_btn.on("click", _send_wrapper)
