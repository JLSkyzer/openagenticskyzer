import fnmatch
import logging
import os
import re

from langchain_core.tools import tool

from openagentic_ai.context.session_log import log_action
from openagentic_ai.utils.loop_detector import check_loop

logger = logging.getLogger("openagent.file-ops")

_MAX_OUTPUT_TOKENS = 25_000  # ~100k chars approximation (1 token ≈ 4 chars)
_MAX_OUTPUT_CHARS = _MAX_OUTPUT_TOKENS * 4


def _truncate(text: str, total_lines: int) -> tuple[str, bool]:
    if len(text) <= _MAX_OUTPUT_CHARS:
        return text, False
    truncated = text[:_MAX_OUTPUT_CHARS]
    # Cut at last newline to avoid broken lines
    cut = truncated.rfind("\n")
    if cut > 0:
        truncated = truncated[:cut]
    shown = truncated.count("\n") + 1
    return truncated + f"\n... [truncated — showing {shown}/{total_lines} lines]", True


class _OutsideCWDError(ValueError):
    pass


def _safe_path(path: str) -> str:
    """Resolve path relative to cwd and ensure it stays inside cwd.
    Raises _OutsideCWDError for absolute paths outside cwd or ../ traversal."""
    cwd = os.path.realpath(os.getcwd())
    if os.path.isabs(path):
        resolved = os.path.realpath(path)
        if not (resolved.startswith(cwd + os.sep) or resolved == cwd):
            raise _OutsideCWDError(
                f"Path '{path}' is outside the working directory '{cwd}'. "
                "All file operations must stay inside the current working directory. "
                "Use relative paths or create files/folders inside the cwd."
            )
    else:
        resolved = os.path.realpath(os.path.join(cwd, path))
        if not (resolved.startswith(cwd + os.sep) or resolved == cwd):
            raise _OutsideCWDError(
                f"Path traversal blocked: '{path}' escapes the working directory '{cwd}'."
            )
    return resolved


@tool
def create_file(path: str, content: str = "") -> str:
    """Create a file at the given path with optional content. Paths are always resolved inside the current working directory."""
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("create_file: %s", safe)
    parent = os.path.dirname(safe)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(safe, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    lines = content.splitlines()
    total = len(lines)
    rel = os.path.relpath(safe, os.getcwd())
    log_action("CREATE", f"{rel} ({total} lines)")
    preview_lines = lines[:5]
    preview = "\n".join(f"{i+1:4} | {l}" for i, l in enumerate(preview_lines))
    suffix = f"\n     ... ({total - 5} more lines)" if total > 5 else ""
    return f"File created at {safe} ({total} lines).\n--- First lines ---\n{preview}{suffix}"

@tool
def view_file(path: str) -> str:
    """Return metadata about a file: total lines, size, and a short preview.
    Use this before read_file to decide which lines you need."""
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("view_file: %s", safe)
    if not os.path.exists(safe):
        return f"File {safe} not found."
    if not os.path.isfile(safe):
        return f"{safe} is not a file."
    size = os.path.getsize(safe)
    try:
        with open(safe, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except UnicodeDecodeError:
        return f"File: {safe}\nSize: {size} bytes\nContent: binary (cannot preview)"
    total = len(lines)
    preview = "".join(lines[:10])
    return (
        f"File: {safe}\n"
        f"Size: {size} bytes\n"
        f"Total lines: {total}\n"
        f"--- First 10 lines ---\n{preview}"
    )

@tool
def read_file(path: str, offset: int = 1, limit: int | None = None) -> str:
    """Read the content of a text file with line numbers.

    Args:
        path: Path to the file.
        offset: Line number to start reading from (1-based, default 1).
        limit: Maximum number of lines to read. If omitted, reads the whole file
               (capped at 25 000 tokens automatically).

    For large files, use view_file first to get the total line count, then call
    read_file with offset+limit to read only the section you need.
    """
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("read_file: %s offset=%s limit=%s", safe, offset, limit)
    if warning := check_loop("read_file", f"{safe}:{offset}:{limit}"):
        return warning
    if not os.path.exists(safe):
        return f"File {safe} not found. Do NOT retry read_file — use create_file to create it first."
    try:
        with open(safe, "r", encoding="utf-8") as f:
            all_lines = f.readlines()
    except UnicodeDecodeError:
        return f"File {safe} is binary and cannot be read as text."

    total = len(all_lines)
    start = max(0, (offset or 1) - 1)
    end = min(start + limit, total) if limit is not None else total
    selected = all_lines[start:end]

    formatted = "".join(f"{start + i + 1:6}|{line}" for i, line in enumerate(selected))

    header = ""
    if start > 0 or end < total:
        header = f"Showing lines {start + 1}-{end} of {total}\n\n"

    output, _ = _truncate(formatted, total)
    return header + output

@tool
def edit_file(path: str, old_string: str, new_string: str) -> str:
    """Replace old_string with new_string in the specified file."""
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("edit_file: %s", safe)
    if warning := check_loop("edit_file", f"{safe}:{old_string[:60]}"):
        return warning
    if not os.path.exists(safe):
        return f"File {safe} not found."
    with open(safe, "r", encoding="utf-8", newline="") as f:
        content = f.read()
    if old_string not in content:
        return f"String not found in {safe}. Read the file first to get the exact current content."
    new_content = content.replace(old_string, new_string, 1)
    with open(safe, "w", encoding="utf-8", newline="") as f:
        f.write(new_content)
    rel = os.path.relpath(safe, os.getcwd())
    old_preview = old_string.strip().splitlines()[0][:60]
    new_preview = new_string.strip().splitlines()[0][:60]
    log_action("EDIT", f"{rel} | -{old_preview!r} +{new_preview!r}")
    # Show context around the edit: find the changed line(s)
    new_lines = new_content.splitlines()
    old_lines = content.splitlines()
    changed = [i for i, (a, b) in enumerate(zip(old_lines, new_lines)) if a != b]
    if not changed:
        changed = list(range(min(3, len(new_lines))))
    mid = changed[0]
    start = max(0, mid - 1)
    end = min(len(new_lines), mid + len(new_string.splitlines()) + 1)
    context = "\n".join(f"{i+1:4} | {new_lines[i]}" for i in range(start, end))
    return f"File {safe} edited ({len(new_lines)} lines total).\n--- Around edit (lines {start+1}-{end}) ---\n{context}"

@tool
def delete_file(path: str) -> str:
    """Delete a file at the given path."""
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("delete_file: %s", safe)
    if not os.path.exists(safe):
        return f"File {safe} not found."
    rel = os.path.relpath(safe, os.getcwd())
    os.remove(safe)
    log_action("DELETE", rel)
    return f"File {safe} deleted."

@tool
def grep_file(path: str, pattern: str) -> str:
    """Search for a literal string in a file and return matching lines (case-sensitive, not regex)."""
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("grep_file: %s | pattern=%r", safe, pattern)
    if not os.path.exists(safe):
        return f"File {safe} not found."
    results = []
    with open(safe, "r", encoding="utf-8") as f:
        for i, line in enumerate(f, start=1):
            if pattern in line:
                results.append(f"Line {i}: {line.strip()}")
    return "\n".join(results) if results else f"No matches for '{pattern}'."

@tool
def list_dir(path: str = ".") -> str:
    """List the contents of a directory."""
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("list_dir: %s", safe)
    if not os.path.exists(safe):
        return f"Directory {safe} not found."
    return "\n".join(os.listdir(safe))

@tool
def create_dir(path: str) -> str:
    """Create a directory at the given path."""
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("create_dir: %s", safe)
    os.makedirs(safe, exist_ok=True)
    log_action("MKDIR", os.path.relpath(safe, os.getcwd()))
    return f"Directory created at {safe}."

@tool
def glob_files(pattern: str, path: str = ".") -> str:
    """Find files matching a glob pattern inside a directory.

    Args:
        pattern: Glob pattern, e.g. '**/*.py' or 'src/**/*.ts'.
        path: Root directory to search in (default: current working directory).

    Returns a newline-separated list of matching relative file paths, sorted by name.
    """
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("glob_files: pattern=%r root=%s", pattern, safe)
    if not os.path.isdir(safe):
        return f"Directory {safe} not found."

    matches = []
    for root, dirs, files in os.walk(safe):
        # Skip hidden directories
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", ".git", "dist", ".next", "build", "venv", ".venv", "env")]
        for fname in files:
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, safe).replace("\\", "/")
            if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(fname, pattern.split("/")[-1]):
                matches.append(rel)

    if not matches:
        return f"No files found matching '{pattern}' in {safe}."
    matches.sort()
    return "\n".join(matches) + f"\n\n{len(matches)} file(s) found."


@tool
def grep_codebase(pattern: str, path: str = ".", file_glob: str = "*") -> str:
    """Search for a regex pattern across all files in a directory tree.

    Args:
        pattern: Regular expression to search for (case-insensitive).
        path: Root directory to search in (default: current working directory).
        file_glob: Only search files matching this glob, e.g. '*.py' or '*.ts' (default: all files).

    Returns matching lines with file path and line number, capped at 200 matches.
    """
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("grep_codebase: pattern=%r root=%s glob=%s", pattern, safe, file_glob)
    if not os.path.isdir(safe):
        return f"Directory {safe} not found."

    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        return f"Invalid regex pattern: {e}"

    results = []
    for root, dirs, files in os.walk(safe):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__", ".git", "dist", ".next", "build", "venv", ".venv", "env")]
        for fname in files:
            if not fnmatch.fnmatch(fname, file_glob):
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, safe).replace("\\", "/")
            try:
                with open(full, "r", encoding="utf-8", errors="ignore") as f:
                    for i, line in enumerate(f, start=1):
                        if rx.search(line):
                            results.append(f"{rel}:{i}: {line.rstrip()}")
                            if len(results) >= 200:
                                results.append("... [capped at 200 matches]")
                                return "\n".join(results)
            except OSError:
                continue

    if not results:
        return f"No matches for '{pattern}' in {safe}."
    return "\n".join(results) + f"\n\n{len(results)} match(es)."


@tool
def delete_dir(path: str) -> str:
    """Delete a directory at the given path (including its contents)."""
    import shutil
    try:
        safe = _safe_path(path)
    except _OutsideCWDError as e:
        return str(e)
    logger.info("delete_dir: %s", safe)
    if safe == os.path.realpath(os.getcwd()):
        return "Cannot delete the current working directory."
    if not os.path.exists(safe):
        return f"Directory {safe} not found."
    shutil.rmtree(safe)
    return f"Directory {safe} deleted."
