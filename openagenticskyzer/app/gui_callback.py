"""Callback LangChain → state.live_log pour affichage temps réel dans la GUI."""
import json
from langchain_core.callbacks import BaseCallbackHandler

from openagenticskyzer.app.state import state, ChatMessage


class _StopRequested(Exception):
    """Levée depuis on_llm_new_token pour interrompre la génération."""

_TOOL_TAGS = {
    "run_command":   "run",
    "create_file":   "write",
    "edit_file":     "write",
    "delete_file":   "write",
    "create_dir":    "write",
    "delete_dir":    "write",
    "view_file":     "read",
    "read_file":     "read",
    "list_dir":      "read",
    "glob_files":    "read",
    "grep_file":     "read",
    "grep_codebase": "read",
    "internet_search": "search",
}


class GUIAgentCallback(BaseCallbackHandler):
    def on_llm_new_token(self, token: str, **kwargs) -> None:
        state.live_tokens += 1
        if state.stop_requested:
            raise _StopRequested("Arrêté par l'utilisateur")

    def on_tool_start(self, serialized, input_str, **kwargs):
        tool_name = serialized.get("name", "?")
        tag = _TOOL_TAGS.get(tool_name, "read")
        detail = str(input_str)[:120]
        try:
            parsed = json.loads(input_str)
            detail = str(
                parsed.get("path") or parsed.get("command") or
                parsed.get("query") or input_str
            )[:120]
        except Exception:
            pass
        state.live_log.append(ChatMessage(
            role="tool",
            content="",
            tool_name=tool_name,
            tool_tag=tag,
            tool_detail=detail,
        ))

    def on_tool_end(self, output, **kwargs):
        if state.live_log and state.live_log[-1].role == "tool" and not state.live_log[-1].content:
            last = state.live_log[-1]
            output_str = str(output) if output else ""
            tool_diff = None
            content_display = output_str[:300]
            # Extrait le diff des résultats edit_file
            if "DIFF:\n" in output_str:
                parts = output_str.split("DIFF:\n", 1)
                content_display = parts[0].strip()[:200]
                tool_diff = parts[1][:1500] if len(parts) > 1 else None
            state.live_log[-1] = ChatMessage(
                role="tool",
                content=content_display,
                tool_name=last.tool_name,
                tool_tag=last.tool_tag,
                tool_detail=last.tool_detail,
                tool_diff=tool_diff,
            )
