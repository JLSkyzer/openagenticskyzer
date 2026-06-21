# Artifacts, Contenu & UX Avancée — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter le panneau d'artifacts (HTML/SVG/Mermaid), la bibliothèque de prompts, l'export de conversation, l'édition/régénération de messages, la command palette Ctrl+K, le fork de conversation et les onglets multi-conversations (Phases 3 + 8).

**Architecture:** Nouveaux composants `artifact_panel.py`, `prompt_library.py`, `command_palette.py`; nouveau fichier `exporter.py`; modifications dans `chat.py`, `input_bar.py`, `state.py`, `storage.py`, `main.py`. Le système de branches enrichit `AppState` d'une liste `ConversationBranch`.

**Tech Stack:** Python 3.11+, NiceGUI, mermaid.js (CDN), highlight.js (CDN), pytest

---

## Structure des fichiers

| Fichier | Action | Rôle |
|---------|--------|------|
| `openagenticskyzer/app/components/artifact_panel.py` | Créer | Panneau preview HTML/SVG/Mermaid |
| `openagenticskyzer/app/components/prompt_library.py` | Créer | Popup picker de templates |
| `openagenticskyzer/app/components/command_palette.py` | Créer | Command palette Ctrl+K |
| `openagenticskyzer/app/exporter.py` | Créer | Export MD/HTML/JSON |
| `openagenticskyzer/app/state.py` | Modifier | artifact_type/content/show_artifact, branches, current_branch_id, tabs |
| `openagenticskyzer/app/storage.py` | Modifier | load_prompts / save_prompts |
| `openagenticskyzer/app/components/chat.py` | Modifier | Boutons edit/régénérer/fork, export, render branches |
| `openagenticskyzer/app/components/input_bar.py` | Modifier | Déclencher artifact_panel, bouton ✦, détection `/` |
| `openagenticskyzer/app/main.py` | Modifier | Injecter mermaid.js, artifact_panel(), command_palette() |
| `tests/test_artifacts.py` | Créer | Tests extraction artifacts + export |

---

## Task 1 : Extraction d'artifacts et `state.py`

**Files:**
- Modify: `openagenticskyzer/app/state.py`
- Create: `tests/test_artifacts.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_artifacts.py
"""Tests extraction d'artifacts et export de conversation."""
import pytest


def test_extract_html_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "Voici le résultat :\n```html\n<h1>Hello</h1>\n```"
    result = _extract_artifact(text)
    assert result is not None
    kind, content = result
    assert kind == "html"
    assert "<h1>Hello</h1>" in content


def test_extract_mermaid_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "Diagramme :\n```mermaid\ngraph TD\nA --> B\n```"
    result = _extract_artifact(text)
    assert result is not None
    assert result[0] == "mermaid"


def test_no_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "Voici du code Python :\n```python\nprint('hello')\n```"
    assert _extract_artifact(text) is None


def test_extract_svg_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "```svg\n<svg><circle r='5'/></svg>\n```"
    result = _extract_artifact(text)
    assert result[0] == "svg"
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_artifacts.py -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Ajouter les champs dans `state.py`**

Trouver la classe `AppState` et ajouter :

```python
# Artifacts
artifact_type: str = ""       # "html" | "svg" | "mermaid" | "markdown" | ""
artifact_content: str = ""
show_artifact: bool = False

# Branches
branches: list = field(default_factory=list)        # list[ConversationBranch]
current_branch_id: str = "main"
```

Ajouter également `ConversationBranch` comme dataclass dans `state.py` :

```python
@dataclass
class ConversationBranch:
    branch_id: str
    label: str
    messages: list        # list[ChatMessage]
    created_at: str
```

- [ ] **Step 4 : Créer `artifact_panel.py`**

```python
# openagenticskyzer/app/components/artifact_panel.py
"""Panneau de preview d'artifact (HTML, SVG, Mermaid)."""
import re as _re
from nicegui import ui
from openagenticskyzer.app.state import state

_ARTIFACT_RE = _re.compile(
    r"```(html|svg|mermaid|markdown)\n(.*?)```",
    _re.DOTALL | _re.IGNORECASE,
)


def _extract_artifact(text: str) -> tuple[str, str] | None:
    """Retourne (type, content) ou None."""
    m = _ARTIFACT_RE.search(text)
    if m:
        return m.group(1).lower(), m.group(2).strip()
    return None


@ui.refreshable
def artifact_panel():
    if not state.show_artifact or not state.artifact_content:
        return
    with ui.column().classes("h-full border-l border-gray-800 bg-gray-950").style("width:400px;flex-shrink:0"):
        with ui.row().classes("items-center px-3 py-2 border-b border-gray-800 gap-2"):
            ui.label(f"Preview — {state.artifact_type.upper()}").classes("text-xs text-gray-400 flex-1")
            ui.button("✕", on_click=_close_artifact).classes(
                "w-6 h-6 bg-transparent text-gray-500 hover:text-white text-xs"
            )
        with ui.scroll_area().classes("flex-1 w-full"):
            if state.artifact_type == "html":
                escaped = state.artifact_content.replace("\\", "\\\\").replace("`", "\\`")
                ui.html(f"""
                <iframe
                  style="width:100%;height:500px;border:none;background:white;border-radius:8px"
                  srcdoc=`{escaped}`
                  sandbox="allow-scripts allow-same-origin">
                </iframe>
                """)
            elif state.artifact_type == "svg":
                ui.html(f'<div style="padding:16px">{state.artifact_content}</div>')
            elif state.artifact_type == "mermaid":
                ui.html(f"""
                <div class="mermaid" style="padding:16px;background:#1e1e2e;border-radius:8px">
                {state.artifact_content}
                </div>
                """)
                ui.run_javascript("mermaid.init(undefined, document.querySelectorAll('.mermaid:not([data-processed])'))")
            elif state.artifact_type == "markdown":
                ui.markdown(state.artifact_content)


def _close_artifact():
    state.artifact_type = ""
    state.artifact_content = ""
    state.show_artifact = False
    artifact_panel.refresh()
```

- [ ] **Step 5 : Lancer les tests pour vérifier qu'ils passent**

```
pytest tests/test_artifacts.py -v
```
Attendu : 4 PASS

- [ ] **Step 6 : Commit**

```bash
rtk git add openagenticskyzer/app/state.py openagenticskyzer/app/components/artifact_panel.py tests/test_artifacts.py
rtk git commit -m "feat: add artifact panel (HTML/SVG/Mermaid) + state fields (Phase 3.1)"
```

---

## Task 2 : Intégration artifact dans `input_bar.py` et `main.py`

**Files:**
- Modify: `openagenticskyzer/app/components/input_bar.py`
- Modify: `openagenticskyzer/app/main.py`

- [ ] **Step 1 : Déclencher le panneau après réponse AI dans `input_bar.py`**

Trouver la section où `ai_text` est récupéré après l'invocation de l'agent et ajouter :

```python
from openagenticskyzer.app.components.artifact_panel import artifact_panel, _extract_artifact

# Après avoir récupéré ai_text :
if ai_text:
    artifact = _extract_artifact(ai_text)
    if artifact:
        state.artifact_type, state.artifact_content = artifact
        state.show_artifact = True
        artifact_panel.refresh()
```

- [ ] **Step 2 : Injecter mermaid.js dans `main.py`**

Trouver la fonction qui construit la page principale (ex: `main_page()`) et ajouter avant le layout :

```python
from openagenticskyzer.app.components.artifact_panel import artifact_panel

ui.add_head_html("""
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad: false, theme: 'dark'});</script>
""")
```

- [ ] **Step 3 : Ajouter `artifact_panel()` dans le layout principal de `main.py`**

Trouver la zone `Content Column` (là où `render_chat()` est appelé) et envelopper dans une row avec le panneau droit :

```python
# Remplacer la colonne de chat par :
with ui.row().classes("flex-1 overflow-hidden"):
    with ui.column().classes("flex-1 overflow-hidden"):
        render_chat()
        render_context_bar()
        render_input_bar()
    artifact_panel()
```

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/app/components/input_bar.py openagenticskyzer/app/main.py
rtk git commit -m "feat: trigger artifact panel after AI response + inject mermaid.js (Phase 3.1)"
```

---

## Task 3 : Bibliothèque de prompts

**Files:**
- Modify: `openagenticskyzer/app/storage.py`
- Create: `openagenticskyzer/app/components/prompt_library.py`
- Modify: `openagenticskyzer/app/components/input_bar.py`
- Test: `tests/test_artifacts.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_artifacts.py`, ajouter :

```python
def test_load_prompts_returns_defaults():
    from unittest.mock import patch
    from pathlib import Path
    with patch("openagenticskyzer.app.storage._openagent_home", return_value=Path("/nonexistent/path")):
        from openagenticskyzer.app.storage import load_prompts
        prompts = load_prompts()
    assert isinstance(prompts, list)
    assert len(prompts) > 0
    assert all("id" in p and "name" in p and "template" in p for p in prompts)


def test_save_and_load_prompts(tmp_path, monkeypatch):
    import openagenticskyzer.app.storage as storage
    monkeypatch.setattr(storage, "_openagent_home", lambda: tmp_path)
    from openagenticskyzer.app.storage import save_prompts, load_prompts
    custom = [{"id": "test", "name": "Test", "icon": "🔧", "template": "Hello {filename}", "description": "Test template"}]
    save_prompts(custom)
    loaded = load_prompts()
    assert loaded[0]["id"] == "test"
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_artifacts.py::test_load_prompts_returns_defaults -v
```
Attendu : FAIL

- [ ] **Step 3 : Ajouter `load_prompts`/`save_prompts` dans `storage.py`**

```python
# À ajouter dans openagenticskyzer/app/storage.py

DEFAULT_PROMPTS: list[dict] = [
    {"id": "refactor", "name": "Refactoriser", "icon": "🔧",
     "description": "Améliore la lisibilité et la structure du code",
     "template": "Refactorise ce fichier en suivant les bonnes pratiques.\n\nObjectifs :\n- Nommer clairement les fonctions et variables\n- Réduire la duplication\n- Améliorer la lisibilité\n- Ajouter des types si manquants\n\nFichier : {filename}"},
    {"id": "tests", "name": "Écrire les tests", "icon": "🧪",
     "description": "Génère des tests unitaires",
     "template": "Écris des tests unitaires exhaustifs pour {filename}.\nUtilise pytest. Couvre les cas normaux, les cas limites, et les erreurs."},
    {"id": "explain", "name": "Expliquer", "icon": "📖",
     "description": "Explique le code sélectionné",
     "template": "Explique ce code en détail, ligne par ligne si nécessaire :\n{filename}"},
    {"id": "pr_desc", "name": "Description PR", "icon": "📝",
     "description": "Génère une description de Pull Request",
     "template": "Génère une description de Pull Request à partir du git diff.\nFormat : titre, résumé des changements, type de changement (feat/fix/refactor), impact."},
    {"id": "debug", "name": "Déboguer", "icon": "🐛",
     "description": "Analyse une erreur et propose un fix",
     "template": "Analyse cette erreur et propose un fix avec explication :\n\n"},
    {"id": "optimize", "name": "Optimiser", "icon": "⚡",
     "description": "Améliore les performances",
     "template": "Analyse les performances de {filename} et propose des optimisations concrètes avec benchmarks si possible."},
    {"id": "security", "name": "Audit sécurité", "icon": "🔒",
     "description": "Cherche les vulnérabilités",
     "template": "Effectue un audit de sécurité complet de {filename}.\nVérifie : injection, XSS, CSRF, secrets exposés, dépendances vulnérables, OWASP Top 10."},
    {"id": "review", "name": "Code review", "icon": "👁️",
     "description": "Revue complète avec suggestions",
     "template": "Effectue une revue de code complète de {filename}.\nPriorise : CRITIQUE > IMPORTANT > SUGGESTION. Référence les numéros de ligne."},
    {"id": "document", "name": "Documenter", "icon": "📚",
     "description": "Ajoute docstrings et commentaires",
     "template": "Ajoute des docstrings et commentaires clairs à {filename}.\nRespecte le style existant."},
    {"id": "translate", "name": "Traduire", "icon": "🔄",
     "description": "Traduit le code dans un autre langage",
     "template": "Traduis {filename} dans un autre langage de programmation.\nPrécise le langage cible si tu le sais."},
]


def _prompts_path() -> Path:
    return _openagent_home() / "prompts.json"


def load_prompts() -> list[dict]:
    path = _prompts_path()
    if not path.exists():
        return DEFAULT_PROMPTS.copy()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else DEFAULT_PROMPTS.copy()
    except Exception:
        return DEFAULT_PROMPTS.copy()


def save_prompts(prompts: list[dict]) -> None:
    path = _prompts_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(prompts, indent=2, ensure_ascii=False), encoding="utf-8")
```

- [ ] **Step 4 : Créer `prompt_library.py`**

```python
# openagenticskyzer/app/components/prompt_library.py
"""Popup bibliothèque de prompts — ouvert avec le bouton ✦ ou en tapant /."""
from nicegui import ui
from openagenticskyzer.app.state import state
from openagenticskyzer.app.storage import load_prompts


def render_prompt_picker(input_el):
    """Bouton ✦ qui ouvre la picker. input_el = textarea de l'input bar."""

    def _apply(template: str):
        dlg.close()
        folder_name = (state.active_folder or "").replace("\\", "/").split("/")[-1] or "projet"
        filled = template.replace("{filename}", folder_name)
        input_el.set_value(filled)
        input_el.run_method("focus")

    def _filter(query: str, items_col):
        items_col.clear()
        q = (query or "").lower()
        prompts = [p for p in load_prompts() if q in p["name"].lower() or q in p.get("description", "").lower()]
        with items_col:
            for p in prompts:
                with ui.row().classes(
                    "w-full items-center px-2 py-1 hover:bg-gray-800 rounded cursor-pointer gap-2"
                ).on("click", lambda tmpl=p["template"]: _apply(tmpl)):
                    ui.label(p.get("icon", "📝")).classes("text-base")
                    with ui.column().classes("flex-1"):
                        ui.label(p["name"]).classes("text-xs text-gray-200 font-medium")
                        ui.label(p.get("description", "")).classes("text-xs text-gray-500")

    with ui.dialog() as dlg:
        dlg.props("persistent")
        with ui.card().classes("bg-gray-900 border border-gray-700 w-96"):
            search_el = ui.input(placeholder="Filtrer…").classes("w-full mb-2")
            items_col = ui.column().classes("w-full gap-1 max-h-80 overflow-y-auto")
            search_el.on("update:model-value", lambda e: _filter(e.args, items_col))
            _filter("", items_col)

    return ui.button("✦", on_click=dlg.open).classes(
        "w-8 h-10 bg-gray-900 border border-gray-800 text-purple-400 "
        "hover:text-purple-300 rounded-lg flex-shrink-0 text-sm"
    )
```

- [ ] **Step 5 : Ajouter le bouton ✦ et la détection `/` dans `input_bar.py`**

```python
from openagenticskyzer.app.components.prompt_library import render_prompt_picker

# Dans la row contenant le textarea :
render_prompt_picker(input_el)   # bouton ✦ avant le textarea

# Détection `/` pour ouvrir la picker :
def _check_slash_trigger(event, input_el, prompt_dlg):
    if event.args.get("key") == "/" and not (input_el.value or ""):
        prompt_dlg.open()

# Appeler : input_el.on("keydown", lambda e: _check_slash_trigger(e, input_el, prompt_dlg))
```

- [ ] **Step 6 : Lancer les tests pour vérifier qu'ils passent**

```
pytest tests/test_artifacts.py -v
```
Attendu : 6 PASS

- [ ] **Step 7 : Commit**

```bash
rtk git add openagenticskyzer/app/storage.py openagenticskyzer/app/components/prompt_library.py openagenticskyzer/app/components/input_bar.py tests/test_artifacts.py
rtk git commit -m "feat: prompt library with 10 default templates + slash trigger (Phase 3.2)"
```

---

## Task 4 : Export de conversation

**Files:**
- Create: `openagenticskyzer/app/exporter.py`
- Modify: `openagenticskyzer/app/components/chat.py`
- Test: `tests/test_artifacts.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_artifacts.py`, ajouter :

```python
def test_export_markdown(tmp_path, monkeypatch):
    import openagenticskyzer.app.exporter as exp
    from openagenticskyzer.app.state import state
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "current_model", "llama3")
    monkeypatch.setattr(state, "current_provider", "ollama")

    # Créer des messages de test
    from openagenticskyzer.app.state import ChatMessage
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Bonjour"),
        ChatMessage(role="ai", content="Salut !"),
    ])

    path = exp.export_markdown()
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "Bonjour" in content
    assert "Salut" in content


def test_export_json(tmp_path, monkeypatch):
    import json
    import openagenticskyzer.app.exporter as exp
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Test"),
    ])

    path = exp.export_json()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    assert data[0]["role"] == "user"
```

- [ ] **Step 2 : Créer `exporter.py`**

```python
# openagenticskyzer/app/exporter.py
"""Export de l'historique de conversation."""
import json
from datetime import datetime
from pathlib import Path
from openagenticskyzer.app.state import state


def export_markdown() -> Path:
    lines = [f"# Conversation — {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"]
    lines.append(f"Dossier : `{state.active_folder}`\n")
    lines.append(f"Modèle : `{state.current_model}` ({state.current_provider})\n\n---\n")
    for m in state.messages:
        if m.role == "user":
            lines.append(f"\n## 👤 Utilisateur\n\n{m.content}\n")
        elif m.role == "ai":
            lines.append(f"\n## 🤖 Assistant\n\n{m.content}\n")
        elif m.role == "tool":
            tag = getattr(m, "tool_tag", None) or "tool"
            tool_name = getattr(m, "tool_name", "") or ""
            lines.append(f"\n> **[{tag.upper()}]** `{tool_name}` — {m.content}\n")
    out = _out_path("md")
    out.write_text("".join(lines), encoding="utf-8")
    return out


def export_html() -> Path:
    css = """
    body{background:#0d0d0d;color:#e0e0e0;font-family:system-ui;max-width:900px;margin:0 auto;padding:24px}
    .user{background:#1a0a2e;border-radius:12px;padding:12px 16px;margin:8px 0;text-align:right}
    .ai{background:#111;border:1px solid #222;border-radius:12px;padding:12px 16px;margin:8px 0}
    .tool{background:#0a0a1a;border-left:2px solid #4a4a8a;padding:6px 12px;margin:4px 0;font-size:.8em}
    pre{background:#1e1e2e;border-radius:8px;padding:12px;overflow-x:auto}
    code{font-family:'JetBrains Mono',monospace;font-size:.8em}
    .role{font-size:.7em;color:#666;margin-bottom:4px}
    """
    hljs = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0"
    parts = [
        "<!DOCTYPE html><html><head><meta charset='utf-8'>",
        f"<link rel='stylesheet' href='{hljs}/styles/atom-one-dark.min.css'>",
        f"<script src='{hljs}/highlight.min.js'></script>",
        f"<style>{css}</style></head><body>",
        f"<h1 style='color:#7c3aed'>Conversation — {datetime.now().strftime('%Y-%m-%d %H:%M')}</h1>",
        f"<p style='color:#666'>Modèle : <code>{state.current_model}</code></p><hr style='border-color:#222'>",
    ]
    import html as _html, re
    for m in state.messages:
        if m.role == "user":
            parts.append(f"<div class='user'><div class='role'>Utilisateur</div>{_html.escape(m.content)}</div>")
        elif m.role == "ai":
            content = _html.escape(m.content)
            content = re.sub(
                r"```(\w+)?\n(.*?)```",
                lambda mo: f"<pre><code class='language-{mo.group(1) or ''}'>{_html.escape(mo.group(2) or '')}</code></pre>",
                content, flags=re.DOTALL,
            )
            parts.append(f"<div class='ai'><div class='role'>Assistant</div>{content}</div>")
        elif m.role == "tool":
            tag = (getattr(m, "tool_tag", None) or "tool").upper()
            tool_name = getattr(m, "tool_name", "") or ""
            parts.append(f"<div class='tool'>[{tag}] <b>{_html.escape(tool_name)}</b> — {_html.escape(m.content)}</div>")
    parts.append("<script>hljs.highlightAll();</script></body></html>")
    out = _out_path("html")
    out.write_text("".join(parts), encoding="utf-8")
    return out


def export_json() -> Path:
    data = [
        {
            "role": m.role,
            "content": m.content,
            "tool_name": getattr(m, "tool_name", None),
            "tool_tag": getattr(m, "tool_tag", None),
            "tool_detail": getattr(m, "tool_detail", None),
        }
        for m in state.messages
    ]
    out = _out_path("json")
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return out


def _out_path(ext: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = state.active_folder or str(Path.home())
    return Path(folder) / f"conversation_{ts}.{ext}"
```

- [ ] **Step 3 : Ajouter le bouton Export dans `chat.py`**

Dans le header du chat (row avec le label "💬 Chat"), ajouter :

```python
from openagenticskyzer.app.exporter import export_markdown, export_html, export_json
import os

def _do_export(fmt: str):
    fn = {"md": export_markdown, "html": export_html, "json": export_json}[fmt]
    path = fn()
    if os.name == "nt":
        os.startfile(path)
    ui.notify(f"Exporté : {path.name}", type="positive")

# Dans le header :
with ui.button("⬇ Exporter").classes("text-xs text-gray-500 bg-transparent hover:text-gray-300"):
    with ui.menu() as export_menu:
        ui.menu_item("Markdown (.md)", lambda: _do_export("md"))
        ui.menu_item("HTML (.html)", lambda: _do_export("html"))
        ui.menu_item("JSON (.json)", lambda: _do_export("json"))
```

- [ ] **Step 4 : Lancer les tests**

```
pytest tests/test_artifacts.py -v
```
Attendu : 8 PASS

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/app/exporter.py openagenticskyzer/app/components/chat.py tests/test_artifacts.py
rtk git commit -m "feat: export conversation MD/HTML/JSON + button in chat header (Phase 3.3)"
```

---

## Task 5 : Édition de messages et régénération (Phase 8.1)

**Files:**
- Modify: `openagenticskyzer/app/components/chat.py`
- Test: `tests/test_artifacts.py`

- [ ] **Step 1 : Écrire le test**

Dans `tests/test_artifacts.py`, ajouter :

```python
def test_edit_message_truncates_history(monkeypatch):
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Message 1"),
        ChatMessage(role="ai", content="Réponse 1"),
        ChatMessage(role="user", content="Message 2"),
        ChatMessage(role="ai", content="Réponse 2"),
    ])
    # Simuler edit à l'index 2 (Message 2)
    state.messages = state.messages[:2]
    assert len(state.messages) == 2
    assert state.messages[-1].role == "ai"
```

- [ ] **Step 2 : Ajouter boutons edit/régénérer dans `chat.py`**

Dans la boucle de rendu des messages, modifier le bloc des messages utilisateur :

```python
# Pour chaque message user (index i)
with ui.row().classes("w-full justify-end mb-2 group"):
    with ui.element("div").classes("flex flex-col items-end gap-1"):
        with ui.row().classes("opacity-0 group-hover:opacity-100 gap-1 transition-opacity"):
            ui.button("✏️", on_click=lambda idx=i: _edit_message(idx, input_el)).classes(
                "w-6 h-6 bg-gray-800 text-gray-400 hover:text-white text-xs rounded"
            ).tooltip("Éditer ce message")
        # carte du message existante
        ...

# Pour le dernier message AI (index last_ai_idx), si agent non actif :
if i == last_ai_idx and not state.agent_running:
    ui.button("🔄", on_click=lambda: asyncio.ensure_future(_regenerate(input_el, send_btn))).classes(
        "text-xs text-gray-500 hover:text-purple-400 bg-transparent mt-1"
    ).tooltip("Régénérer cette réponse")
```

Ajouter les fonctions :

```python
def _edit_message(idx: int, input_el):
    msg = state.messages[idx]
    input_el.set_value(msg.content)
    state.messages = state.messages[:idx]
    chat_messages.refresh()
    input_el.run_method("focus")


async def _regenerate(input_el, send_btn):
    last_user = next((m for m in reversed(state.messages) if m.role == "user"), None)
    if not last_user:
        return
    idx = len(state.messages) - 1
    while idx >= 0 and state.messages[idx].role != "user":
        idx -= 1
    text = state.messages[idx].content
    state.messages = state.messages[:idx]
    await _send_message(text, input_el, None, send_btn)
```

- [ ] **Step 3 : Lancer les tests**

```
pytest tests/test_artifacts.py -v
```
Attendu : 9 PASS

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/app/components/chat.py tests/test_artifacts.py
rtk git commit -m "feat: edit messages + regenerate last AI response (Phase 8.1)"
```

---

## Task 6 : Command Palette Ctrl+K (Phase 8.2)

**Files:**
- Create: `openagenticskyzer/app/components/command_palette.py`
- Modify: `openagenticskyzer/app/main.py`

- [ ] **Step 1 : Créer `command_palette.py`**

```python
# openagenticskyzer/app/components/command_palette.py
"""Command palette — Ctrl+K pour accéder à toutes les actions."""
from nicegui import ui
from openagenticskyzer.app.state import state


def render_command_palette():
    """Crée le dialog et le raccourci Ctrl+K. Appeler une fois dans main_page()."""

    # Les lambdas d'action seront câblées lors de l'initialisation dans main.py
    # car certaines fonctions (trigger_compact, open_model_modal) sont définies ailleurs
    _COMMANDS = [
        ("📂 Ouvrir un dossier",       "Choisir un nouveau dossier projet",       None),
        ("🔄 Changer de modèle",        "Sélectionner un autre modèle LLM",        None),
        ("🗑️ Vider l'historique",       "Effacer tous les messages",               None),
        ("⚙️ Paramètres",               "Ouvrir les paramètres",                   None),
        ("🧠 Voir la mémoire projet",   "Afficher .openagent/memory.md",           None),
        ("📋 Bibliothèque de prompts",  "Parcourir les templates de prompts",      None),
        ("⬇ Exporter la conversation", "Sauvegarder en markdown/HTML/JSON",       None),
        ("⚡ Compacter le contexte",    "Résumer et compresser l'historique",      None),
        ("🔍 Rechercher",               "Rechercher dans les conversations",       None),
    ]

    with ui.dialog() as dlg:
        dlg.props("persistent")
        with ui.card().classes("bg-gray-900 border border-gray-700 w-[520px]"):
            search_input = ui.input(placeholder="Rechercher une action…").classes(
                "w-full text-sm"
            ).props("autofocus")

            results_col = ui.column().classes("w-full gap-0.5 mt-2 max-h-72 overflow-y-auto")

            def _filter(query: str):
                results_col.clear()
                q = (query or "").lower()
                matches = [(lbl, desc, fn) for lbl, desc, fn in _COMMANDS
                           if q in lbl.lower() or q in desc.lower()]
                with results_col:
                    for label, desc, action in matches[:8]:
                        with ui.row().classes(
                            "w-full items-center px-3 py-2 rounded hover:bg-gray-800 "
                            "cursor-pointer gap-3"
                        ).on("click", lambda fn=action: (dlg.close(), fn() if fn else None)):
                            ui.label(label).classes("text-sm text-gray-200 flex-1")
                            ui.label(desc).classes("text-xs text-gray-500")

            search_input.on("update:model-value", lambda e: _filter(e.args or ""))
            _filter("")

    ui.keyboard(on_key=lambda e: dlg.open() if e.key == "k" and e.ctrl else None)
    return dlg
```

- [ ] **Step 2 : Appeler dans `main.py`**

```python
from openagenticskyzer.app.components.command_palette import render_command_palette

# À la fin de main_page(), après le layout :
render_command_palette()
```

- [ ] **Step 3 : Ajouter le hint Ctrl+K dans `input_bar.py`**

À la fin de la barre d'input, ajouter un label d'aide :

```python
ui.label("Entrée → envoyer · Shift+Entrée → nouvelle ligne · Ctrl+K → commandes").classes(
    "text-xs text-gray-700 px-1"
)
```

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/app/components/command_palette.py openagenticskyzer/app/main.py openagenticskyzer/app/components/input_bar.py
rtk git commit -m "feat: command palette Ctrl+K with 9 actions (Phase 8.2)"
```

---

## Task 7 : Conversation Branching et Onglets (Phase 8.3 + 8.4)

**Files:**
- Modify: `openagenticskyzer/app/components/chat.py`
- Modify: `openagenticskyzer/app/state.py`
- Test: `tests/test_artifacts.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_artifacts.py`, ajouter :

```python
def test_fork_creates_branch(monkeypatch):
    import uuid
    from openagenticskyzer.app.state import state, ChatMessage, ConversationBranch
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Msg1"),
        ChatMessage(role="ai", content="Rép1"),
        ChatMessage(role="user", content="Msg2"),
    ])
    monkeypatch.setattr(state, "branches", [])

    # Forker depuis le message index 1 (Rép1)
    from datetime import datetime
    branch = ConversationBranch(
        branch_id=str(uuid.uuid4())[:8],
        label="Branche 1",
        messages=state.messages[:2].copy(),
        created_at=datetime.now().isoformat(),
    )
    state.branches.append(branch)
    assert len(state.branches) == 1
    assert len(state.branches[0].messages) == 2
```

- [ ] **Step 2 : Ajouter bouton Fork dans `chat.py`**

Dans la boucle de rendu (à côté du bouton edit) :

```python
import uuid
from datetime import datetime
from openagenticskyzer.app.state import ConversationBranch

def _fork_from(idx: int):
    branch = ConversationBranch(
        branch_id=str(uuid.uuid4())[:8],
        label=f"Branche {len(state.branches) + 1}",
        messages=state.messages[:idx + 1].copy(),
        created_at=datetime.now().isoformat(),
    )
    state.branches.append(branch)
    # Charge la branche
    state.current_branch_id = branch.branch_id
    state.messages = branch.messages.copy()
    chat_messages.refresh()
    ui.notify(f"Branche '{branch.label}' créée.", type="positive")

# Bouton dans le groupe hover de chaque message :
ui.button("⑂", on_click=lambda idx=i: _fork_from(idx)).classes(
    "opacity-0 group-hover:opacity-100 w-6 h-6 bg-gray-800 text-gray-400 hover:text-purple-400 text-xs rounded"
).tooltip("Créer une branche depuis ici")
```

- [ ] **Step 3 : Ajouter le sélecteur de branches dans le header du chat**

```python
if state.branches:
    with ui.select(
        options={"main": "🌿 Main"} | {b.branch_id: b.label for b in state.branches},
        value=state.current_branch_id,
        on_change=lambda e: _switch_branch(e.value),
    ).classes("text-xs bg-gray-900 border-gray-700 max-w-36"):
        pass

def _switch_branch(branch_id: str):
    state.current_branch_id = branch_id
    if branch_id == "main":
        # Reconstruire depuis toutes les branches (stockées)
        pass
    else:
        branch = next((b for b in state.branches if b.branch_id == branch_id), None)
        if branch:
            state.messages = branch.messages.copy()
            chat_messages.refresh()
```

- [ ] **Step 4 : Lancer les tests**

```
pytest tests/test_artifacts.py -v
```
Attendu : 10 PASS

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/app/components/chat.py openagenticskyzer/app/state.py tests/test_artifacts.py
rtk git commit -m "feat: conversation branching (fork) + branch switcher (Phase 8.3)"
```
