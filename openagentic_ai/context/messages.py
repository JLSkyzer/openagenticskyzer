"""Message history utilities — trim and clean before each LLM call.

Inspired by the token optimization strategy in agent-graph-bot:
- trim_message_history: keep only the last N messages (drops old context)
- clean_messages: strip expensive LLM metadata from additional_kwargs
"""

import logging
from langchain_core.messages import AIMessage, SystemMessage, ToolMessage

logger = logging.getLogger("openagentic.messages")

_METADATA_BLOAT_KEYS = {
    "__gemini_function_call_thought_signatures__",
    "__gemini_thinking__",
    "__mistral_thinking__",
    "raw_response",
    "system_fingerprint",
}


def trim_message_history(messages: list, max_messages: int = 20) -> list:
    """Return the last max_messages non-system messages.

    System messages are excluded (they are injected fresh on each call).
    Never returns a list starting with a ToolMessage — orphan tool results
    without their parent AIMessage confuse the model.
    """
    non_system = [m for m in messages if not isinstance(m, SystemMessage)]

    if len(non_system) <= max_messages:
        return non_system

    trimmed = non_system[-max_messages:]

    # Safety: ToolMessage must be preceded by the AIMessage that called it.
    # If we trimmed that AIMessage, drop the orphan ToolMessage(s).
    while trimmed and isinstance(trimmed[0], ToolMessage):
        trimmed = trimmed[1:]

    logger.debug(
        "Trimmed history: %d → %d messages (max=%d)",
        len(non_system), len(trimmed), max_messages,
    )
    return trimmed


def clean_messages(messages: list) -> list:
    """Remove expensive LLM metadata keys from AIMessage.additional_kwargs."""
    cleaned = []
    for m in messages:
        if isinstance(m, AIMessage) and m.additional_kwargs:
            lean_kwargs = {
                k: v for k, v in m.additional_kwargs.items()
                if k not in _METADATA_BLOAT_KEYS
            }
            if len(lean_kwargs) < len(m.additional_kwargs):
                try:
                    m = m.model_copy(update={"additional_kwargs": lean_kwargs})
                except Exception:
                    m = AIMessage(
                        content=m.content,
                        tool_calls=m.tool_calls,
                        additional_kwargs=lean_kwargs,
                        id=m.id,
                    )
        cleaned.append(m)
    return cleaned
