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
        assert result == "No changes."

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


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    """Run a real git command against the fixture repo, for setup/verification
    that shouldn't go through the tool under test."""
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)


def _current_branch(repo: Path) -> str:
    return _git(repo, "branch", "--show-current").stdout.strip()


class TestGitDiffStaged:
    def test_no_staged_changes(self, git_repo):
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_diff_staged
            result = git_diff_staged.invoke({})
        assert result == "No changes (staged)."

    def test_shows_staged_diff(self, git_repo):
        (git_repo / "README.md").write_text("# Staged change", encoding="utf-8")
        _git(git_repo, "add", "README.md")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_diff_staged
            result = git_diff_staged.invoke({})
        assert "README.md" in result or "Staged change" in result


class TestGitAdd:
    def test_stages_a_new_file(self, git_repo):
        (git_repo / "new_file.txt").write_text("hello", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_add
            git_add.invoke({"files": "new_file.txt"})
        status = _git(git_repo, "status", "--short").stdout
        assert "new_file.txt" in status
        # Staged (index) entries are prefixed in column 1, e.g. "A  new_file.txt".
        assert status.strip().startswith("A")

    def test_stages_all_with_dot(self, git_repo):
        (git_repo / "a.txt").write_text("a", encoding="utf-8")
        (git_repo / "b.txt").write_text("b", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_add
            git_add.invoke({"files": "."})
        status = _git(git_repo, "status", "--short").stdout
        assert "a.txt" in status and "b.txt" in status
        assert "??" not in status  # nothing left untracked/unstaged

    def test_stages_quoted_path_with_spaces(self, git_repo):
        (git_repo / "my file.txt").write_text("hi", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_add
            git_add.invoke({"files": '"my file.txt"'})
        status = _git(git_repo, "status", "--short").stdout
        assert "my file.txt" in status
        assert status.strip().startswith("A")

    def test_dash_prefixed_filename_is_staged_not_parsed_as_flag(self, git_repo):
        """Regression test for argument-injection fix: a filename starting
        with '-' must be treated as a pathspec (via the '--' separator),
        never as a git-add option."""
        (git_repo / "-weird.txt").write_text("hi", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_add
            result = git_add.invoke({"files": "-weird.txt"})
        assert not result.startswith("Error")
        status = _git(git_repo, "status", "--short").stdout
        assert "-weird.txt" in status
        assert status.strip().startswith("A")


class TestGitCommit:
    def test_commits_already_staged_changes(self, git_repo):
        (git_repo / "README.md").write_text("# Changed", encoding="utf-8")
        _git(git_repo, "add", "README.md")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_commit
            result = git_commit.invoke({"message": "update readme"})
        assert not result.startswith("Error")
        log = _git(git_repo, "log", "--oneline").stdout
        assert "update readme" in log
        # working tree is clean again after commit
        assert _git(git_repo, "status", "--short").stdout.strip() == ""

    def test_commits_with_files_param_stages_first(self, git_repo):
        (git_repo / "new_file.txt").write_text("hello", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_commit
            result = git_commit.invoke({"message": "add new file", "files": "new_file.txt"})
        assert not result.startswith("Error")
        log = _git(git_repo, "log", "--oneline").stdout
        assert "add new file" in log
        show = _git(git_repo, "show", "--stat", "HEAD").stdout
        assert "new_file.txt" in show

    def test_commits_with_quoted_spaced_file_param(self, git_repo):
        (git_repo / "spaced file.txt").write_text("hi", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_commit
            result = git_commit.invoke({"message": "add spaced file", "files": '"spaced file.txt"'})
        assert not result.startswith("Error")
        show = _git(git_repo, "show", "--stat", "HEAD").stdout
        assert "spaced file.txt" in show


class TestGitCheckout:
    def test_switches_to_existing_branch(self, git_repo):
        original = _current_branch(git_repo)
        _git(git_repo, "checkout", "-b", "feature")
        _git(git_repo, "checkout", original)
        assert _current_branch(git_repo) == original
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_checkout
            result = git_checkout.invoke({"branch": "feature"})
        assert not result.startswith("Error")
        assert _current_branch(git_repo) == "feature"

    def test_dash_prefixed_branch_is_not_parsed_as_flag(self, git_repo):
        """Regression test for argument-injection fix: a value starting with
        '-' (e.g. an attempted '-f'/force injection) must not be executed as
        a git-checkout option — it should fail as an unknown pathspec instead."""
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_checkout
            result = git_checkout.invoke({"branch": "-f"})
        assert result.startswith("Error")
        assert "did not match" in result or "pathspec" in result.lower()


class TestGitCreateBranch:
    def test_creates_and_switches_to_new_branch(self, git_repo):
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_create_branch
            result = git_create_branch.invoke({"name": "newbranch"})
        assert not result.startswith("Error")
        assert _current_branch(git_repo) == "newbranch"
        branches = _git(git_repo, "branch").stdout
        assert "newbranch" in branches

    def test_creates_from_specific_start_point(self, git_repo):
        original = _current_branch(git_repo)
        _git(git_repo, "checkout", "-b", "base")
        (git_repo / "base_only.txt").write_text("x", encoding="utf-8")
        _git(git_repo, "add", "base_only.txt")
        _git(git_repo, "commit", "-m", "base commit")
        _git(git_repo, "checkout", original)
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_create_branch
            result = git_create_branch.invoke({"name": "derived", "from_branch": "base"})
        assert not result.startswith("Error")
        assert _current_branch(git_repo) == "derived"
        assert (git_repo / "base_only.txt").exists()


class TestGitStash:
    def test_stash_cleans_working_tree_and_pop_restores_it(self, git_repo):
        (git_repo / "README.md").write_text("# Stashed change", encoding="utf-8")
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_stash, git_stash_pop
            stash_result = git_stash.invoke({"message": "wip"})
            assert not stash_result.startswith("Error")
            assert _git(git_repo, "status", "--short").stdout.strip() == ""
            assert (git_repo / "README.md").read_text(encoding="utf-8") == "# Test"

            pop_result = git_stash_pop.invoke({})
            assert not pop_result.startswith("Error")
        assert (git_repo / "README.md").read_text(encoding="utf-8") == "# Stashed change"


class TestGitBlame:
    def test_shows_author_for_committed_line(self, git_repo):
        with _with_folder(str(git_repo)):
            from openagenticskyzer.tools.git_tools import git_blame
            result = git_blame.invoke({"file": "README.md"})
        assert not result.startswith("Error")
        assert "Test" in result  # author name set in the git_repo fixture
