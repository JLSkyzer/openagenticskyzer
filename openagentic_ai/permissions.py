"""Permission system — intercepts tool calls and asks user before executing."""
import sys
import threading
import logging
from typing import Callable

from langchain_core.messages import ToolMessage, AIMessage
from langgraph.prebuilt import ToolNode

logger = logging.getLogger("openagentic.permissions")

_RESTRICTED_TOOLS = {
    "run_command", "create_file", "edit_file", "delete_file",
    "delete_dir", "create_dir",
}
_READ_ONLY_TOOLS = {
    "read_file", "view_file", "glob_files", "grep_file",
    "grep_codebase", "list_dir", "internet_search",
}


class PermissionRequest:
    """A pending permission request, resolved by the UI or CLI."""

    def __init__(self, tool_name: str, args: dict):
        self.tool_name = tool_name
        self.args = args.copy()
        self.result: bool = False
        self.always: bool = False
        self._event = threading.Event()

    def resolve(self, allow: bool, always: bool = False) -> None:
        self.result = allow
        self.always = always
        self._event.set()

    def wait(self) -> bool:
        self._event.wait()
        return self.result


class PermissionManager:
    """Central permission controller for CLI and GUI modes."""

    def __init__(
        self,
        mode: str = "demander",
        is_cli: bool = False,
        on_request: Callable[["PermissionRequest"], None] | None = None,
    ):
        """
        mode: 'demander' | 'auto' | 'strict'
        is_cli: True when running in CLI mode (uses input())
        on_request: callback called when a request is pending (GUI mode)
        """
        if mode not in ("demander", "auto", "strict"):
            raise ValueError(f"Invalid permission mode: {mode!r}. Choose from: demander, auto, strict")
        self.mode = mode
        self.is_cli = is_cli
        self._on_request = on_request
        self._lock = threading.Lock()
        self._always_allow: set[str] = set()
        self.pending: PermissionRequest | None = None

    def check(self, tool_name: str, args: dict) -> bool:
        if self.mode == "auto":
            return True
        if self.mode == "strict":
            return tool_name not in _RESTRICTED_TOOLS

        # mode == "demander"
        if tool_name in _READ_ONLY_TOOLS:
            return True
        with self._lock:
            if tool_name in self._always_allow:
                return True

        if self.is_cli:
            return self._cli_check(tool_name, args)
        return self._app_check(tool_name, args)

    def _cli_check(self, tool_name: str, args: dict) -> bool:
        if not sys.stdin.isatty():
            logger.info("Non-TTY detected — auto-allowing %s", tool_name)
            return True
        try:
            cmd_preview = str(args.get("command", args.get("path", args)))[:80]
            answer = input(
                f"\n⚠️  Permission requise : {tool_name}({cmd_preview})\n"
                "  [y] Autoriser  [a] Toujours  [n] Refuser : "
            ).strip().lower()
        except (EOFError, KeyboardInterrupt):
            return False

        if answer == "a":
            with self._lock:
                self._always_allow.add(tool_name)
            return True
        return answer == "y"

    def _app_check(self, tool_name: str, args: dict) -> bool:
        req = PermissionRequest(tool_name, args)
        with self._lock:
            self.pending = req
        if self._on_request:
            self._on_request(req)
        allowed = req.wait()
        with self._lock:
            if req.always:
                self._always_allow.add(tool_name)
            self.pending = None
        return allowed


def make_permission_tool_node(
    tools: list, manager: PermissionManager
) -> Callable[[dict], dict]:
    """Return a LangGraph node function that checks permissions before executing tools."""
    tool_map = {t.name: t for t in tools}
    base_node = ToolNode(tools)

    def permission_tool_node(state: dict) -> dict:
        last_msg = state["messages"][-1]
        if not isinstance(last_msg, AIMessage) or not last_msg.tool_calls:
            return base_node(state)

        results = []
        for call in last_msg.tool_calls:
            tool_name = call["name"]
            tool_args = call["args"]
            call_id = call["id"]

            if not manager.check(tool_name, tool_args):
                logger.info("Permission denied for %s", tool_name)
                results.append(
                    ToolMessage(
                        content=f"[Permission refusée] L'action '{tool_name}' a été bloquée par l'utilisateur.",
                        tool_call_id=call_id,
                    )
                )
                continue

            if tool_name not in tool_map:
                results.append(
                    ToolMessage(content=f"[Erreur] Outil inconnu: {tool_name}", tool_call_id=call_id)
                )
                continue

            try:
                output = tool_map[tool_name].invoke(tool_args)
                results.append(ToolMessage(content=str(output), tool_call_id=call_id))
            except Exception as exc:
                logger.exception("Tool %s raised an exception", tool_name, exc_info=exc)
                results.append(
                    ToolMessage(content=f"[Erreur] {tool_name}: {exc}", tool_call_id=call_id)
                )

        return {"messages": results}

    return permission_tool_node
