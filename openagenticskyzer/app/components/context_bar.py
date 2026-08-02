"""Context usage bar shown between chat and input."""
from nicegui import ui
from openagenticskyzer.app.state import state
from openagenticskyzer.app.storage import load_global_config


def _build_compact_history_text(messages: list) -> str:
    """Flatten the conversation (minus the last 2 messages) into the text
    fed to the summarization prompt. Pure function — testable without any
    NiceGUI/LLM state. `messages` items only need `.role` and `.content`."""
    return "\n\n".join(
        f"[{m.role.upper()}]: {m.content[:800]}"
        for m in messages[:-2]
        if m.role in ("user", "ai")
    )


def _build_compact_summary_prompt(history_text: str) -> str:
    """Build the summarization instruction sent to the LLM. Pure function."""
    return (
        "Résume cette conversation de manière dense et structurée.\n"
        "Conserve : décisions prises, fichiers modifiés, problèmes résolus, contexte technique.\n"
        "Omets : salutations, répétitions, tentatives ratées.\n"
        "Format : liste à puces, max 400 mots.\n\n"
        f"CONVERSATION :\n{history_text}\n\nRÉSUMÉ :"
    )


def _extract_summary_from_result(messages: list) -> str:
    """Extract the last non-tool-call AI content from a list of graph
    messages (as returned under `agent.invoke(...)["messages"]`). Pure
    function — testable without an LLM. Items only need `.content` and
    optionally `.tool_calls` attributes (duck-typed, so plain objects or
    langchain_core.messages.* both work)."""
    for msg in reversed(messages):
        content = getattr(msg, "content", "")
        if content and not getattr(msg, "tool_calls", None):
            return content if isinstance(content, str) else str(content)
    return ""


# Re-entrancy guard: trigger_compact is reachable both from the
# "⚡ Auto-compact" button click (never disabled while a compaction is in
# flight) and automatically from input_bar.py's auto-compact check after
# any qualifying message send. Without this flag, two overlapping runs
# would race on state.messages and each independently call
# append_to_project_memory, writing duplicate overlapping summaries.
_compact_in_progress = False


async def trigger_compact():
    """Compact the conversation by asking the LLM to summarize it, then
    persist the summary into project memory. Wired directly via
    `on_click=trigger_compact` on the Auto-compact button below (NiceGUI
    schedules async event handlers automatically) and via
    `await trigger_compact()` from input_bar.py's auto-compact check.

    Concurrency notes:
    - Guarded against re-entrancy via `_compact_in_progress` (see above).
    - The tail of messages to keep is snapshotted *together* with the
      history text, before the `await run.io_bound(...)` below. That await
      yields control back to NiceGUI's single-threaded event loop, during
      which state.messages can grow (e.g. another message sent). Reading
      `state.messages[-2:]` fresh *after* the await would then silently
      drop whichever message fell between the summarized history and the
      shifted tail — so we reuse the original snapshot's tail instead.
    """
    from nicegui import run
    from openagenticskyzer.app.components.chat import chat_messages
    from openagenticskyzer.app.state import ChatMessage, state
    from openagenticskyzer.context.project_memory import append_to_project_memory

    global _compact_in_progress

    if len(state.messages) < 6:
        ui.notify("Pas assez de messages à compresser.", type="warning")
        return

    if _compact_in_progress:
        ui.notify("Compression déjà en cours…", type="warning")
        return

    _compact_in_progress = True
    try:
        # Snapshot history text AND the tail to keep together, atomically,
        # before yielding control at the await below.
        snapshot = list(state.messages)
        history_text = _build_compact_history_text(snapshot)
        tail = snapshot[-2:]
        summary_prompt = _build_compact_summary_prompt(history_text)

        ui.notify("Compression en cours…", type="info")

        # Narrow try: only the LLM call + extraction fall back to a
        # brute-cut on failure. State mutation / persistence / UI refresh
        # after a *successful* LLM call live outside this block, so a
        # refresh/notify hiccup post-success can never be misreported as
        # "LLM indisponible" nor trigger a redundant (no-op) brute-cut.
        try:
            from openagenticskyzer.agent import build_agent
            # tools=[] : ce résumeur n'a aucune raison légitime d'appeler un
            # outil. Sans ce paramètre, build_agent bindait toute la surface
            # `_ALL_TOOLS` (run_command, delete_file, git_push…) et, faute de
            # permission_manager, montait un `ToolNode` SANS aucun contrôle de
            # permission — alors que l'entrée de cet appel est l'historique de
            # conversation (contenu web/fichiers potentiellement porteur d'une
            # injection de prompt) et qu'il se déclenche automatiquement,
            # sans surveillance, depuis l'auto-compact de input_bar.py.
            agent = build_agent(mode="ask",
                                provider=state.current_provider,
                                model_name=state.current_model,
                                tools=[])
            result = await run.io_bound(
                agent.invoke,
                {"messages": [{"role": "user", "content": summary_prompt}]},
                {"recursion_limit": 10},
            )
            summary = _extract_summary_from_result(result.get("messages", []))
        except Exception as exc:
            state.messages = state.messages[-6:]
            state.context_pct = max(0.0, state.context_pct - 50.0)
            ui.notify(f"Compaction rapide (LLM indisponible : {exc})", type="warning")
            chat_messages.refresh()
            context_bar.refresh()
            return

        if not summary:
            ui.notify(
                "Le modèle n'a renvoyé aucun résumé — contexte inchangé.",
                type="negative",
            )
            return

        summary_msg = ChatMessage(
            role="ai",
            content=f"**[Résumé de contexte compressé]**\n\n{summary}",
        )
        state.messages = [summary_msg] + tail
        state.context_pct = 15.0
        state.context_tokens = len(summary) // 4
        if state.active_folder:
            append_to_project_memory(state.active_folder, summary)
        chat_messages.refresh()
        context_bar.refresh()
        ui.notify("Contexte compressé avec résumé IA.", type="positive")
    finally:
        _compact_in_progress = False


@ui.refreshable
def context_bar():
    cfg = load_global_config()
    if not cfg.get("show_context_bar", True):
        return

    pct = min(100.0, state.context_pct)
    tokens = state.context_tokens
    color = "bg-purple-600" if pct < 70 else ("bg-yellow-500" if pct < 90 else "bg-red-500")

    with ui.row().classes("w-full items-center gap-2 px-6 py-1").style(
        "background:#0f0f0f;border-top:1px solid #1e1e1e;min-height:28px;flex-shrink:0"
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
