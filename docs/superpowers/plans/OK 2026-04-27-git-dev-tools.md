# Git Tools + Widget Sidebar — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner à l'agent un workflow git complet (status, diff, commit, push, pull, log, blame, branches, stash) et afficher la branche + état dirty/clean dans la sidebar (Phase 2.1).

**Architecture:** Nouveau fichier `tools/git_tools.py` avec 14 outils LangChain `@tool`. Chaque outil utilise `subprocess.run(["git", ...], cwd=state.active_folder)`. Les outils destructifs (commit, push, checkout) sont gatés par le système de permissions existant. Le prompt est mis à jour avec la section GIT.

**Tech Stack:** Python 3.11+, subprocess, LangChain `@tool`, pytest, unittest.mock

---

## Structure des fichiers

| Fichier | Action | Rôle |
|---------|--------|------|
| `openagenticskyzer/tools/git_tools.py` | Créer | 14 outils git |
| `openagenticskyzer/agent.py` | Modifier | Ajouter git tools à `_ALL_TOOLS` |
| `openagenticskyzer/permissions.py` | Modifier | Ajouter outils git destructifs à `_RESTRICTED_TOOLS` |
| `openagenticskyzer/prompts/prompt.py` | Modifier | Ajouter section GIT dans TOOLS |
| `openagenticskyzer/app/components/sidebar.py` | Modifier | Widget branche git |
| `tests/test_git_tools.py` | Créer | Tests outils git |

---

## Task 1 : Créer `tools/git_tools.py`

**Files:**
- Create: `openagenticskyzer/tools/git_tools.py`
- Test: `tests/test_git_tools.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_git_tools.py
"""Tests des outils git — utilise un dépôt git temporaire."""
import subprocess
import pytest
from pathlib import Path
from unittest.mock import patch


@pytest.fixture
def git_repo(tmp_path):
    """Crée un vrai dépôt git temporaire."""
    subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=tmp_path, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, capture_output=True)
    (tmp_path / "README.md").write_text("# Test", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=tmp_path, capture_output=True)
    return tmp_path


def _with_folder(folder: str):
    """Patch state.active_folder."""
    from unittest.mock import patch
    return patch("openagenticskyzer.app.state.state.active_folder", folder)


class TestGitStatus:
    def test_clean_repo(self, git_repo):
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_status
            result = git_status.invoke({})
        assert "clean" in result.lower() or result == "Working tree clean."

    def test_dirty_repo(self, git_repo):
        (git_repo / "new_file.txt").write_text("hello")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_status
            result = git_status.invoke({})
        assert "new_file.txt" in result or "??" in result


class TestGitLog:
    def test_shows_commits(self, git_repo):
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_log
            result = git_log.invoke({"n": 5})
        assert "initial" in result

    def test_no_folder_returns_error(self):
        with _with_folder(""):
            from openagenticskyzer.tools.git_tools import git_log
            result = git_log.invoke({"n": 5})
        assert "Error" in result or "dossier" in result.lower()


class TestGitDiff:
    def test_no_changes_empty(self, git_repo):
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_diff
            result = git_diff.invoke({})
        assert result == "" or "No changes" in result or len(result) == 0

    def test_shows_diff_for_modified_file(self, git_repo):
        (git_repo / "README.md").write_text("# Modified", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_diff
            result = git_diff.invoke({})
        assert "README.md" in result or "Modified" in result


class TestGitBranchList:
    def test_shows_main_branch(self, git_repo):
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_branch_list
            result = git_branch_list.invoke({})
        assert "main" in result or "master" in result
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_git_tools.py -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Créer `tools/git_tools.py`**

```python
# openagenticskyzer/tools/git_tools.py
"""Outils git pour l'agent — workflow git complet."""
import subprocess
from langchain_core.tools import tool


def _cwd() -> str:
    from openagenticskyzer.app.state import state
    return state.active_folder or "."


def _run(cmd: list[str], cwd: str | None = None) -> str:
    if not cwd:
        return "Error: Aucun dossier actif. Ouvre un dossier d'abord."
    try:
        r = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", timeout=15,
            creationflags=0x08000000 if __import__("os").name == "nt" else 0,
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
    return result if result != "OK (pas de sortie)" else "Working tree clean."


@tool
def git_diff(file: str = "") -> str:
    """Show unstaged changes. Optionally pass a specific file path."""
    cmd = ["git", "diff"] + ([file] if file else [])
    return _run(cmd, _cwd()) or "Aucune modification non-stagée."


@tool
def git_diff_staged() -> str:
    """Show staged changes (ready to commit)."""
    return _run(["git", "diff", "--staged"], _cwd()) or "Aucune modification stagée."


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
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

```
pytest tests/test_git_tools.py -v
```
Attendu : tous PASS

- [ ] **Step 5 : Commit**

```bash
git add openagenticskyzer/tools/git_tools.py tests/test_git_tools.py
git commit -m "feat: add 14 git tools for agent (Phase 2.1)"
```

---

## Task 2 : Intégrer dans `agent.py`, `permissions.py`, `prompt.py`

**Files:**
- Modify: `openagenticskyzer/agent.py`
- Modify: `openagenticskyzer/permissions.py`
- Modify: `openagenticskyzer/prompts/prompt.py`

- [ ] **Step 1 : Ajouter les imports et tools dans `agent.py`**

```python
# Ajouter après les imports existants
from openagenticskyzer.tools.git_tools import (
    git_status, git_diff, git_diff_staged, git_log, git_blame,
    git_branch_list, git_add, git_commit, git_push, git_pull,
    git_checkout, git_create_branch, git_stash, git_stash_pop,
)

# Dans _ALL_TOOLS, ajouter :
_ALL_TOOLS = [
    # ... outils existants ...
    git_status, git_diff, git_diff_staged, git_log, git_blame,
    git_branch_list, git_add, git_commit, git_push, git_pull,
    git_checkout, git_create_branch, git_stash, git_stash_pop,
]
```

- [ ] **Step 2 : Ajouter les outils destructifs dans `permissions.py`**

Trouver `_RESTRICTED_TOOLS` (ou équivalent) dans `permissions.py` et ajouter :

```python
_RESTRICTED_TOOLS = {
    # ... existants ...
    "git_commit", "git_push", "git_pull", "git_checkout",
    "git_create_branch", "git_stash_pop", "git_add",
}
```

- [ ] **Step 3 : Mettre à jour le prompt dans `prompt.py`**

Dans `DEEP_AGENT_SYSTEM_PROMPT`, trouver la section `TOOLS:` et ajouter :

```
GIT: git_status | git_diff([file]) | git_diff_staged | git_log([n]) | git_blame(file,[start],[end])
     git_add(files) | git_commit(message,[files]) | git_push([remote],[branch]) | git_pull([remote])
     git_branch_list | git_checkout(branch) | git_create_branch(name,[from]) | git_stash([msg]) | git_stash_pop
WORKFLOW GIT STANDARD: git_status → git_diff → git_add → git_commit → git_push
```

- [ ] **Step 4 : Commit**

```bash
git add openagenticskyzer/agent.py openagenticskyzer/permissions.py openagenticskyzer/prompts/prompt.py
git commit -m "feat: integrate git tools into agent + permissions + prompt (Phase 2.1)"
```

---

## Task 3 : Widget branche git dans la sidebar

**Files:**
- Modify: `openagenticskyzer/app/components/sidebar.py`

- [ ] **Step 1 : Lire `sidebar.py` pour localiser le bon endroit**

```
Read openagenticskyzer/app/components/sidebar.py
```
Repérer la fin du rendu de la sidebar (après la liste des dossiers).

- [ ] **Step 2 : Ajouter le widget git**

À la fin de la fonction de rendu de la sidebar, ajouter :

```python
def _git_branch_widget():
    """Affiche la branche courante + statut dirty/clean si dossier git."""
    import subprocess
    if not state.active_folder:
        return
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=state.active_folder, capture_output=True,
            text=True, encoding="utf-8", timeout=3,
            creationflags=0x08000000 if __import__("os").name == "nt" else 0,
        )
        if r.returncode != 0:
            return
        branch = r.stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=state.active_folder, capture_output=True,
            text=True, encoding="utf-8", timeout=3,
            creationflags=0x08000000 if __import__("os").name == "nt" else 0,
        ).stdout.strip()
        label = f"⎇ {branch}" + (" ●" if dirty else " ✓")
        color = "text-yellow-400" if dirty else "text-green-400"
        ui.label(label).classes(f"text-xs {color} px-3 py-1 font-mono")
    except Exception:
        pass
```

Appeler `_git_branch_widget()` dans le rendu de la sidebar.

- [ ] **Step 3 : Commit**

```bash
git add openagenticskyzer/app/components/sidebar.py
git commit -m "feat: add git branch status widget in sidebar (Phase 2.1)"
```
