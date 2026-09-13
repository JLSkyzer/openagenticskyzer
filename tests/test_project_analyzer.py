"""Tests comportementaux de l'analyse automatique de stack projet."""
from pathlib import Path

import pytest


@pytest.fixture
def python_project(tmp_path: Path) -> Path:
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname = 'myapp'\n", encoding="utf-8"
    )
    (tmp_path / "main.py").write_text("print('hello')", encoding="utf-8")
    (tmp_path / "requirements.txt").write_text("requests\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_main.py").write_text(
        "def test_ok(): pass\n", encoding="utf-8"
    )
    return tmp_path


@pytest.fixture
def node_project(tmp_path: Path) -> Path:
    (tmp_path / "package.json").write_text(
        '{"name":"app","dependencies":{"react":"^18"}}', encoding="utf-8"
    )
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
    (tmp_path / "index.ts").write_text("export const x = 1;", encoding="utf-8")
    workflow_dir = tmp_path / ".github" / "workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "ci.yml").write_text("on: push\n", encoding="utf-8")
    return tmp_path


@pytest.fixture
def sensitive_project(tmp_path: Path) -> Path:
    (tmp_path / ".env").write_text("SECRET=abc\n", encoding="utf-8")
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / ".env.production").write_text(
        "SECRET=def\n", encoding="utf-8"
    )
    (tmp_path / "keys").mkdir()
    (tmp_path / "keys" / "private.key").write_text("private\n", encoding="utf-8")
    (tmp_path / "main.py").write_text("x = 1\n", encoding="utf-8")
    return tmp_path


class TestScanProject:
    def test_detects_python_and_pytest_from_a_real_project(self, python_project: Path):
        """Would fail if Python files or the tests-directory fallback disappeared."""
        from openagenticskyzer.tools.project_analyzer import _scan_project

        result = _scan_project(python_project)

        assert "Python" in result["languages"]
        assert result["test_runner"] == "pytest"

    def test_detects_typescript_react_and_github_actions(self, node_project: Path):
        """Would fail if extension, package manifest, or CI detection regressed."""
        from openagenticskyzer.tools.project_analyzer import _scan_project

        result = _scan_project(node_project)

        assert "TypeScript" in result["languages"]
        assert "React" in result["frameworks"]
        assert result["ci_cd"] == "GitHub Actions"

    def test_selects_pnpm_from_lockfile_regardless_of_walk_order(self, tmp_path: Path):
        """Would fail if package-manager selection reused filesystem walk order."""
        (tmp_path / "package.json").write_text("{}", encoding="utf-8")
        (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")
        (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")
        (tmp_path / "pyproject.toml").write_text("[project]\n", encoding="utf-8")

        from openagenticskyzer.tools.project_analyzer import _scan_project

        assert _scan_project(tmp_path)["package_manager"] == "pnpm"

    def test_selects_poetry_lockfile_before_an_unlocked_node_manifest(self, tmp_path: Path):
        """Would fail if package.json incorrectly beat a lockfile from another stack."""
        (tmp_path / "package.json").write_text("{}", encoding="utf-8")
        (tmp_path / "poetry.lock").write_text("# lock\n", encoding="utf-8")

        from openagenticskyzer.tools.project_analyzer import _scan_project

        assert _scan_project(tmp_path)["package_manager"] == "poetry"

    def test_falls_back_to_pip_for_a_python_project_without_a_specialized_lockfile(
        self, python_project: Path
    ):
        """Would fail if the conventional Python fallback stopped being reported."""
        from openagenticskyzer.tools.project_analyzer import _scan_project

        assert _scan_project(python_project)["package_manager"] == "pip"

    def test_returns_normalized_relative_paths_for_sensitive_files(
        self, sensitive_project: Path
    ):
        """Would fail if nested secrets were reduced to ambiguous basenames."""
        from openagenticskyzer.tools.project_analyzer import _scan_project

        result = _scan_project(sensitive_project)

        assert result["sensitive_files"] == [".env", "config/.env.production", "keys/private.key"]

    def test_keeps_scanning_when_a_manifest_cannot_be_read(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """Would fail if a locked manifest made the whole project analysis crash."""
        manifest = tmp_path / "package.json"
        manifest.write_text('{"dependencies":{"react":"^18"}}', encoding="utf-8")
        (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")
        (tmp_path / "index.ts").write_text("export const x = 1;", encoding="utf-8")
        original_read_text = Path.read_text

        def deny_manifest_read(path: Path, *args, **kwargs):
            if path == manifest:
                raise PermissionError("locked by another process")
            return original_read_text(path, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", deny_manifest_read)

        from openagenticskyzer.tools.project_analyzer import _scan_project

        result = _scan_project(tmp_path)

        assert result["languages"] == ["TypeScript"]
        assert result["package_manager"] == "npm"
        assert result["frameworks"] == []

    def test_returns_a_safe_structure_summary_when_top_level_listing_is_denied(
        self, python_project: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """Would fail if a PermissionError from the summary step escaped the scanner."""
        def deny_listing(path: Path):
            raise PermissionError("access denied")

        monkeypatch.setattr(Path, "iterdir", deny_listing)

        from openagenticskyzer.tools.project_analyzer import _scan_project

        result = _scan_project(python_project)

        assert "Python" in result["languages"]
        assert result["structure_summary"] == "Dossiers: aucun\nFichiers racine: aucun"

    def test_returns_a_summary_when_a_listed_entry_becomes_inaccessible(
        self, python_project: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """Would fail if a later stat error escaped after directory listing succeeded."""
        blocked_directory = python_project / "tests"
        original_is_dir = Path.is_dir

        def deny_directory_stat(path: Path) -> bool:
            if path == blocked_directory:
                raise PermissionError("access denied")
            return original_is_dir(path)

        monkeypatch.setattr(Path, "is_dir", deny_directory_stat)

        from openagenticskyzer.tools.project_analyzer import _scan_project

        result = _scan_project(python_project)

        assert "Python" in result["languages"]
        assert result["structure_summary"].startswith("Dossiers: aucun")
