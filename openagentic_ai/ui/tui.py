import json
from typing import Any
from uuid import UUID

from rich.console import Console, Group
from rich.theme import Theme
from rich.rule import Rule
from rich.text import Text
from rich.panel import Panel
from rich.table import Table
from rich import box
from rich.syntax import Syntax
from rich.markdown import Markdown
from langchain_core.callbacks import BaseCallbackHandler

AGENT_THEME = Theme(
    {
        # General
        "info": "cyan",
        "warning": "yellow",
        "error": "bright_red bold",
        "success": "green",
        "dim": "dim",
        "muted": "grey50",
        "border": "grey35",
        "highlight": "bold cyan",
        # Roles
        "user": "bright_blue bold",
        "assistant": "bright_white",
        # Tools
        "tool": "bright_magenta bold",
        "tool.read": "cyan",
        "tool.write": "yellow",
        "tool.shell": "magenta",
        "tool.subagent": "bright_cyan",
        "tool.memory": "green",
        # Code / blocks
        "code": "white",
    }
)

# Map tool names to display categories
_TOOL_KINDS: dict[str, str] = {
    "run_command": "shell",
    "create_file": "write",
    "edit_file": "write",
    "delete_file": "write",
    "create_dir": "write",
    "view_file": "read",
    "read_file": "read",
    "list_dir": "read",
    "task": "subagent",
    "compact_conversation": "memory",
    "write_todos": "memory",
    # deepagents built-in tools
    "execute": "shell",
    "ls": "read",
    "write_file": "write",
    "glob": "read",
    "grep": "read",
}

_console: Console | None = None


def get_console() -> Console:
    global _console
    if _console is None:
        _console = Console(theme=AGENT_THEME, highlight=False)
    return _console


class TUI:
    def __init__(self, model_name: str, cwd: str, mode: str = "auto", console: Console | None = None) -> None:
        self.console = console or get_console()
        self.model_name = model_name
        self.cwd = cwd
        self.mode = mode
        self._assistant_stream_open = False

    def print_welcome(self) -> None:
        body = "\n".join(
            [
                f"model: {self.model_name}",
                f"cwd:   {self.cwd}",
                f"mode:  {self.mode}",
                "cmds:  /help  /clear  /mode <ask|auto|plan>  /exit",
            ]
        )
        self.console.print(
            Panel(
                Text(body, style="code"),
                title=Text("OpenAgentic", style="highlight"),
                title_align="left",
                border_style="border",
                box=box.ROUNDED,
                padding=(1, 2),
            )
        )

    def begin_assistant(self) -> None:
        self.console.print()
        self.console.print(Rule(Text("Assistant", style="assistant")))
        self._assistant_stream_open = True

    def end_assistant(self) -> None:
        if self._assistant_stream_open:
            self.console.print()
        self._assistant_stream_open = False

    def stream_assistant_delta(self, content: str) -> None:
        self.console.print(content, end="", markup=False)

    def _get_tool_kind(self, name: str) -> str | None:
        return _TOOL_KINDS.get(name)

    def _render_args_table(self, args: dict[str, Any]) -> Table:
        table = Table.grid(padding=(0, 1))
        table.add_column(style="muted", justify="right", no_wrap=True)
        table.add_column(style="code", overflow="fold")
        for key, value in args.items():
            if isinstance(value, str):
                lines = value.splitlines()
                if len(lines) > 5 or len(value) > 300:
                    byte_count = len(value.encode("utf-8", errors="replace"))
                    value = f"<{len(lines)} lines • {byte_count} bytes>"
            elif isinstance(value, bool):
                value = str(value)
            elif not isinstance(value, str):
                value = str(value)
            table.add_row(key, value)
        return table

    def tool_call_start(self, call_id: str, name: str, args: dict[str, Any]) -> None:
        kind = self._get_tool_kind(name)
        border_style = f"tool.{kind}" if kind else "tool"

        title = Text.assemble(
            ("⏺ ", "muted"),
            (name, "tool"),
            ("  ", "muted"),
            (f"#{call_id[:8]}", "muted"),
        )

        content = self._render_args_table(args) if args else Text("(no args)", style="muted")

        panel = Panel(
            content,
            title=title,
            title_align="left",
            subtitle=Text("running", style="muted"),
            subtitle_align="right",
            border_style=border_style,
            box=box.ROUNDED,
            padding=(1, 2),
        )
        self.console.print()
        self.console.print(panel)

    def tool_call_complete(
        self,
        call_id: str,
        name: str,
        success: bool,
        output: str,
        error: str | None = None,
    ) -> None:
        kind = self._get_tool_kind(name)
        border_style = f"tool.{kind}" if kind else "tool"
        status_icon = "✓" if success else "✗"
        status_style = "success" if success else "error"

        title = Text.assemble(
            (f"{status_icon} ", status_style),
            (name, "tool"),
            ("  ", "muted"),
            (f"#{call_id[:8]}", "muted"),
        )

        blocks: list[Any] = []
        if error and not success:
            blocks.append(Text(error, style="error"))

        # Truncate very long outputs
        display = output if len(output) <= 3000 else output[:3000] + "\n…(truncated)"
        if display.strip():
            blocks.append(
                Syntax(display, "text", theme="monokai", word_wrap=True)
            )
        else:
            blocks.append(Text("(no output)", style="muted"))

        panel = Panel(
            Group(*blocks),
            title=title,
            title_align="left",
            subtitle=Text("done" if success else "failed", style=status_style),
            subtitle_align="right",
            border_style=border_style,
            box=box.ROUNDED,
            padding=(1, 2),
        )
        self.console.print()
        self.console.print(panel)

    def show_help(self) -> None:
        help_md = """
## Commands

- `/help` — Show this help
- `/exit` or `/quit` — Exit
- `/clear` — Clear conversation history
- `/mode <ask|auto|plan>` — Switch agent mode

## Mode descriptions

- **ask** — Answer questions only, no file edits or commands
- **auto** — Work autonomously: plan, edit, run commands
- **plan** — Produce a step-by-step plan before acting
"""
        self.console.print(Markdown(help_md))

    def show_info(self, message: str) -> None:
        self.console.print(f"\n[dim]{message}[/dim]")

    def show_error(self, message: str) -> None:
        self.console.print(f"\n[error]Error: {message}[/error]")

    def show_success(self, message: str) -> None:
        self.console.print(f"[success]{message}[/success]")

    def prompt_input(self) -> str:
        return self.console.input("\n[user]>[/user] ").strip()


class TUICallback(BaseCallbackHandler):
    """LangChain callback handler that routes LLM and tool events to the TUI."""

    def __init__(self, tui: TUI) -> None:
        super().__init__()
        self.tui = tui
        self._assistant_open = False
        self._pending_tools: dict[str, dict[str, Any]] = {}

    # ── LLM streaming ────────────────────────────────────────────────────────

    def on_llm_new_token(self, token: str, **kwargs: Any) -> None:
        if not self._assistant_open:
            self.tui.begin_assistant()
            self._assistant_open = True
        self.tui.stream_assistant_delta(token)

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        if self._assistant_open:
            self.tui.end_assistant()
            self._assistant_open = False

    def on_llm_error(self, error: Any, **kwargs: Any) -> None:
        if self._assistant_open:
            self.tui.end_assistant()
            self._assistant_open = False
        self.tui.show_error(str(error))

    # ── Tool lifecycle ────────────────────────────────────────────────────────

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        name = serialized.get("name", "unknown")
        try:
            args: dict[str, Any] = json.loads(input_str) if input_str else {}
            if not isinstance(args, dict):
                args = {"input": input_str}
        except (json.JSONDecodeError, TypeError):
            args = {"input": input_str} if input_str else {}

        call_id = str(run_id)
        self._pending_tools[call_id] = {"name": name}
        self.tui.tool_call_start(call_id[:8], name, args)

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        call_id = str(run_id)
        info = self._pending_tools.pop(call_id, {})
        name = info.get("name", "unknown")
        self.tui.tool_call_complete(call_id[:8], name, True, str(output))

    def on_tool_error(self, error: Any, *, run_id: UUID, **kwargs: Any) -> None:
        call_id = str(run_id)
        info = self._pending_tools.pop(call_id, {})
        name = info.get("name", "unknown")
        self.tui.tool_call_complete(call_id[:8], name, False, "", str(error))
