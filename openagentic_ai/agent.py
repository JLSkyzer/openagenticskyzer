import argparse
import logging
import os

from openagentic_ai.context.persistence import PersistenceManager
from openagentic_ai.graph.workflow import build_graph
from openagentic_ai.prompts.prompt import DEEP_AGENT_SYSTEM_PROMPT
from openagentic_ai.tools.crud_tools import (
    create_file, view_file, read_file, edit_file, delete_file,
    grep_file, glob_files, grep_codebase, list_dir, create_dir, delete_dir,
)
from openagentic_ai.tools.internet_search import internet_search
from openagentic_ai.tools.shell_exec import run_command
from openagentic_ai.ui.tui import TUI, TUICallback, get_console
from openagentic_ai.utils.utils import get_llm, get_langfuse_handler, mode_router

_ALL_TOOLS = [
    run_command,
    create_file, view_file, read_file, edit_file, delete_file,
    grep_file, glob_files, grep_codebase, list_dir, create_dir, delete_dir,
    internet_search,
]


def build_agent(mode: str = "auto", max_tokens: int | None = None, permission_manager=None):
    model = get_llm()
    cwd = os.getcwd()
    mode_instruction = mode_router(mode)
    system_prompt = (
        DEEP_AGENT_SYSTEM_PROMPT
        + f"\nCURRENT WORKING DIRECTORY: {cwd}\n"
        "ALL file and folder operations MUST use this directory. "
        "NEVER use hardcoded absolute paths.\n"
        "Old tool outputs are trimmed from context to save tokens. "
        "Use read_file('agent_actions.log') to check what was already done.\n"
        + mode_instruction
    )
    return build_graph(model, _ALL_TOOLS, system_prompt, max_tokens=max_tokens, permission_manager=permission_manager)


def _setup_logging():
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )


def _run_turn(agent, messages: list, query: str, tui: TUI) -> list:
    """Run a single turn and return the updated message list."""
    state = {"messages": messages + [{"role": "user", "content": query}]}
    tui_cb = TUICallback(tui)
    callbacks = [tui_cb]
    langfuse_cb = get_langfuse_handler()
    if langfuse_cb:
        callbacks.append(langfuse_cb)

    try:
        result = agent.invoke(
            state,
            config={"callbacks": callbacks, "recursion_limit": 300},
        )
    except KeyboardInterrupt:
        tui.show_info("Interrupted.")
        return messages
    except Exception as exc:
        err = str(exc)
        if "recursion_limit" in err.lower() or "graphrecursionerror" in type(exc).__name__.lower():
            tui.show_error("Agent reached the step limit (300 steps). Task stopped to prevent infinite loops.")
        else:
            tui.show_error(err)
        return messages

    tui_cb.tui.end_assistant()
    return result.get("messages", messages)


def main():
    _setup_logging()

    parser = argparse.ArgumentParser(
        prog="openagent",
        description="AI coding assistant",
    )
    parser.add_argument("query", nargs="?", help="Query to send to the agent (optional)")
    parser.add_argument(
        "--mode",
        choices=["ask", "auto", "plan"],
        default="auto",
        help="Agent mode (default: auto)",
    )
    parser.add_argument("--resume", metavar="SESSION_ID", help="Resume a previous session by ID")
    parser.add_argument("--list-sessions", action="store_true", help="List saved sessions and exit")
    parser.add_argument(
        "--permission", choices=["demander", "auto", "strict"], default=None,
        help="Permission mode: demander (prompt), auto (skip all), strict (read-only)",
    )
    parser.add_argument("--app", action="store_true", help="Launch the graphical interface")
    args = parser.parse_args()

    if args.app:
        from openagentic_ai.app.main import launch_app
        launch_app()
        return

    persistence = PersistenceManager()

    if args.list_sessions:
        persistence.print_sessions()
        return

    console = get_console()
    from openagentic_ai.permissions import PermissionManager
    perm_mode = args.permission if args.permission else ("demander" if os.isatty(0) else "auto")
    perm_manager = PermissionManager(mode=perm_mode, is_cli=True)
    agent = build_agent(mode=args.mode, permission_manager=perm_manager)

    try:
        from openagentic_ai.utils.utils import _detect_provider
        _, _, model_name = _detect_provider()
    except Exception:
        model_name = "unknown"

    cwd = os.getcwd()
    tui = TUI(model_name=model_name, cwd=cwd, mode=args.mode, console=console)

    messages: list = []
    session_id = persistence.new_session_id()
    turn_count = 0

    if args.resume:
        try:
            messages, meta = persistence.load(args.resume)
            session_id = meta["session_id"]
            turn_count = meta.get("turn_count", 0)
            tui.show_info(
                f"Resumed session {session_id} ({len(messages)} messages from previous run)"
            )
        except (FileNotFoundError, ValueError) as exc:
            tui.show_info(f"Warning: {exc}. Starting a new session.")

    if args.query:
        tui.print_welcome()
        messages = _run_turn(agent, messages, args.query, tui)
        turn_count += 1
        persistence.save(session_id=session_id, messages=messages, turn_count=turn_count, cwd=cwd)
        tui.show_info(f"Session saved: {session_id}  —  resume with: openagent --resume {session_id}")
        return

    tui.print_welcome()
    current_mode = args.mode

    while True:
        try:
            user_input = tui.prompt_input()
        except (KeyboardInterrupt, EOFError):
            break

        if not user_input:
            continue

        if user_input.startswith("/"):
            cmd_parts = user_input.split(maxsplit=1)
            cmd = cmd_parts[0].lower()
            cmd_arg = cmd_parts[1] if len(cmd_parts) > 1 else ""

            if cmd in ("/exit", "/quit"):
                break
            elif cmd == "/help":
                tui.show_help()
            elif cmd == "/clear":
                messages = []
                tui.show_success("Conversation cleared.")
            elif cmd == "/mode":
                valid = ["ask", "auto", "plan"]
                if cmd_arg in valid:
                    current_mode = cmd_arg
                    agent = build_agent(mode=current_mode, permission_manager=perm_manager)
                    tui.mode = current_mode
                    tui.show_success(f"Mode changed to: {current_mode}")
                else:
                    tui.show_error(f"Unknown mode '{cmd_arg}'. Choose from: {valid}")
            else:
                tui.show_error(f"Unknown command: {cmd}. Type /help for available commands.")
            continue

        messages = _run_turn(agent, messages, user_input, tui)
        turn_count += 1
        persistence.save(session_id=session_id, messages=messages, turn_count=turn_count, cwd=cwd)

    tui.show_info("Goodbye!")

    # Flush Langfuse traces before exit (background sender won't finish otherwise)
    try:
        from langfuse import get_client
        get_client().shutdown()
    except Exception:
        pass


if __name__ == "__main__":
    main()
