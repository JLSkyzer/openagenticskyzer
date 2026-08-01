# openagenticskyzer/tools/git_tools.py
"""Outils git pour l'agent — workflow git complet."""
import os
import subprocess
from langchain_core.tools import tool


def _cwd() -> str | None:
    from openagenticskyzer.app.state import state
    return state.active_folder


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
    cmd = ["git", "diff"] + ([file] if file else [])
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
    cmd.append(file)
    return _run(cmd, _cwd())


@tool
def git_branch_list() -> str:
    """List all local and remote branches."""
    return _run(["git", "branch", "-a"], _cwd())


@tool
def git_add(files: str) -> str:
    """Stage files for commit. files can be '.' for all, or space-separated paths."""
    files_list = files.split() if files != "." else ["."]
    return _run(["git", "add"] + files_list, _cwd())


@tool
def git_commit(message: str, files: str = "") -> str:
    """Commit staged changes with a message. Optionally stage specific files first."""
    cwd = _cwd()
    if files:
        stage_result = _run(["git", "add"] + files.split(), cwd)
        if stage_result.startswith("Error"):
            return stage_result
    return _run(["git", "commit", "-m", message], cwd)


@tool
def git_push(remote: str = "origin", branch: str = "") -> str:
    """Push commits to remote. Defaults to origin and current branch."""
    cmd = ["git", "push", remote] + ([branch] if branch else [])
    return _run(cmd, _cwd())


@tool
def git_pull(remote: str = "origin") -> str:
    """Pull latest changes from remote."""
    return _run(["git", "pull", remote], _cwd())


@tool
def git_checkout(branch: str) -> str:
    """Switch to a branch or restore a file."""
    return _run(["git", "checkout", branch], _cwd())


@tool
def git_create_branch(name: str, from_branch: str = "") -> str:
    """Create and switch to a new branch. Optionally based on another branch."""
    cmd = ["git", "checkout", "-b", name] + ([from_branch] if from_branch else [])
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
