"""Analyse déterministe de stack et initialisation explicite des instructions."""
from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from langchain_core.tools import tool

from openagenticskyzer.context.project_instructions import generate_openagent_md

_IGNORED_DIRECTORIES = {
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
}
_LANGUAGES_BY_EXTENSION: dict[str, str] = {
    ".py": "Python",
    ".js": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".jsx": "JavaScript",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".cs": "C#",
    ".cpp": "C++",
    ".c": "C",
    ".rb": "Ruby",
    ".php": "PHP",
    ".swift": "Swift",
    ".kt": "Kotlin",
    ".sh": "Shell",
    ".html": "HTML",
    ".css": "CSS",
    ".scss": "SCSS",
}
_FRAMEWORKS_BY_INDICATOR: dict[str, str] = {
    "django": "Django",
    "flask": "Flask",
    "fastapi": "FastAPI",
    "nicegui": "NiceGUI",
    "react": "React",
    "vue": "Vue",
    "angular": "Angular",
    "svelte": "Svelte",
    "next": "Next.js",
    "express": "Express",
    "nestjs": "NestJS",
    "rails": "Rails",
    "spring": "Spring",
    "laravel": "Laravel",
}

# These entries define the product decision, independently of os.walk ordering.
# Lockfiles come before manifests; pnpm and Bun are preferred over legacy locks.
_PACKAGE_MANAGER_PRIORITY: tuple[tuple[str, str], ...] = (
    ("pnpm-lock.yaml", "pnpm"),
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
    ("uv.lock", "uv"),
    ("poetry.lock", "poetry"),
    ("Pipfile.lock", "pipenv"),
    ("package.json", "npm"),
    ("Pipfile", "pipenv"),
    ("requirements.txt", "pip"),
    ("pyproject.toml", "pip"),
    ("Cargo.toml", "cargo"),
    ("go.mod", "go modules"),
    ("Gemfile", "bundler"),
    ("pom.xml", "maven"),
    ("build.gradle", "gradle"),
)
_TEST_RUNNER_PRIORITY: tuple[tuple[str, str], ...] = (
    ("pytest", "pytest"),
    ("unittest", "unittest"),
    ("vitest", "vitest"),
    ("jest", "jest"),
    ("mocha", "mocha"),
    ("rspec", "rspec"),
)
_CI_PATHS: tuple[tuple[str, str], ...] = (
    (".github/workflows", "GitHub Actions"),
    (".gitlab-ci.yml", "GitLab CI"),
    ("Jenkinsfile", "Jenkins"),
    (".circleci", "CircleCI"),
    ("bitbucket-pipelines.yml", "Bitbucket Pipelines"),
    (".travis.yml", "Travis CI"),
)
_CONTENT_FILES = {
    "package.json",
    "pyproject.toml",
    "setup.cfg",
    "pytest.ini",
    "requirements.txt",
    "Pipfile",
    "Gemfile",
    "composer.json",
    "pom.xml",
    "build.gradle",
}
_ENTRY_POINT_NAMES = {"main.py", "app.py", "index.js", "index.ts", "main.ts", "server.py"}


def _read_text_if_possible(path: Path) -> str:
    """Read metadata without turning a locked or unreadable file into a crash."""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _detect_frameworks(filename: str, content: str) -> set[str]:
    """Return frameworks named in common dependency/configuration files."""
    if not content:
        return set()

    lower_content = content.lower()
    frameworks: set[str] = set()
    for indicator, framework in _FRAMEWORKS_BY_INDICATOR.items():
        if filename == "package.json":
            found = f'"{indicator}"' in lower_content or f"'{indicator}'" in lower_content
        else:
            found = re.search(rf"\b{re.escape(indicator)}\b", lower_content) is not None
        if found:
            frameworks.add(framework)
    return frameworks


def _select_first_detected(
    priority: tuple[tuple[str, str], ...], detected_names: set[str]
) -> str:
    """Select from an ordered product policy, never from filesystem traversal order."""
    for filename, value in priority:
        if filename in detected_names:
            return value
    return ""


def _safe_top_level_summary(root: Path) -> str:
    """Build a stable directory summary even when the root becomes unreadable."""
    try:
        children = list(root.iterdir())
    except OSError:
        children = []

    top_dirs: list[str] = []
    top_files: list[str] = []
    for child in children:
        try:
            if child.is_dir():
                if not child.name.startswith(".") and child.name not in _IGNORED_DIRECTORIES:
                    top_dirs.append(child.name)
            elif child.is_file():
                top_files.append(child.name)
        except OSError:
            continue
    top_dirs.sort()
    top_files.sort()
    return (
        f"Dossiers: {', '.join(top_dirs[:8]) or 'aucun'}\n"
        f"Fichiers racine: {', '.join(top_files[:10]) or 'aucun'}"
    )


def _is_sensitive_filename(filename: str) -> bool:
    return (
        filename == ".env"
        or filename.startswith(".env.")
        or filename in {"secrets.json", "credentials.json", "private.key", "id_rsa"}
        or filename.endswith((".pem", ".p12", ".key"))
    )


def _scan_project(root: Path) -> dict[str, object]:
    """Inspect at most three nested levels of *root* and return stack metadata.

    Every filesystem operation is best effort: a directory or metadata file can be
    unavailable on Windows while another part of the project remains analyzable.
    """
    root = Path(root)
    languages: set[str] = set()
    frameworks: set[str] = set()
    detected_names: set[str] = set()
    test_signals: set[str] = set()
    sensitive_files: set[str] = set()
    entry_points: set[str] = set()
    test_directories: set[str] = set()

    def ignore_walk_error(_: OSError) -> None:
        """os.walk callback: an inaccessible directory simply contributes nothing."""

    for directory, directory_names, filenames in os.walk(root, topdown=True, onerror=ignore_walk_error):
        directory_names[:] = sorted(
            name for name in directory_names if name not in _IGNORED_DIRECTORIES
        )
        try:
            depth = len(Path(directory).relative_to(root).parts)
        except ValueError:
            continue
        if depth >= 3:
            directory_names.clear()

        for filename in sorted(filenames):
            path = Path(directory) / filename
            try:
                relative_path = path.relative_to(root).as_posix()
            except ValueError:
                continue
            detected_names.add(filename)

            language = _LANGUAGES_BY_EXTENSION.get(path.suffix.lower())
            if language:
                languages.add(language)
            if filename in _ENTRY_POINT_NAMES:
                entry_points.add(relative_path)
            if _is_sensitive_filename(filename):
                sensitive_files.add(relative_path)

            if filename in _CONTENT_FILES:
                content = _read_text_if_possible(path)
                frameworks.update(_detect_frameworks(filename, content))
                lowered_content = content.lower()
                for indicator, runner in _TEST_RUNNER_PRIORITY:
                    if re.search(rf"\b{re.escape(indicator)}\b", lowered_content):
                        test_signals.add(runner)

        test_directories.update(
            name for name in directory_names if name in {"tests", "test", "__tests__", "spec"}
        )

    package_manager = _select_first_detected(_PACKAGE_MANAGER_PRIORITY, detected_names)
    test_runner = _select_first_detected(_TEST_RUNNER_PRIORITY, test_signals)
    if not test_runner and test_directories:
        if "Python" in languages:
            test_runner = "pytest"
        elif languages & {"JavaScript", "TypeScript"}:
            test_runner = "jest"

    ci_cd = ""
    for relative_path, name in _CI_PATHS:
        try:
            if (root / relative_path).exists():
                ci_cd = name
                break
        except OSError:
            continue

    return {
        "root": str(root),
        "languages": sorted(languages),
        "frameworks": sorted(frameworks),
        "test_runner": test_runner,
        "package_manager": package_manager,
        "ci_cd": ci_cd,
        "sensitive_files": sorted(sensitive_files),
        "entry_points": sorted(entry_points),
        "structure_summary": _safe_top_level_summary(root),
    }


@dataclass(frozen=True)
class ProjectInitResult:
    success: bool
    message: str


def initialize_project(folder: str | Path, *, overwrite: bool = False) -> ProjectInitResult:
    """Scan, generate and write OPENAGENT.md after caller authorization.

    Existing instructions require explicit overwrite permission and are replaced
    atomically. Exclusive creation prevents collisions on filesystems without
    hard links too; a partial new file is removed if its write fails.
    """
    temporary: Path | None = None
    try:
        if not folder or not Path(folder).is_dir():
            return ProjectInitResult(False, "Dossier absent ou invalide.")
        root = Path(folder).resolve()
        target = root / "OPENAGENT.md"
        if target.exists() and not overwrite:
            return ProjectInitResult(False, "OPENAGENT.md existe déjà. Confirmez son écrasement.")

        analysis = _scan_project(root)
        content = generate_openagent_md(analysis)
        try:
            stream = tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=root,
                prefix=".openagent-init-", suffix=".tmp", delete=False,
            ) if overwrite else target.open("x", encoding="utf-8", newline="\n")
            with stream:
                temporary = Path(stream.name)
                stream.write(content)
            if overwrite:
                os.replace(temporary, target)
            else:
                temporary = None  # the exclusively created file is complete
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    except FileExistsError:
        return ProjectInitResult(False, "OPENAGENT.md existe déjà. Confirmez son écrasement.")
    except (OSError, ValueError) as exc:
        return ProjectInitResult(False, f"Impossible d'initialiser le dossier : {exc}")

    languages = ", ".join(analysis["languages"]) or "Non détecté"
    return ProjectInitResult(True, f"OPENAGENT.md généré dans {root} ({languages}).")


@tool
def analyze_project_and_init(folder: str = "", overwrite: bool = False) -> str:
    """Analyse un dossier et ÉCRIT OPENAGENT.md avec les instructions de sa stack.

    Cette action nécessite une autorisation d'écriture. Si OPENAGENT.md existe,
    demander l'accord explicite avant de passer overwrite=True. Le nouveau
    OPENAGENT.md devient prioritaire sur un éventuel CLAUDE.md.
    Un dossier vide utilise le projet actif de l'application, puis le cwd du CLI.
    """
    from openagenticskyzer.app.state import state

    return initialize_project(folder or state.active_folder or os.getcwd(), overwrite=overwrite).message
