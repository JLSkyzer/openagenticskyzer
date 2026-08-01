# openagenticskyzer/tools/git_tools.py
"""Outils git pour l'agent — workflow git complet."""
import os
import shlex
import subprocess
from langchain_core.tools import tool


def _cwd() -> str | None:
    from openagenticskyzer.app.state import state
    return state.active_folder


def _guarded(*args: str) -> list[str]:
    """Argv tokens for one or more caller-supplied positional values (ref,
    branch, remote, ...).

    Prepends a single literal '--' when any value starts with '-', so none
    of them can ever be parsed as a git option (e.g. branch="--orphan" or
    remote="-f"). Valid git ref/branch/remote names can never start with
    '-' (git-check-ref-format rejects it for refs, and no real remote is
    ever configured that way), so this never changes behavior for
    legitimate input — it only forces a dash-prefixed string down the safe
    "unknown pathspec"/positional-arg path instead of being executed as a
    flag. Only one '--' is ever inserted (not one per guarded value),
    because a second literal '--' among already-positional arguments would
    itself be parsed as a literal argument rather than a separator."""
    guard = ["--"] if any(a.startswith("-") for a in args) else []
    return guard + list(args)


def _split_files(files: str) -> list[str]:
    """Split a caller-supplied 'files' argument into individual pathspecs.

    Supports quoting a path that contains spaces (e.g. '"my file.txt"').
    shlex.split() runs in POSIX mode, where backslash is an escape
    character — on this Windows-targeted app that would silently mangle
    native paths like 'C:\\Users\\test\\file.py' into 'C:Userstestfile.py'.
    Backslashes are normalized to forward slashes first (git and Windows
    both accept forward-slash paths interchangeably) so shlex never sees
    them as escapes, then the quoted-spaces case still works correctly."""
    return shlex.split(files.replace("\\", "/"))


def _run(cmd: list[str], cwd: str | None = None) -> str:
    if not cwd:
        return "Error: Aucun dossier actif. Ouvre un dossier d'abord."
    try:
        r = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", timeout=15,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        out = r.stdout.strip()
        err = r.stderr.strip()
        if r.returncode != 0:
            return f"Error: {err or out or 'commande échouée'}"
        return out or "OK (pas de sortie)"
    except subprocess.TimeoutExpired:
        return "Error: timeout (>15s)"
    except FileNotFoundError:
        return "Error: git non trouvé. Installez git."


@tool
def git_status() -> str:
    """Show git working tree status (branch, modified, untracked files)."""
    cwd = _cwd()
    result = _run(["git", "status", "--short", "--branch"], cwd)
    if result.startswith("Error"):
        return result
    # "--short --branch" always prints the branch header line, even on a
    # clean tree, so an empty-output sentinel never fires here — detect
    # "clean" by counting lines instead (1 line == just the branch header).
    lines = result.splitlines()
    if len(lines) <= 1:
        header = lines[0] if lines and result != "OK (pas de sortie)" else ""
        return f"{header}\nWorking tree clean." if header else "Working tree clean."
    return result


@tool
def git_diff(file: str = "") -> str:
    """Show unstaged changes. Optionally pass a specific file path."""
    # '--' always precedes the pathspec so a value starting with '-' can
    # never be misparsed as a git-diff option.
    cmd = ["git", "diff"] + (["--", file] if file else [])
    result = _run(cmd, _cwd())
    if result.startswith("Error"):
        return result
    return "No changes." if result == "OK (pas de sortie)" else result


@tool
def git_diff_staged() -> str:
    """Show staged changes (ready to commit)."""
    result = _run(["git", "diff", "--staged"], _cwd())
    if result.startswith("Error"):
        return result
    return "No changes (staged)." if result == "OK (pas de sortie)" else result


@tool
def git_log(n: int = 10, oneline: bool = True) -> str:
    """Show commit history. n=number of commits, oneline=compact format."""
    fmt = ["--oneline"] if oneline else ["--format=%h %an %ar%n%s%n"]
    return _run(["git", "log", f"-{n}"] + fmt, _cwd())


@tool
def git_blame(file: str, start: int = 1, end: int = 0) -> str:
    """Show who last modified each line of a file. start/end are line numbers (0=all)."""
    cmd = ["git", "blame"]
    if end > 0:
        cmd += [f"-L {start},{end}"]
    # '--' forces the trailing argument to be treated as a pathspec, never a flag.
    cmd += ["--", file]
    return _run(cmd, _cwd())


@tool
def git_branch_list() -> str:
    """List all local and remote branches."""
    return _run(["git", "branch", "-a"], _cwd())


@tool
def git_add(files: str) -> str:
    """Stage files for commit. files can be '.' for all, or space-separated paths
    (quote individual paths that contain spaces, e.g. '"my file.txt" other.txt')."""
    files_list = _split_files(files)
    # '--' always precedes the pathspecs so a value starting with '-' can
    # never be misparsed as a git-add option.
    return _run(["git", "add", "--"] + files_list, _cwd())


@tool
def git_commit(message: str, files: str = "") -> str:
    """Commit staged changes with a message. Optionally stage specific files first
    (quote individual paths that contain spaces)."""
    cwd = _cwd()
    if files:
        stage_result = _run(["git", "add", "--"] + _split_files(files), cwd)
        if stage_result.startswith("Error"):
            return stage_result
    return _run(["git", "commit", "-m", message], cwd)


@tool
def git_push(remote: str = "origin", branch: str = "") -> str:
    """Push commits to remote. Defaults to origin and current branch."""
    positional = [remote] + ([branch] if branch else [])
    return _run(["git", "push"] + _guarded(*positional), _cwd())


@tool
def git_pull(remote: str = "origin") -> str:
    """Pull latest changes from remote."""
    return _run(["git", "pull", remote], _cwd())


@tool
def git_checkout(branch: str) -> str:
    """Switch to a branch or restore a file."""
    # `git checkout <arg>` is intentionally ambiguous (branch-or-path), so we
    # can't unconditionally prepend '--' without breaking normal branch
    # switches (see _guarded's docstring) — only guard dash-prefixed values,
    # which are never valid branch/file names to begin with.
    return _run(["git", "checkout"] + _guarded(branch), _cwd())


@tool
def git_create_branch(name: str, from_branch: str = "") -> str:
    """Create and switch to a new branch. Optionally based on another branch."""
    # `name` is safe as-is: it's always consumed as -b's immediate value,
    # and git rejects dash-prefixed ref names outright. `from_branch` is a
    # trailing positional and must be guarded against flag injection.
    cmd = ["git", "checkout", "-b", name] + (_guarded(from_branch) if from_branch else [])
    return _run(cmd, _cwd())


@tool
def git_stash(message: str = "") -> str:
    """Stash current changes. Optionally give the stash a name."""
    cmd = ["git", "stash", "push"] + (["-m", message] if message else [])
    return _run(cmd, _cwd())


@tool
def git_stash_pop() -> str:
    """Apply the most recent stash and remove it from the stash list."""
    return _run(["git", "stash", "pop"], _cwd())
