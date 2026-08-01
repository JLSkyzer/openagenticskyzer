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
