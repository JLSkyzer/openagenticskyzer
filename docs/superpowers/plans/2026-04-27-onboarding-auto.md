# Onboarding Wizard + Auto-Analyze — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Détecter automatiquement la stack d'un projet et générer un fichier `OPENAGENT.md` (Phase 18), puis accueillir les nouveaux utilisateurs avec un wizard 4 étapes et permettre la personnalisation du thème (Phase 21).

**Architecture:** `_scan_project()` inspecte les fichiers de config pour détecter langages/frameworks/outils. `generate_openagent_md()` produit un fichier Markdown structuré avec les règles du projet. L'onboarding wizard est un `@ui.refreshable` dialog NiceGUI déclenché au premier lancement. Le thème est stocké dans le config global et appliqué via injection de CSS vars.

**Tech Stack:** Python 3.11+, NiceGUI, pathlib, pytest, unittest.mock

---

## Structure des fichiers

| Fichier | Action | Rôle |
|---------|--------|------|
| `openagenticskyzer/tools/project_analyzer.py` | Créer | `@tool analyze_project_and_init` + `_scan_project()` |
| `openagenticskyzer/context/project_instructions.py` | Créer | `generate_openagent_md()` + `_get_test_cmd()` |
| `openagenticskyzer/app/components/sidebar.py` | Modifier | Bouton "⚡ Init projet" + `_auto_init_project()` |
| `openagenticskyzer/app/components/onboarding.py` | Créer | `should_show_onboarding()` + `onboarding_wizard()` |
| `openagenticskyzer/app/main.py` | Modifier | Appel `onboarding_wizard()` au démarrage |
| `openagenticskyzer/app/components/settings.py` | Modifier | Onglet "Apparence" avec thème + accent |
| `openagenticskyzer/app/theme.py` | Créer | `get_theme_css()` + `_apply_theme()` |
| `openagenticskyzer/agent.py` | Modifier | Ajouter `analyze_project_and_init` à `_ALL_TOOLS` |
| `tests/test_project_analyzer.py` | Créer | Tests détection de stack |
| `tests/test_onboarding.py` | Créer | Tests wizard + thème |

---

## Task 1 : Créer `tools/project_analyzer.py`

**Files:**
- Create: `openagenticskyzer/tools/project_analyzer.py`
- Test: `tests/test_project_analyzer.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_project_analyzer.py
"""Tests de la détection automatique de stack projet."""
import pytest
from pathlib import Path


@pytest.fixture
def python_project(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "myapp"\n', encoding="utf-8")
    (tmp_path / "main.py").write_text("print('hello')", encoding="utf-8")
    (tmp_path / "requirements.txt").write_text("requests\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_main.py").write_text("def test_ok(): pass", encoding="utf-8")
    return tmp_path


@pytest.fixture
def node_project(tmp_path):
    (tmp_path / "package.json").write_text('{"name":"app","dependencies":{"react":"^18"}}', encoding="utf-8")
    (tmp_path / "index.ts").write_text("export const x = 1;", encoding="utf-8")
    (tmp_path / ".github").mkdir()
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    (tmp_path / ".github" / "workflows" / "ci.yml").write_text("on: push", encoding="utf-8")
    return tmp_path


@pytest.fixture
def sensitive_project(tmp_path):
    (tmp_path / ".env").write_text("SECRET=abc", encoding="utf-8")
    (tmp_path / "main.py").write_text("x=1", encoding="utf-8")
    return tmp_path


class TestScanProject:
    def test_detects_python(self, python_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(python_project)
        assert "Python" in result["languages"]

    def test_detects_typescript(self, node_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(node_project)
        assert "TypeScript" in result["languages"]

    def test_detects_pytest(self, python_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(python_project)
        assert result["test_runner"] == "pytest"

    def test_detects_pip(self, python_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(python_project)
        assert result["package_manager"] == "pip"

    def test_detects_react_framework(self, node_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(node_project)
        assert "React" in result["frameworks"]

    def test_detects_github_actions(self, node_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(node_project)
        assert result["ci_cd"] == "GitHub Actions"

    def test_detects_sensitive_files(self, sensitive_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(sensitive_project)
        assert ".env" in result["sensitive_files"]

    def test_structure_summary(self, python_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        result = _scan_project(python_project)
        assert "structure_summary" in result
        assert isinstance(result["structure_summary"], str)
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_project_analyzer.py -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Créer `tools/project_analyzer.py`**

```python
# openagenticskyzer/tools/project_analyzer.py
"""Analyse automatique de la stack d'un projet."""
from __future__ import annotations
import os
from pathlib import Path
from langchain_core.tools import tool

_LANG_MAP: dict[str, str] = {
    ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript",
    ".tsx": "TypeScript/React", ".jsx": "JavaScript/React",
    ".rs": "Rust", ".go": "Go", ".java": "Java", ".cs": "C#",
    ".cpp": "C++", ".c": "C", ".rb": "Ruby", ".php": "PHP",
    ".swift": "Swift", ".kt": "Kotlin", ".sh": "Shell",
    ".html": "HTML", ".css": "CSS", ".scss": "SCSS",
}

_FW_INDICATORS: dict[str, str] = {
    "django": "Django", "flask": "Flask", "fastapi": "FastAPI",
    "nicegui": "NiceGUI", "react": "React", "vue": "Vue",
    "angular": "Angular", "svelte": "Svelte", "next": "Next.js",
    "express": "Express", "nestjs": "NestJS", "rails": "Rails",
    "spring": "Spring", "laravel": "Laravel",
}

_PM_FILES: dict[str, str] = {
    "package.json": "npm/pnpm", "requirements.txt": "pip",
    "pyproject.toml": "pip", "Pipfile": "pipenv",
    "poetry.lock": "poetry", "Cargo.toml": "cargo",
    "go.mod": "go modules", "Gemfile": "bundler",
    "pom.xml": "maven", "build.gradle": "gradle",
}

_TEST_RUNNERS: dict[str, str] = {
    "pytest": "pytest", "unittest": "unittest",
    "jest": "jest", "vitest": "vitest",
    "mocha": "mocha", "rspec": "rspec",
}

_CI_PATTERNS: list[tuple[str, str]] = [
    (".github/workflows", "GitHub Actions"),
    (".gitlab-ci.yml", "GitLab CI"),
    ("Jenkinsfile", "Jenkins"),
    (".circleci", "CircleCI"),
    ("bitbucket-pipelines.yml", "Bitbucket Pipelines"),
    (".travis.yml", "Travis CI"),
]

_SENSITIVE: list[str] = [
    ".env", ".env.local", ".env.production",
    "secrets.json", "credentials.json", "private.key",
    "id_rsa", "*.pem", "*.p12",
]


def _scan_project(root: Path) -> dict:
    root = Path(root)
    languages: set[str] = set()
    frameworks: set[str] = set()
    test_runner = ""
    package_manager = ""
    ci_cd = ""
    sensitive_files: list[str] = []
    entry_points: list[str] = []

    # Parcourt les fichiers (max 3 niveaux)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if d not in {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
        ]
        depth = len(Path(dirpath).relative_to(root).parts)
        if depth > 3:
            dirnames.clear()
            continue

        for fname in filenames:
            fpath = Path(dirpath) / fname
            rel = str(fpath.relative_to(root))
            ext = Path(fname).suffix.lower()

            if ext in _LANG_MAP:
                languages.add(_LANG_MAP[ext])

            if fname in _PM_FILES and not package_manager:
                package_manager = _PM_FILES[fname]

            # Détecte test runner depuis les fichiers de conf
            if fname in ("pytest.ini", "pyproject.toml", "setup.cfg"):
                try:
                    content = fpath.read_text(encoding="utf-8", errors="ignore")
                    if "pytest" in content:
                        test_runner = "pytest"
                    elif "unittest" in content:
                        test_runner = "unittest"
                    if not frameworks:
                        for key, fw in _FW_INDICATORS.items():
                            if key in content.lower():
                                frameworks.add(fw)
                except OSError:
                    pass

            if fname in ("package.json",):
                try:
                    content = fpath.read_text(encoding="utf-8", errors="ignore")
                    for key, fw in _FW_INDICATORS.items():
                        if f'"{key}"' in content or f"'{key}'" in content:
                            frameworks.add(fw)
                    if "jest" in content:
                        test_runner = "jest"
                    elif "vitest" in content:
                        test_runner = "vitest"
                    if "pnpm-lock.yaml" in os.listdir(root):
                        package_manager = "pnpm"
                except OSError:
                    pass

            # Fichiers sensibles
            if fname in _SENSITIVE or any(fname.endswith(ext) for ext in (".pem", ".p12", ".key")):
                if fname not in sensitive_files:
                    sensitive_files.append(fname)

            # Entry points
            if fname in ("main.py", "app.py", "index.js", "index.ts", "main.ts", "server.py"):
                entry_points.append(rel)

    # CI/CD
    for pattern, ci_name in _CI_PATTERNS:
        if (root / pattern).exists():
            ci_cd = ci_name
            break

    # Tests via répertoire
    if not test_runner:
        for d in ("tests", "test", "__tests__", "spec"):
            if (root / d).is_dir():
                if any(languages & {"Python"}):
                    test_runner = "pytest"
                elif any(languages & {"JavaScript", "TypeScript"}):
                    test_runner = "jest"
                break

    # Structure résumée (top-level)
    top_dirs = sorted(
        d.name for d in root.iterdir()
        if d.is_dir() and not d.name.startswith(".")
        and d.name not in {"node_modules", "__pycache__", ".venv", "venv"}
    )
    top_files = sorted(f.name for f in root.iterdir() if f.is_file())
    structure_summary = (
        f"Dossiers: {', '.join(top_dirs[:8]) or 'aucun'}\n"
        f"Fichiers racine: {', '.join(top_files[:10]) or 'aucun'}"
    )

    return {
        "root": str(root),
        "languages": sorted(languages),
        "frameworks": sorted(frameworks),
        "test_runner": test_runner,
        "package_manager": package_manager,
        "ci_cd": ci_cd,
        "sensitive_files": sensitive_files,
        "entry_points": entry_points,
        "structure_summary": structure_summary,
    }


@tool
def analyze_project_and_init(folder: str = "") -> str:
    """Analyse la stack du projet actif et génère un fichier OPENAGENT.md."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_instructions import generate_openagent_md

    cwd = folder or state.active_folder
    if not cwd:
        return "Error: Aucun dossier actif. Ouvre un dossier d'abord."

    root = Path(cwd)
    if not root.is_dir():
        return f"Error: {cwd} n'est pas un dossier valide."

    analysis = _scan_project(root)
    content = generate_openagent_md(analysis)

    out = root / "OPENAGENT.md"
    out.write_text(content, encoding="utf-8")
    return f"✅ OPENAGENT.md généré dans {cwd} (langages: {', '.join(analysis['languages']) or 'N/A'})"
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

```
pytest tests/test_project_analyzer.py -v
```
Attendu : tous PASS

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/tools/project_analyzer.py tests/test_project_analyzer.py
rtk git commit -m "feat: add project_analyzer tool with stack detection (Phase 18)"
```

---

## Task 2 : Créer `context/project_instructions.py`

**Files:**
- Create: `openagenticskyzer/context/project_instructions.py`

- [ ] **Step 1 : Écrire les tests (ajout dans `test_project_analyzer.py`)**

```python
# À ajouter à la fin de tests/test_project_analyzer.py

class TestGenerateOpenagentMd:
    def test_contains_languages(self, python_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        from openagenticskyzer.context.project_instructions import generate_openagent_md
        analysis = _scan_project(python_project)
        md = generate_openagent_md(analysis)
        assert "Python" in md

    def test_contains_test_section(self, python_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        from openagenticskyzer.context.project_instructions import generate_openagent_md
        analysis = _scan_project(python_project)
        md = generate_openagent_md(analysis)
        assert "pytest" in md

    def test_contains_sensitive_warning(self, sensitive_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        from openagenticskyzer.context.project_instructions import generate_openagent_md
        analysis = _scan_project(sensitive_project)
        md = generate_openagent_md(analysis)
        assert ".env" in md
        assert "⚠️" in md or "sensible" in md.lower()

    def test_markdown_format(self, python_project):
        from openagenticskyzer.tools.project_analyzer import _scan_project
        from openagenticskyzer.context.project_instructions import generate_openagent_md
        analysis = _scan_project(python_project)
        md = generate_openagent_md(analysis)
        assert md.startswith("#")
        assert "##" in md
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_project_analyzer.py::TestGenerateOpenagentMd -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Créer `context/project_instructions.py`**

```python
# openagenticskyzer/context/project_instructions.py
"""Génère le fichier OPENAGENT.md à partir de l'analyse de projet."""
from __future__ import annotations


def _get_test_cmd(runner: str) -> str:
    cmds = {
        "pytest": "pytest -v",
        "unittest": "python -m unittest discover",
        "jest": "npx jest",
        "vitest": "npx vitest run",
        "mocha": "npx mocha",
        "rspec": "bundle exec rspec",
    }
    return cmds.get(runner, runner)


def generate_openagent_md(analysis: dict) -> str:
    lines: list[str] = []

    lines.append("# OPENAGENT.md — Instructions pour l'agent")
    lines.append("")
    lines.append("> Fichier généré automatiquement par OpenAgentic Skyzer. Modifiez selon vos besoins.")
    lines.append("")

    # Langages & frameworks
    lines.append("## Stack")
    langs = ", ".join(analysis.get("languages") or []) or "Non détecté"
    lines.append(f"- **Langages :** {langs}")

    fws = ", ".join(analysis.get("frameworks") or [])
    if fws:
        lines.append(f"- **Frameworks :** {fws}")

    pm = analysis.get("package_manager", "")
    if pm:
        lines.append(f"- **Gestionnaire de paquets :** {pm}")

    ci = analysis.get("ci_cd", "")
    if ci:
        lines.append(f"- **CI/CD :** {ci}")
    lines.append("")

    # Règles de développement
    lines.append("## Règles")
    lines.append("- Suis le style de code existant dans le projet.")
    lines.append("- N'installe pas de nouvelles dépendances sans accord explicite.")
    lines.append("- Écris des tests pour tout nouveau code.")
    lines.append("- Commits atomiques avec messages descriptifs.")
    lines.append("")

    # Fichiers sensibles
    sensitive = analysis.get("sensitive_files") or []
    if sensitive:
        lines.append("## ⚠️ Fichiers sensibles — NE PAS MODIFIER")
        for f in sensitive:
            lines.append(f"- `{f}`")
        lines.append("")

    # Tests
    runner = analysis.get("test_runner", "")
    if runner:
        cmd = _get_test_cmd(runner)
        lines.append("## Tests")
        lines.append(f"- **Runner :** `{runner}`")
        lines.append(f"- **Commande :** `{cmd}`")
        lines.append("- Exécute les tests avant chaque commit.")
        lines.append("")

    # Structure
    struct = analysis.get("structure_summary", "")
    if struct:
        lines.append("## Structure")
        lines.append("```")
        lines.append(struct)
        lines.append("```")
        lines.append("")

    # Entry points
    entries = analysis.get("entry_points") or []
    if entries:
        lines.append("## Points d'entrée")
        for ep in entries:
            lines.append(f"- `{ep}`")
        lines.append("")

    lines.append("## Notes")
    lines.append("_À compléter manuellement : architecture spécifique, conventions d'équipe, contraintes métier._")

    return "\n".join(lines)
```

- [ ] **Step 4 : Lancer les tests**

```
pytest tests/test_project_analyzer.py -v
```
Attendu : tous PASS

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/context/project_instructions.py tests/test_project_analyzer.py
rtk git commit -m "feat: add generate_openagent_md for project instructions file (Phase 18)"
```

---

## Task 3 : Intégrer dans `agent.py` et `sidebar.py`

**Files:**
- Modify: `openagenticskyzer/agent.py`
- Modify: `openagenticskyzer/app/components/sidebar.py`

- [ ] **Step 1 : Ajouter l'outil dans `agent.py`**

```python
# Ajouter l'import après les imports existants
from openagenticskyzer.tools.project_analyzer import analyze_project_and_init

# Dans _ALL_TOOLS, ajouter :
_ALL_TOOLS = [
    # ... outils existants ...
    analyze_project_and_init,
]
```

- [ ] **Step 2 : Lire `sidebar.py` pour localiser le bon endroit**

```
Read openagenticskyzer/app/components/sidebar.py
```
Repérer la fin de la section des dossiers ou le bas du rendu de la sidebar.

- [ ] **Step 3 : Ajouter le bouton "⚡ Init projet" dans `sidebar.py`**

À la fin de la fonction principale de rendu de la sidebar, ajouter :

```python
def _auto_init_project():
    """Analyse le dossier actif et génère OPENAGENT.md."""
    from openagenticskyzer.app.state import state
    from pathlib import Path

    if not state.active_folder:
        ui.notify("Ouvre un dossier d'abord.", type="warning")
        return

    openagent_file = Path(state.active_folder) / "OPENAGENT.md"
    if openagent_file.exists():
        with ui.dialog() as confirm_dlg, ui.card():
            ui.label("OPENAGENT.md existe déjà. Écraser ?")
            with ui.row():
                ui.button("Oui", on_click=lambda: (_do_init(), confirm_dlg.close()))
                ui.button("Annuler", on_click=confirm_dlg.close)
        confirm_dlg.open()
    else:
        _do_init()


def _do_init():
    from openagenticskyzer.tools.project_analyzer import _scan_project, analyze_project_and_init
    from openagenticskyzer.context.project_instructions import generate_openagent_md
    from openagenticskyzer.app.state import state
    from pathlib import Path

    root = Path(state.active_folder)
    analysis = _scan_project(root)
    content = generate_openagent_md(analysis)
    (root / "OPENAGENT.md").write_text(content, encoding="utf-8")
    langs = ", ".join(analysis["languages"]) or "N/A"
    ui.notify(f"✅ OPENAGENT.md généré ({langs})", type="positive")
```

Dans le rendu de la sidebar, appeler `_auto_init_project` via un bouton :

```python
ui.button("⚡ Init projet", on_click=_auto_init_project).classes("text-xs w-full mt-2")
```

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/agent.py openagenticskyzer/app/components/sidebar.py
rtk git commit -m "feat: integrate analyze_project_and_init in agent + sidebar button (Phase 18)"
```

---

## Task 4 : Créer `app/components/onboarding.py`

**Files:**
- Create: `openagenticskyzer/app/components/onboarding.py`
- Test: `tests/test_onboarding.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_onboarding.py
"""Tests du wizard d'onboarding et de la logique de thème."""
import pytest
from unittest.mock import patch, MagicMock


class TestShouldShowOnboarding:
    def test_returns_true_when_no_flag(self):
        with patch("openagenticskyzer.app.components.onboarding._load_global_config", return_value={}):
            from openagenticskyzer.app.components.onboarding import should_show_onboarding
            assert should_show_onboarding() is True

    def test_returns_false_when_done(self):
        with patch("openagenticskyzer.app.components.onboarding._load_global_config", return_value={"onboarding_done": True}):
            from openagenticskyzer.app.components.onboarding import should_show_onboarding
            assert should_show_onboarding() is False

    def test_returns_true_when_flag_false(self):
        with patch("openagenticskyzer.app.components.onboarding._load_global_config", return_value={"onboarding_done": False}):
            from openagenticskyzer.app.components.onboarding import should_show_onboarding
            assert should_show_onboarding() is True


class TestTheme:
    def test_dark_theme_has_bg_var(self):
        from openagenticskyzer.app.theme import get_theme_css
        css = get_theme_css("dark", "#3b82f6")
        assert "--bg:" in css
        assert "--surface:" in css
        assert "--accent:" in css

    def test_light_theme_has_light_colors(self):
        from openagenticskyzer.app.theme import get_theme_css
        css = get_theme_css("light", "#3b82f6")
        assert "--bg:" in css
        assert "#f" in css.lower() or "#e" in css.lower() or "#d" in css.lower()

    def test_accent_color_injected(self):
        from openagenticskyzer.app.theme import get_theme_css
        css = get_theme_css("dark", "#ff0000")
        assert "#ff0000" in css

    def test_unknown_theme_falls_back_to_dark(self):
        from openagenticskyzer.app.theme import get_theme_css
        css = get_theme_css("unknown_theme", "#3b82f6")
        assert "--bg:" in css
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_onboarding.py -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Créer `app/components/onboarding.py`**

```python
# openagenticskyzer/app/components/onboarding.py
"""Wizard d'onboarding pour les nouveaux utilisateurs."""
from __future__ import annotations
from nicegui import ui


def _load_global_config() -> dict:
    from openagenticskyzer.app.storage import load_global_config
    return load_global_config()


def _save_global_config(cfg: dict) -> None:
    from openagenticskyzer.app.storage import save_global_config
    save_global_config(cfg)


def should_show_onboarding() -> bool:
    cfg = _load_global_config()
    return not cfg.get("onboarding_done", False)


@ui.refreshable
def onboarding_wizard() -> None:
    """Wizard 4 étapes — affiché au premier lancement."""
    cfg = _load_global_config()
    step: list[int] = [1]

    with ui.dialog(value=True) as dlg:
        dlg.props("persistent")
        with ui.card().classes("w-96 p-6 gap-4"):

            # Step 1 — Bienvenue
            with ui.column().bind_visibility_from(step, forward=lambda s: s[0] == 1):
                ui.label("👋 Bienvenue dans OpenAgentic Skyzer !").classes("text-xl font-bold")
                ui.label(
                    "Un agent IA local, puissant et entièrement privé. "
                    "Ce wizard vous guide en 3 étapes rapides."
                ).classes("text-sm text-gray-400")
                ui.button("Commencer →", on_click=lambda: _next_step(step, dlg, 2)).classes("mt-4 w-full")

            # Step 2 — Configuration du modèle
            with ui.column().bind_visibility_from(step, forward=lambda s: s[0] == 2):
                ui.label("🤖 Choisissez votre modèle").classes("text-lg font-bold")
                ui.label("Sélectionnez un fournisseur et un modèle pour commencer.").classes("text-sm text-gray-400")
                try:
                    from openagenticskyzer.app.components.model_modal import render_model_selector_inline
                    render_model_selector_inline()
                except Exception:
                    ui.label("(Sélecteur de modèle indisponible — configurez via les paramètres)").classes("text-xs text-yellow-400")
                with ui.row().classes("mt-4 w-full justify-between"):
                    ui.button("← Retour", on_click=lambda: _next_step(step, dlg, 1)).props("flat")
                    ui.button("Suivant →", on_click=lambda: _next_step(step, dlg, 3))

            # Step 3 — Premier dossier
            with ui.column().bind_visibility_from(step, forward=lambda s: s[0] == 3):
                ui.label("📁 Ouvrez un projet").classes("text-lg font-bold")
                ui.label("Ouvrez un dossier pour que l'agent puisse analyser votre code.").classes("text-sm text-gray-400")
                ui.button("📂 Ouvrir un dossier", on_click=lambda: _open_folder_dialog(step, dlg)).classes("w-full mt-2")
                with ui.row().classes("mt-4 w-full justify-between"):
                    ui.button("← Retour", on_click=lambda: _next_step(step, dlg, 2)).props("flat")
                    ui.button("Passer", on_click=lambda: _next_step(step, dlg, 4)).props("flat")

            # Step 4 — Terminé
            with ui.column().bind_visibility_from(step, forward=lambda s: s[0] == 4):
                ui.label("🎉 C'est parti !").classes("text-xl font-bold")
                ui.label("Tout est prêt. Quelques raccourcis utiles :").classes("text-sm text-gray-400")
                with ui.column().classes("text-xs font-mono gap-1 mt-2"):
                    ui.label("Ctrl+L — Effacer la conversation")
                    ui.label("Ctrl+, — Paramètres")
                    ui.label("Ctrl+K — Palette de commandes")
                    ui.label("Ctrl+Enter — Envoyer le message")
                ui.button("Commencer à coder 🚀", on_click=lambda: _finish(dlg)).classes("mt-4 w-full")


def _next_step(step: list[int], dlg, target: int) -> None:
    step[0] = target
    dlg.update()


def _open_folder_dialog(step: list[int], dlg) -> None:
    from openagenticskyzer.app.state import state
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        folder = filedialog.askdirectory(title="Ouvrir un projet")
        root.destroy()
        if folder:
            state.active_folder = folder
            _next_step(step, dlg, 4)
    except Exception:
        _next_step(step, dlg, 4)


def _finish(dlg) -> None:
    cfg = _load_global_config()
    cfg["onboarding_done"] = True
    _save_global_config(cfg)
    dlg.close()
    onboarding_wizard.refresh()
```

- [ ] **Step 4 : Lancer les tests**

```
pytest tests/test_onboarding.py::TestShouldShowOnboarding -v
```
Attendu : tous PASS (les tests de thème passent à la Task 5)

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/app/components/onboarding.py tests/test_onboarding.py
rtk git commit -m "feat: add onboarding wizard 4-step dialog (Phase 21)"
```

---

## Task 5 : Créer `app/theme.py` et intégrer dans `settings.py`

**Files:**
- Create: `openagenticskyzer/app/theme.py`
- Modify: `openagenticskyzer/app/components/settings.py`

- [ ] **Step 1 : Créer `app/theme.py`**

```python
# openagenticskyzer/app/theme.py
"""Système de thème — génère les variables CSS et applique le thème."""
from __future__ import annotations

_THEMES: dict[str, dict[str, str]] = {
    "dark": {
        "--bg": "#0f172a",
        "--surface": "#1e293b",
        "--surface2": "#334155",
        "--border": "#475569",
        "--text": "#f1f5f9",
        "--text-muted": "#94a3b8",
    },
    "light": {
        "--bg": "#f8fafc",
        "--surface": "#ffffff",
        "--surface2": "#f1f5f9",
        "--border": "#cbd5e1",
        "--text": "#0f172a",
        "--text-muted": "#64748b",
    },
}


def get_theme_css(theme_name: str, accent: str = "#3b82f6") -> str:
    theme = _THEMES.get(theme_name, _THEMES["dark"])
    vars_css = "\n".join(f"  {k}: {v};" for k, v in theme.items())
    accent_css = f"  --accent: {accent};"
    return f":root {{\n{vars_css}\n{accent_css}\n}}"


def _apply_theme() -> None:
    """Lit le config global et injecte le CSS de thème dans la page."""
    from nicegui import ui
    try:
        from openagenticskyzer.app.storage import load_global_config
        cfg = load_global_config()
        theme = cfg.get("theme", "dark")
        accent = cfg.get("accent_color", "#3b82f6")
        css = get_theme_css(theme, accent)
        ui.add_head_html(f"<style>{css}</style>")
    except Exception:
        pass
```

- [ ] **Step 2 : Lancer les tests de thème**

```
pytest tests/test_onboarding.py::TestTheme -v
```
Attendu : tous PASS

- [ ] **Step 3 : Lire `settings.py` pour localiser le bon endroit**

```
Read openagenticskyzer/app/components/settings.py
```
Repérer la liste des onglets existants (ex: `ui.tab("Général")`, etc.)

- [ ] **Step 4 : Ajouter l'onglet "Apparence" dans `settings.py`**

Dans la liste des onglets, ajouter :

```python
ui.tab("Apparence", icon="palette")
```

Dans le contenu des onglets (bloc `with ui.tab_panels`), ajouter :

```python
with ui.tab_panel("Apparence"):
    ui.label("Thème").classes("text-sm font-semibold mb-2")
    with ui.row().classes("gap-2"):
        ui.button(
            "🌙 Sombre",
            on_click=lambda: _set_theme("dark")
        ).classes("text-xs")
        ui.button(
            "☀️ Clair",
            on_click=lambda: _set_theme("light")
        ).classes("text-xs")
    ui.separator()
    ui.label("Couleur d'accentuation").classes("text-sm font-semibold mt-2")

    def _on_accent_change(e):
        _set_accent(e.value)

    ui.color_input(
        label="Couleur d'accent",
        on_change=_on_accent_change,
    ).classes("w-48")
```

Ajouter les fonctions helpers dans `settings.py` :

```python
def _set_theme(name: str) -> None:
    from openagenticskyzer.app.storage import load_global_config, save_global_config
    from openagenticskyzer.app.theme import _apply_theme
    cfg = load_global_config()
    cfg["theme"] = name
    save_global_config(cfg)
    _apply_theme()
    ui.notify(f"Thème '{name}' appliqué. Rechargez pour voir tous les changements.", type="info")


def _set_accent(color: str) -> None:
    from openagenticskyzer.app.storage import load_global_config, save_global_config
    from openagenticskyzer.app.theme import _apply_theme
    cfg = load_global_config()
    cfg["accent_color"] = color
    save_global_config(cfg)
    _apply_theme()
```

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/app/theme.py openagenticskyzer/app/components/settings.py tests/test_onboarding.py
rtk git commit -m "feat: add theme system (dark/light + accent color) in settings (Phase 21)"
```

---

## Task 6 : Intégrer l'onboarding dans `main.py`

**Files:**
- Modify: `openagenticskyzer/app/main.py`

- [ ] **Step 1 : Lire `main.py` pour localiser le point d'entrée de l'UI**

```
Read openagenticskyzer/app/main.py
```
Repérer la fonction principale (ex: `def main()`, `@ui.page('/')`, ou le bloc `if __name__ == "__main__":`).

- [ ] **Step 2 : Ajouter l'appel onboarding + theme dans `main.py`**

Au début de la fonction de création de page (après les imports), ajouter :

```python
from openagenticskyzer.app.components.onboarding import should_show_onboarding, onboarding_wizard
from openagenticskyzer.app.theme import _apply_theme

# Dans la fonction de rendu de page, avant le reste du contenu :
_apply_theme()
if should_show_onboarding():
    onboarding_wizard()
```

- [ ] **Step 3 : Commit**

```bash
rtk git add openagenticskyzer/app/main.py
rtk git commit -m "feat: trigger onboarding wizard + apply theme on startup (Phase 21)"
```

---

## Task 7 : Tests d'intégration finaux

**Files:**
- Test: `tests/test_onboarding.py` (compléter)
- Test: `tests/test_project_analyzer.py` (vérifier que tous passent)

- [ ] **Step 1 : Lancer la suite complète des tests**

```
pytest tests/test_project_analyzer.py tests/test_onboarding.py -v
```
Attendu : tous PASS

- [ ] **Step 2 : Lancer tous les tests du projet**

```
pytest tests/ -v --tb=short
```
Vérifier qu'aucune régression n'a été introduite.

- [ ] **Step 3 : Commit final si nécessaire**

Si des corrections ont été apportées :

```bash
rtk git add -A
rtk git commit -m "fix: correct regressions found during integration test run (Phase 18/21)"
```
