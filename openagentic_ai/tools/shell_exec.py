import atexit
import logging
import os
import re
import subprocess
import threading
import time

from langchain_core.tools import tool

from openagentic_ai.context.session_log import log_action
from rich.console import Console
from rich.live import Live
from rich.text import Text

logger = logging.getLogger("openagent.runner")
_console = Console(highlight=False)

_SERVER_KEYWORDS = (
    "streamlit run", "uvicorn", "flask run", "fastapi run",
    "npm start", "npm run dev", "npm run start",
    "yarn start", "yarn dev",
    "pnpm dev", "pnpm start", "pnpm run dev", "pnpm run start",
)

# Track running server processes to avoid duplicates: key -> Popen
_running_servers: dict[str, subprocess.Popen] = {}
_servers_lock = threading.Lock()


def _cleanup_servers():
    with _servers_lock:
        for cmd, proc in list(_running_servers.items()):
            if proc.poll() is None:
                logger.info("Terminating background server (pid=%d): %s", proc.pid, cmd)
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()


atexit.register(_cleanup_servers)


def _is_server_command(command: str) -> bool:
    cmd = command.strip().lower()
    return any(kw in cmd for kw in _SERVER_KEYWORDS)


def _normalize_paths(command: str, cwd: str) -> str:
    """Replace absolute file paths in a command with paths relative to cwd.
    URLs (http://, https://, //host) are left untouched."""
    quote_char: list[str] = [""]

    def replace_path(m):
        original = m.group(0)
        if original.startswith('"') and original.endswith('"'):
            raw = original[1:-1]
            quote_char[0] = '"'
        elif original.startswith("'") and original.endswith("'"):
            raw = original[1:-1]
            quote_char[0] = "'"
        else:
            raw = original
            quote_char[0] = ""
        if re.match(r'^https?://', raw) or raw.startswith('//'):
            return original
        if re.match(r'^/[A-Za-z][A-Za-z0-9]*$', raw):
            return original
        if not os.path.isabs(raw):
            return original
        try:
            rel = os.path.relpath(raw, cwd)
            if not rel.startswith(".."):
                logger.debug("Path normalized: %s -> %s", raw, rel)
                q = quote_char[0]
                return f"{q}{rel}{q}"
        except ValueError:
            pass
        _, no_drive = os.path.splitdrive(raw)
        stripped = no_drive.lstrip("/\\")
        resolved = os.path.join(cwd, stripped)
        logger.warning("Path corrected in command: %s -> %s", raw, resolved)
        q = quote_char[0]
        return f"{q}{resolved}{q}"
    return re.sub(r'"[^"]*"|\'[^\']*\'|(?<!\S)[A-Za-z]:\\[^\s"\']+|(?<!\S)/[A-Za-z0-9_.~][^\s"\']*', replace_path, command)


def _make_spinner(command: str, elapsed: float, last_line: str) -> Text:
    frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    frame = frames[int(elapsed * 10) % len(frames)]
    cmd_short = command[:60] + ("…" if len(command) > 60 else "")
    t = Text()
    t.append(f"{frame} ", style="bold cyan")
    t.append(cmd_short, style="bold white")
    t.append(f"  ({elapsed:.0f}s)", style="dim")
    if last_line:
        preview = last_line[:100] + ("…" if len(last_line) > 100 else "")
        t.append(f"\n  {preview}", style="dim")
    return t


_NOISE_PATTERNS = re.compile(
    r'^('
    r'Progress: resolved \d+'           # pnpm progress lines
    r'|\++$'                            # pnpm progress bars (+++++)
    r'|\.{3,}/[^\s]+ \|'              # pnpm download progress
    r')',
    re.MULTILINE
)

def _collapse_noise(text: str) -> str:
    """Collapse repeated noisy lines (pnpm progress, dir /S listings) to save tokens."""
    lines = text.splitlines()
    result = []
    noise_count = 0
    last_noise = ""
    for line in lines:
        if _NOISE_PATTERNS.match(line):
            noise_count += 1
            last_noise = line
        else:
            if noise_count > 2:
                result.append(f"  ... ({noise_count} lines collapsed: install/listing progress) ...")
            elif noise_count > 0:
                result.append(last_noise)
            noise_count = 0
            result.append(line)
    if noise_count > 2:
        result.append(f"  ... ({noise_count} lines collapsed) ...")
    elif noise_count > 0:
        result.append(last_noise)
    return "\n".join(result)


_NEXTJS_DEFAULT_MARKERS = (
    "vercel.svg", "next.svg", "create-next-app",
    "To get started, edit", "get-started",
)

def _check_nextjs_page(command: str, cwd: str) -> str | None:
    """Before launching a Next.js dev server, verify that page.tsx has been
    customized. Returns a blocking error message if it still has default content."""
    if not any(kw in command.lower() for kw in ("pnpm run dev", "npm run dev", "next dev")):
        return None
    # Extract project subdirectory from "cd <dir> && ..."
    m = re.match(r'cd\s+"?([^"&]+?)"?\s*&&', command)
    project_dir = os.path.join(cwd, m.group(1).strip()) if m else cwd
    for candidate in [
        os.path.join(project_dir, "app", "page.tsx"),
        os.path.join(project_dir, "src", "app", "page.tsx"),
    ]:
        if os.path.exists(candidate):
            with open(candidate, "r", encoding="utf-8") as f:
                content = f.read()
            if any(marker in content for marker in _NEXTJS_DEFAULT_MARKERS):
                return (
                    f"BLOCKED: {candidate} still has the default Next.js starter content "
                    f"(found default marker).\n"
                    f"You MUST overwrite it with the real landing page that imports and "
                    f"renders your components before launching the dev server.\n"
                    f"Call create_file('{candidate}', <full page content>) now."
                )
    return None



@tool
def run_command(command: str, timeout: int = 300) -> str:
    """Execute a shell command and return its output (stdout + stderr).
    Always runs in the current working directory.
    Long-running server commands (streamlit, uvicorn, etc.) are launched in the background.
    Re-launching an already-running server is a no-op.

    IMPORTANT: cd inside a command has no persistent effect — the cwd never changes
    between tool calls. Always use full relative paths in subsequent file operations."""
    cwd = os.getcwd()
    command = _normalize_paths(command, cwd)
    logger.info("run_command: %s (cwd=%s)", command, cwd)
    try:
        if _is_server_command(command):
            # Hard gate: refuse to launch if page.tsx still has default content
            page_error = _check_nextjs_page(command, cwd)
            if page_error:
                logger.warning("Blocked server launch — page.tsx not updated: %s", command)
                return page_error

            with _servers_lock:
                existing = _running_servers.get(command)
                if existing is not None and existing.poll() is None:
                    logger.info("Server already running (pid=%d): %s", existing.pid, command)
                    return f"Server is already running (pid={existing.pid}): `{command}`"

                proc = subprocess.Popen(command, shell=True, cwd=cwd)
                _running_servers[command] = proc
            logger.info("Server launched in background (pid=%d): %s", proc.pid, command)
            log_action("SERVER", f"{command[:80]} (pid={proc.pid})")
            return f"Server started in background (pid={proc.pid}): `{command}`"

        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=cwd,
        )

        stdout_lines: list[str] = []
        stderr_lines: list[str] = []
        last_line: list[str] = [""]

        def _read(stream, lines, style):
            for raw in stream:
                line = raw.rstrip("\n")
                lines.append(line)
                last_line[0] = line
                _live.console.print(line, style=style, markup=False)

        timed_out = False
        start = time.time()

        try:
            with Live(console=_console, refresh_per_second=12, transient=False) as live:
                _live = live  # noqa: F841 — used via closure in _read

                t_out = threading.Thread(target=_read, args=(process.stdout, stdout_lines, ""))
                t_err = threading.Thread(target=_read, args=(process.stderr, stderr_lines, "dim red"))
                t_out.start()
                t_err.start()

                while process.poll() is None:
                    elapsed = time.time() - start
                    if elapsed >= timeout:
                        process.kill()
                        process.wait()
                        timed_out = True
                        break
                    live.update(_make_spinner(command, elapsed, last_line[0]))
                    time.sleep(0.08)
                elapsed = time.time() - start
                live.update(_make_spinner(command, elapsed, last_line[0]))

                t_out.join()
                t_err.join()
        except Exception:
            process.kill()
            process.wait()
            raise

        if timed_out:
            logger.error("Command timed out after %ds: %s", timeout, command)
            return f"Command timed out after {timeout}s."

        output = "\n".join(stdout_lines)
        if stderr_lines:
            output += "\n[stderr]\n" + "\n".join(stderr_lines)
        if process.returncode != 0:
            logger.warning("Command exited with code %d: %s", process.returncode, command)
            output += f"\n[exit code: {process.returncode}]"
            # Log first error lines so the agent knows WHY it failed
            error_lines = [l for l in (stderr_lines or stdout_lines) if l.strip()][:3]
            error_hint = " | ".join(error_lines)[:120] if error_lines else ""
            log_action("CMD_FAIL", f"{command[:60]} (exit={process.returncode}){' → ' + error_hint if error_hint else ''}")
        else:
            logger.info("Command succeeded: %s", command)
            log_action("CMD_OK", command[:80])

        output = output.strip() or "(no output)"

        # --- Collapse noisy repeated lines before truncation ---
        output = _collapse_noise(output)

        # --- Smart truncation to protect LLM context window ---
        _MAX_OUTPUT_CHARS = 3000

        # Detect HTML/JSON blob responses (e.g. curl -s http://...)
        # and replace them with just the first line + size info.
        _lower = output[:200].lower()
        if _lower.startswith("<!doctype") or _lower.startswith("<html") or (
            output.startswith("{") and len(output) > _MAX_OUTPUT_CHARS
        ):
            first_line = output.splitlines()[0][:120]
            output = (
                f"{first_line}\n"
                f"... (HTML/JSON response truncated — {len(output)} chars total) ...\n"
                f"Tip: use `curl -s -o /dev/null -w \"%{{http_code}}\"` to check status only."
            )

        elif len(output) > _MAX_OUTPUT_CHARS:
            lines = output.splitlines()
            head = "\n".join(lines[:5])
            tail = "\n".join(lines[-20:])
            omitted = max(0, len(lines) - 25)
            truncated = f"{head}\n... ({omitted} lines omitted) ...\n{tail}"
            # Hard cap: if lines are long, cut at _MAX_OUTPUT_CHARS
            if len(truncated) > _MAX_OUTPUT_CHARS:
                truncated = truncated[:_MAX_OUTPUT_CHARS] + f"\n... (truncated at {_MAX_OUTPUT_CHARS} chars)"
            output = truncated

        # Remind the model that cwd is fixed only when cd was used
        if re.search(r'\bcd\b', command, re.IGNORECASE):
            output += f"\n[cwd: {cwd}]"

        return output
    except Exception as e:
        logger.error("Command error: %s | %s", command, e)
        return f"Error executing command: {e}"