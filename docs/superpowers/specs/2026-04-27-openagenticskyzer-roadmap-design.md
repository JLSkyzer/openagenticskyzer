# OpenAgentic Skyzer — Roadmap Technique Complète

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan phase-by-phase. Each phase is an independent sprint with its own spec → plan → implementation cycle.

**Goal:** Transformer OpenAgentic Skyzer en une app IA locale complète, compétitive face à Cursor, Claude.ai et GitHub Copilot, avec streaming, git, vision, indexation sémantique, plugins et multi-agents.

**Architecture de base (déjà en place):**
- LangGraph agent (ask/auto/plan modes) + 14 outils LangChain
- GUI NiceGUI + PyWebView (port 8765, dark theme)
- AppState singleton partagé entre composants
- Providers: Ollama, LM Studio, Groq, Mistral, Together, Gemini, OpenRouter
- Permissions 3 niveaux (demander / auto / strict)
- Pré-fetch web multi-sources dans input_bar.py

**Tech stack:** Python ≥3.10, NiceGUI ≥1.4, LangGraph ≥0.2, LangChain Core ≥1.2.22

---

## Phase 1 — UX Professionnelle

### 1.1 Streaming token par token

**Objectif:** Les tokens s'affichent en temps réel dans le chat, comme sur Claude.ai ou Cursor.

**Approche technique:**

Le graph LangGraph compilé supporte `.astream_events()` qui émet des événements par type. On utilise `on_chat_model_stream` pour capturer chaque chunk de token.

**Fichiers modifiés:**
- `openagenticskyzer/app/state.py` — ajouter 2 champs
- `openagenticskyzer/app/components/chat.py` — ajouter rendu streaming
- `openagenticskyzer/app/components/input_bar.py` — remplacer `run.io_bound(agent.invoke)` par boucle async

**Modifications state.py:**
```python
@dataclass
class AppState:
    # ... champs existants ...
    streaming_content: str = ""   # tokens accumulés en cours de streaming
    is_streaming: bool = False     # True pendant qu'on reçoit des tokens
```

**Modification input_bar.py — _send_message:**
Remplacer le bloc `result = await run.io_bound(agent.invoke, ...)` par:

```python
state.is_streaming = True
state.streaming_content = ""
chat_messages.refresh()  # affiche placeholder streaming

async def _stream():
    async for event in agent.astream_events(
        {"messages": history + [{"role": "user", "content": user_content_for_agent}]},
        version="v2",
        config={"recursion_limit": 300, "callbacks": [GUIAgentCallback()]},
    ):
        kind = event.get("event", "")
        if kind == "on_chat_model_stream":
            chunk = event["data"].get("chunk")
            if chunk and hasattr(chunk, "content"):
                delta = chunk.content
                if isinstance(delta, str):
                    state.streaming_content += delta
                elif isinstance(delta, list):
                    for part in delta:
                        if isinstance(part, dict) and part.get("type") == "text":
                            state.streaming_content += part.get("text", "")
        elif kind == "on_tool_start":
            # tool call détecté → déjà géré par GUIAgentCallback
            pass

await _stream()
state.is_streaming = False
ai_text = state.streaming_content
state.streaming_content = ""
```

**Modification chat.py — rendu streaming:**
Dans la fonction `chat_messages()` refreshable, ajouter en bas, après les messages permanents :

```python
if state.is_streaming and state.streaming_content:
    with ui.row().classes("w-full justify-start mb-2"):
        ui.label("AI").classes("w-6 h-6 rounded-full bg-purple-600 text-white text-xs flex items-center justify-center flex-shrink-0")
        with ui.card().classes("max-w-3xl bg-gray-900 border border-gray-800 rounded-xl px-4 py-3"):
            ui.markdown(state.streaming_content).classes("text-sm text-gray-200 streaming-message")
elif state.agent_running and not state.is_streaming:
    # afficher animation typing dots (déjà existant)
    ...
```

**Timer de refresh:** Le `ui.timer(0.4)` existant dans `main.py` déclenche `chat_messages.refresh()` quand `state.agent_running`. Réduire à `0.08` secondes quand `state.is_streaming` pour un affichage fluide :

```python
def _tick():
    if state.is_streaming:
        chat_messages.refresh()   # refresh rapide pour le streaming
    elif state.agent_running:
        chat_messages.refresh()   # refresh normal pour les outils
    # ... reste du tick ...
```

**Note:** `astream_events` nécessite que le graph soit compilé sans `checkpointer` sync-only. Le graph actuel est compatible. Les outils LangGraph `ToolNode` émettent aussi des events `on_tool_start`/`on_tool_end` gérés par `GUIAgentCallback`.

---

### 1.2 Coloration syntaxique dans le chat

**Objectif:** Les blocs de code dans les messages AI ont la coloration syntaxique (Python, JS, Bash, etc.).

**Approche technique:** Inject highlight.js via CDN dans le `<head>`. Déclencher `hljs.highlightAll()` après chaque refresh du chat via `ui.run_javascript()`.

**Fichiers modifiés:**
- `openagenticskyzer/app/main.py` — injection CSS/JS
- `openagenticskyzer/app/components/chat.py` — déclencher highlight après refresh

**Injection dans main.py** (dans `main_page()`, après `ui.add_head_html(f"<style>{CSS}</style>")`):

```python
ui.add_head_html("""
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
  function applyHighlight() {
    document.querySelectorAll('pre code:not(.hljs)').forEach(el => {
      hljs.highlightElement(el);
    });
  }
</script>
""")
```

**Déclenchement dans chat.py** — dans `chat_messages()` après le rendu, appeler:

```python
ui.run_javascript("setTimeout(applyHighlight, 50)")
```

**CSS supplémentaire** à ajouter dans la constante `CSS` de main.py:

```css
.nicegui-markdown pre {
    background: #1e1e2e !important;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    padding: 12px 16px;
    overflow-x: auto;
}
.nicegui-markdown code {
    font-family: 'JetBrains Mono', 'Fira Code', monospace !important;
    font-size: 0.8rem;
}
.nicegui-markdown pre code {
    background: none !important;
    padding: 0;
}
.hljs { background: transparent !important; }
```

**Rendu markdown amélioré:** Les messages AI utilisent `ui.markdown()`. NiceGUI markdown supporte les fenced code blocks (``` python ```) nativement via marked.js. Le highlight.js appliqué en post-processing les colore.

---

### 1.3 Notifications OS

**Objectif:** Notification système quand une tâche longue (>10s) se termine, même si la fenêtre est en arrière-plan.

**Nouveau fichier:** `openagenticskyzer/app/notifier.py`

```python
"""Notifications système cross-platform."""
import time

_start_time: float = 0.0
_MIN_DURATION_S = 10  # n'affiche la notification que si la tâche a duré >10s


def task_started():
    global _start_time
    _start_time = time.monotonic()


def task_finished(summary: str = "Tâche terminée"):
    duration = time.monotonic() - _start_time
    if duration < _MIN_DURATION_S:
        return
    try:
        from plyer import notification
        notification.notify(
            title="OpenAgentic Skyzer",
            message=summary[:200],
            app_name="OpenAgentic Skyzer",
            timeout=6,
        )
    except Exception:
        pass  # plyer non disponible ou OS non supporté
```

**Intégration dans input_bar.py:**

```python
from openagenticskyzer.app.notifier import task_started, task_finished

async def _send_message(...):
    task_started()
    try:
        ...
    finally:
        short_summary = ai_text[:100] if ai_text else "Terminé"
        task_finished(short_summary)
        ...
```

**Nouvelle dépendance** dans `pyproject.toml` group `[app]`:
```toml
"plyer>=2.1",
```

**Toggle dans settings.py** — section "Interface":
```python
ui.switch(value=cfg.get("os_notifications", True)).bind_value_to(cfg, "os_notifications")
```

**Guard dans notifier.py:**
```python
from openagenticskyzer.app.storage import load_global_config
if not load_global_config().get("os_notifications", True):
    return
```

---

## Phase 2 — Outils Dev Essentiels

### 2.1 Intégration Git complète

**Objectif:** L'agent peut faire tout le workflow git : status, diff, commit, push, pull, log, blame, branches, PR description.

**Nouveau fichier:** `openagenticskyzer/tools/git_tools.py`

**Outils à créer** (tous via `subprocess.run(["git", ...], cwd=cwd, capture_output=True, text=True, encoding="utf-8")`):

| Outil LangChain | Commande git | Permission requise |
|---|---|---|
| `git_status()` | `git status --short` | Non |
| `git_diff(file=None)` | `git diff [file]` | Non |
| `git_diff_staged()` | `git diff --staged` | Non |
| `git_log(n=10, oneline=True)` | `git log --oneline -n {n}` | Non |
| `git_blame(file, start=1, end=None)` | `git blame -L {start},{end} {file}` | Non |
| `git_branch_list()` | `git branch -a` | Non |
| `git_commit(message, files=None)` | `git add {files} && git commit -m "{message}"` | **Oui** |
| `git_push(remote="origin", branch=None)` | `git push {remote} {branch}` | **Oui** |
| `git_pull(remote="origin")` | `git pull {remote}` | **Oui** |
| `git_checkout(branch)` | `git checkout {branch}` | **Oui** |
| `git_create_branch(name, from_branch=None)` | `git checkout -b {name} [{from}]` | **Oui** |
| `git_stash(message=None)` | `git stash [push -m "{message}"]` | Non |
| `git_stash_pop()` | `git stash pop` | **Oui** |
| `git_add(files)` | `git add {files}` | **Oui** |

**Pattern de chaque outil:**

```python
@tool
def git_status() -> str:
    """Show the working tree status (short format). Use to see modified/untracked files."""
    from openagenticskyzer.app.state import state
    cwd = state.active_folder or "."
    result = subprocess.run(
        ["git", "status", "--short", "--branch"],
        cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=15
    )
    if result.returncode != 0:
        return f"Error: {result.stderr.strip()}"
    return result.stdout.strip() or "Working tree clean."
```

**Intégration dans agent.py:**

```python
from openagenticskyzer.tools.git_tools import (
    git_status, git_diff, git_diff_staged, git_log, git_blame,
    git_branch_list, git_commit, git_push, git_pull,
    git_checkout, git_create_branch, git_stash, git_stash_pop, git_add,
)

_ALL_TOOLS = [
    # ... outils existants ...
    git_status, git_diff, git_diff_staged, git_log, git_blame,
    git_branch_list, git_commit, git_push, git_pull,
    git_checkout, git_create_branch, git_stash, git_stash_pop, git_add,
]
```

**Outils à gates par permission** — modifier `permissions.py` pour ajouter:

```python
_RESTRICTED_TOOLS = {
    "run_command", "create_file", "edit_file", "delete_file",
    "delete_dir", "create_dir",
    # Git destructif
    "git_commit", "git_push", "git_pull", "git_checkout",
    "git_create_branch", "git_stash_pop", "git_add",
}
```

**Mise à jour du prompt** (`prompts/prompt.py`) — ajouter section GIT dans TOOLS:

```
GIT: git_status | git_diff([file]) | git_diff_staged | git_log([n]) | git_blame(file, start, end)
     git_add(files) | git_commit(message, [files]) | git_push([remote,branch]) | git_pull
     git_branch_list | git_checkout(branch) | git_create_branch(name) | git_stash | git_stash_pop
```

**UI — Widget git dans la sidebar:**

Nouveau composant optionnel dans `openagenticskyzer/app/components/sidebar.py` — en bas du sidebar, si un dossier git est ouvert :

```python
def _git_status_widget():
    """Affiche la branche courante et le statut dirty/clean."""
    if not state.active_folder:
        return
    try:
        result = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                                cwd=state.active_folder, capture_output=True,
                                text=True, encoding="utf-8", timeout=3)
        branch = result.stdout.strip() if result.returncode == 0 else None
        if branch:
            dirty = subprocess.run(["git", "status", "--porcelain"],
                                   cwd=state.active_folder, capture_output=True,
                                   text=True, encoding="utf-8", timeout=3).stdout.strip()
            label = f"⎇ {branch}" + (" ●" if dirty else " ✓")
            color = "text-yellow-400" if dirty else "text-green-400"
            ui.label(label).classes(f"text-xs {color} px-3 py-1")
    except Exception:
        pass
```

---

### 2.2 Upload de fichiers et Vision

**Objectif:** Glisser-déposer ou coller des fichiers (PDF, CSV, TXT, images) dans le chat pour les analyser. Support vision pour les modèles multimodaux.

**Types supportés:**
- `.txt`, `.md`, `.py`, `.js`, `.ts`, `.json`, `.yaml`, `.toml`, `.csv` → lecture directe
- `.pdf` → extraction texte via `pypdf`
- `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` → base64 pour vision multimodale
- `.csv` → lecture avec `csv.DictReader`, aperçu des 50 premières lignes

**Nouveau champ dans state.py:**

```python
@dataclass
class AttachedFile:
    name: str
    content_type: str   # "text" | "image" | "pdf" | "csv"
    content: str        # texte extrait OU base64 pour images
    size_kb: int

@dataclass
class AppState:
    # ... champs existants ...
    attached_files: list[AttachedFile] = field(default_factory=list)
```

**Nouveau fichier:** `openagenticskyzer/app/file_processor.py`

```python
"""Traitement des fichiers uploadés avant injection dans le contexte agent."""
import base64
import csv
import io
from pathlib import Path


def process_upload(name: str, raw_bytes: bytes) -> "AttachedFile | None":
    from openagenticskyzer.app.state import AttachedFile
    ext = Path(name).suffix.lower()
    size_kb = len(raw_bytes) // 1024

    if ext == ".pdf":
        return _process_pdf(name, raw_bytes, size_kb)
    elif ext == ".csv":
        return _process_csv(name, raw_bytes, size_kb)
    elif ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
        return _process_image(name, raw_bytes, size_kb, ext)
    elif ext in (".txt", ".md", ".py", ".js", ".ts", ".json",
                 ".yaml", ".yml", ".toml", ".html", ".css",
                 ".rs", ".go", ".java", ".c", ".cpp", ".sh"):
        text = raw_bytes.decode("utf-8", errors="replace")[:50_000]
        return AttachedFile(name=name, content_type="text", content=text, size_kb=size_kb)
    return None


def _process_pdf(name, raw_bytes, size_kb):
    from openagenticskyzer.app.state import AttachedFile
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(raw_bytes))
        text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
        return AttachedFile(name=name, content_type="pdf",
                           content=text[:50_000], size_kb=size_kb)
    except Exception as exc:
        return AttachedFile(name=name, content_type="text",
                           content=f"[Erreur lecture PDF: {exc}]", size_kb=size_kb)


def _process_csv(name, raw_bytes, size_kb):
    from openagenticskyzer.app.state import AttachedFile
    text = raw_bytes.decode("utf-8", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))[:50]
    preview = "\n".join(str(r) for r in rows)
    return AttachedFile(name=name, content_type="csv",
                       content=f"CSV ({len(rows)} lignes):\n{preview}", size_kb=size_kb)


def _process_image(name, raw_bytes, size_kb, ext):
    from openagenticskyzer.app.state import AttachedFile
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "webp": "image/webp", "gif": "image/gif"}.get(ext.lstrip("."), "image/png")
    b64 = base64.b64encode(raw_bytes).decode()
    return AttachedFile(name=name, content_type="image",
                       content=f"data:{mime};base64,{b64}", size_kb=size_kb)


def build_message_content(text: str, files: list) -> list | str:
    """Construit le contenu du message (str simple ou list multimodale)."""
    if not files:
        return text
    parts = []
    text_parts = []
    for f in files:
        if f.content_type == "image":
            parts.append({"type": "image_url", "image_url": {"url": f.content}})
        else:
            text_parts.append(f"--- Fichier : {f.name} ---\n{f.content}\n---")
    full_text = "\n\n".join(text_parts) + f"\n\n{text}" if text_parts else text
    if parts:
        parts.append({"type": "text", "text": full_text})
        return parts
    return full_text
```

**Modifications input_bar.py:**

Ajouter le bouton upload et l'affichage des fichiers attachés dans `render_input_bar()`:

```python
def render_input_bar():
    with ui.column()...:
        # Zone fichiers attachés (visible si state.attached_files non vide)
        attached_row = ui.row().classes("w-full flex-wrap gap-1 px-1")
        _render_attached_chips(attached_row)

        with ui.row()...:
            # Bouton upload (📎)
            ui.button("📎", on_click=lambda: upload_dialog.open()).classes(
                "w-8 h-10 bg-gray-900 border border-gray-800 text-gray-500 rounded-lg flex-shrink-0"
            )
            input_el = ...  # textarea existant
            ...

    # Dialog upload caché
    with ui.dialog() as upload_dialog:
        with ui.card().classes("bg-gray-900 border border-gray-700"):
            ui.label("Joindre un fichier").classes("text-sm text-gray-300 font-medium mb-2")
            ui.upload(
                multiple=True,
                on_upload=lambda e: _on_file_upload(e, attached_row),
            ).classes("w-full")
            ui.button("Fermer", on_click=upload_dialog.close).classes("mt-2 text-xs")
```

**Handler upload:**

```python
def _on_file_upload(event, attached_row):
    from openagenticskyzer.app.file_processor import process_upload
    af = process_upload(event.name, event.content.read())
    if af:
        state.attached_files.append(af)
        attached_row.clear()
        _render_attached_chips(attached_row)
    upload_dialog.close()


def _render_attached_chips(container):
    container.clear()
    for i, f in enumerate(state.attached_files):
        icon = "🖼️" if f.content_type == "image" else "📄" if f.content_type == "pdf" else "📊" if f.content_type == "csv" else "📝"
        with container:
            with ui.chip(f"{icon} {f.name} ({f.size_kb}kb)").classes("bg-gray-800 text-gray-300 text-xs"):
                ui.button("×", on_click=lambda idx=i: _remove_file(idx, container)).classes(
                    "text-gray-500 hover:text-red-400 text-xs"
                )
```

**Injection dans _send_message:**

```python
from openagenticskyzer.app.file_processor import build_message_content

# Avant la construction du message pour l'agent:
final_content = build_message_content(user_content_for_agent, state.attached_files)
state.attached_files.clear()  # reset après envoi

# Dans l'invocation:
{"role": "user", "content": final_content}  # peut être str ou list
```

**Nouvelle dépendance:**
```toml
[project.optional-dependencies]
app = [
    # ... existants ...
    "pypdf>=4.0",
]
```

---

## Phase 3 — Contenu & Productivité

### 3.1 Artifacts / Preview

**Objectif:** Quand l'agent génère du HTML, SVG, ou Mermaid, l'afficher en direct dans un panneau latéral droit.

**Détection dans chat.py / input_bar.py:**

```python
import re as _re

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
```

**Nouveau champ state.py:**

```python
@dataclass
class AppState:
    # ... champs existants ...
    artifact_type: str = ""    # "html" | "svg" | "mermaid" | ""
    artifact_content: str = "" # contenu de l'artifact
    show_artifact: bool = False
```

**Nouveau composant:** `openagenticskyzer/app/components/artifact_panel.py`

```python
"""Panneau de preview d'artifact (HTML, SVG, Mermaid)."""
from nicegui import ui
from openagenticskyzer.app.state import state


@ui.refreshable
def artifact_panel():
    if not state.show_artifact or not state.artifact_content:
        return
    with ui.column().classes("h-full border-l border-gray-800 bg-gray-950").style("width:400px;flex-shrink:0"):
        # Header
        with ui.row().classes("items-center px-3 py-2 border-b border-gray-800 gap-2"):
            ui.label(f"Preview — {state.artifact_type.upper()}").classes("text-xs text-gray-400 flex-1")
            ui.button("✕", on_click=lambda: _close_artifact()).classes(
                "w-6 h-6 bg-transparent text-gray-500 hover:text-white text-xs"
            )

        # Contenu
        with ui.scroll_area().classes("flex-1 w-full"):
            if state.artifact_type == "html":
                # iframe sandboxé
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

**Injection Mermaid.js dans main.py:**

```python
ui.add_head_html("""
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad: false, theme: 'dark'});</script>
""")
```

**Déclenchement après réponse AI dans input_bar.py:**

```python
from openagenticskyzer.app.components.artifact_panel import artifact_panel, _extract_artifact

if ai_text:
    artifact = _extract_artifact(ai_text)
    if artifact:
        state.artifact_type, state.artifact_content = artifact
        state.show_artifact = True
        artifact_panel.refresh()
```

**Intégration dans le layout main.py:**

```python
# Dans la zone principale (Content Column), après chat scroll area:
with ui.row().classes("flex-1 overflow-hidden"):
    with ui.column().classes("flex-1"):
        render_chat()
        render_context_bar()
        render_input_bar()
    artifact_panel()   # panneau droit, 400px, visible si show_artifact
```

---

### 3.2 Bibliothèque de prompts

**Objectif:** Templates de prompts pré-définis (refactor, tests, PR description, etc.) accessibles d'un clic ou via le raccourci `/`.

**Format des templates (JSON):**

```json
{
  "id": "refactor",
  "name": "Refactoriser",
  "icon": "🔧",
  "description": "Améliore la lisibilité et la structure du code",
  "template": "Refactorise ce fichier en suivant les bonnes pratiques : {filename}\n\nObjectifs :\n- Nommer clairement les fonctions et variables\n- Réduire la duplication\n- Améliorer la lisibilité\n- Ajouter des types si manquants"
}
```

**Templates par défaut à inclure:**

| ID | Nom | Cas d'usage |
|---|---|---|
| `refactor` | Refactoriser | Améliore la structure du code |
| `tests` | Écrire les tests | Génère des tests unitaires |
| `explain` | Expliquer | Explique le code sélectionné |
| `pr_desc` | Description PR | Génère une description de Pull Request depuis le git diff |
| `document` | Documenter | Ajoute docstrings et commentaires |
| `debug` | Déboguer | Analyse une erreur et propose un fix |
| `optimize` | Optimiser | Améliore les performances |
| `security` | Audit sécurité | Cherche les vulnérabilités |
| `review` | Code review | Revue complète avec suggestions |
| `translate` | Traduire | Traduit le code dans un autre langage |

**Stockage dans storage.py — ajouter:**

```python
def _prompts_path() -> Path:
    return _openagent_home() / "prompts.json"

DEFAULT_PROMPTS: list[dict] = [
    {"id": "refactor", "name": "Refactoriser", "icon": "🔧", ...},
    # ... tous les templates par défaut ...
]

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

**Nouveau composant:** `openagenticskyzer/app/components/prompt_library.py`

```python
"""Popup bibliothèque de prompts — ouvert avec le bouton ✦ ou en tapant /."""
from nicegui import ui
from openagenticskyzer.app.state import state
from openagenticskyzer.app.storage import load_prompts


def render_prompt_picker(input_el):
    """Bouton ✦ qui ouvre la picker. input_el = textarea de l'input bar."""

    def _apply(template: str):
        dlg.close()
        # Substitutions variables
        folder_name = (state.active_folder or "").split("\\")[-1].split("/")[-1]
        filled = template.replace("{filename}", folder_name)
        input_el.set_value(filled)
        input_el.run_method("focus")

    with ui.dialog() as dlg:
        dlg.props("persistent")
        with ui.card().classes("bg-gray-900 border border-gray-700 w-96"):
            ui.input(placeholder="Filtrer…").classes("w-full mb-2").on(
                "update:model-value", lambda e: _filter(e.args, items_col)
            )
            items_col = ui.column().classes("w-full gap-1 max-h-80 overflow-y-auto")
            with items_col:
                for p in load_prompts():
                    with ui.row().classes("w-full items-center px-2 py-1 hover:bg-gray-800 rounded cursor-pointer gap-2").on(
                        "click", lambda tmpl=p["template"]: _apply(tmpl)
                    ):
                        ui.label(p.get("icon", "📝")).classes("text-base")
                        with ui.column().classes("flex-1"):
                            ui.label(p["name"]).classes("text-xs text-gray-200 font-medium")
                            ui.label(p.get("description", "")).classes("text-xs text-gray-500")

    return ui.button("✦", on_click=dlg.open).classes(
        "w-8 h-10 bg-gray-900 border border-gray-800 text-purple-400 "
        "hover:text-purple-300 rounded-lg flex-shrink-0 text-sm"
    )
```

**Intégration dans input_bar.py** — ajouter le bouton à côté du textarea:

```python
from openagenticskyzer.app.components.prompt_library import render_prompt_picker

with ui.row()...:
    render_prompt_picker(input_el)   # bouton ✦
    input_el = ui.textarea(...)
    model_button()
    send_btn = ...
```

**Détection `/` dans le textarea** — si le message commence par `/`, ouvrir la picker:

```python
input_el.on("keydown", lambda e: _check_slash_trigger(e, input_el))

def _check_slash_trigger(event, input_el):
    if event.args.get("key") == "/" and not input_el.value:
        prompt_dlg.open()
        return True  # prevent default
```

---

### 3.3 Export de conversation

**Objectif:** Exporter l'historique du chat en Markdown, HTML stylisé, ou JSON brut.

**Nouveau fichier:** `openagenticskyzer/app/exporter.py`

```python
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
            tag = m.tool_tag or "tool"
            lines.append(f"\n> **[{tag.upper()}]** `{m.tool_name}` — {m.content}\n")
            if m.tool_diff:
                lines.append(f"\n```diff\n{m.tool_diff}\n```\n")
    out = _out_path("md")
    out.write_text("".join(lines), encoding="utf-8")
    return out


def export_html() -> Path:
    """HTML autonome avec highlight.js embarqué, CSS dark theme, balises <details> pour les tools."""
    from openagenticskyzer.app.state import state
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
    parts = [f"<!DOCTYPE html><html><head><meta charset='utf-8'>",
             f"<link rel='stylesheet' href='{hljs}/styles/atom-one-dark.min.css'>",
             f"<script src='{hljs}/highlight.min.js'></script>",
             f"<style>{css}</style></head><body>",
             f"<h1 style='color:#7c3aed'>Conversation — {datetime.now().strftime('%Y-%m-%d %H:%M')}</h1>",
             f"<p style='color:#666'>Modèle : <code>{state.current_model}</code></p><hr style='border-color:#222'>"]
    import html as _html
    for m in state.messages:
        if m.role == "user":
            parts.append(f"<div class='user'><div class='role'>Utilisateur</div>{_html.escape(m.content)}</div>")
        elif m.role == "ai":
            import re
            content = _html.escape(m.content)
            content = re.sub(r"```(\w+)?\n(.*?)```", lambda mo: f"<pre><code class='language-{mo.group(1) or ''}'>{_html.escape(mo.group(2) if mo.group(2) else '')}</code></pre>", content, flags=re.DOTALL)
            parts.append(f"<div class='ai'><div class='role'>Assistant</div>{content}</div>")
        elif m.role == "tool":
            tag = (m.tool_tag or "tool").upper()
            parts.append(f"<div class='tool'>[{tag}] <b>{_html.escape(m.tool_name or '')}</b> — {_html.escape(m.content)}</div>")
    parts.append("<script>hljs.highlightAll();</script></body></html>")
    out = _out_path("html")
    out.write_text("".join(parts), encoding="utf-8")
    return out


def export_json() -> Path:
    data = [
        {"role": m.role, "content": m.content, "tool_name": m.tool_name,
         "tool_tag": m.tool_tag, "tool_detail": m.tool_detail}
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

**Intégration dans chat.py** — bouton export dans le header du chat:

```python
with ui.row().classes("items-center px-3 py-1 border-b border-gray-900 gap-1"):
    ui.label("💬 Chat").classes("text-xs text-gray-600 flex-1")
    with ui.button("⬇ Exporter", on_click=_show_export_menu).classes(
        "text-xs text-gray-500 bg-transparent hover:text-gray-300"
    ):
        pass

def _show_export_menu():
    with ui.menu() as menu:
        ui.menu_item("Markdown (.md)", lambda: _do_export("md"))
        ui.menu_item("HTML (.html)", lambda: _do_export("html"))
        ui.menu_item("JSON (.json)", lambda: _do_export("json"))
    menu.open()

def _do_export(fmt: str):
    from openagenticskyzer.app.exporter import export_markdown, export_html, export_json
    fn = {"md": export_markdown, "html": export_html, "json": export_json}[fmt]
    path = fn()
    import os; os.startfile(path)  # ouvre le fichier dans l'app par défaut (Windows)
    ui.notify(f"Exporté : {path.name}", type="positive")
```

---

## Phase 4 — Intelligence Locale

### 4.1 Indexation sémantique du codebase

**Objectif:** Indexer tous les fichiers du projet avec des embeddings locaux (ChromaDB + sentence-transformers). L'agent peut faire une recherche sémantique : "trouve le code qui gère l'authentification" → retourne les chunks les plus pertinents.

**Nouveau module:** `openagenticskyzer/indexer/`

**Fichier `openagenticskyzer/indexer/__init__.py`:** vide

**Fichier `openagenticskyzer/indexer/embedder.py`:**

```python
"""Modèle d'embedding local — all-MiniLM-L6-v2 (90MB, CPU-friendly)."""
from sentence_transformers import SentenceTransformer

_MODEL_NAME = "all-MiniLM-L6-v2"
_model = None


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


def embed(texts: list[str]) -> list[list[float]]:
    return get_model().encode(texts, batch_size=32, show_progress_bar=False).tolist()
```

**Fichier `openagenticskyzer/indexer/indexer.py`:**

```python
"""Indexation des fichiers du projet dans ChromaDB."""
import hashlib
import os
from pathlib import Path
import chromadb

_CHUNK_SIZE = 800     # caractères par chunk
_CHUNK_OVERLAP = 100
_EXCLUDED = {".git", "node_modules", "__pycache__", "dist", "build",
             ".openagent", ".venv", "venv", ".mypy_cache"}
_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java",
               ".c", ".cpp", ".h", ".css", ".html", ".md", ".txt",
               ".json", ".yaml", ".yml", ".toml", ".sql"}


def _get_db(folder: str) -> chromadb.Collection:
    db_path = str(Path(folder) / ".openagent" / "index")
    client = chromadb.PersistentClient(path=db_path)
    return client.get_or_create_collection("codebase", metadata={"hnsw:space": "cosine"})


def _chunk(text: str) -> list[str]:
    chunks = []
    start = 0
    while start < len(text):
        end = start + _CHUNK_SIZE
        chunks.append(text[start:end])
        start += _CHUNK_SIZE - _CHUNK_OVERLAP
    return [c for c in chunks if c.strip()]


def index_folder(folder: str, on_progress=None) -> int:
    """Index all files in folder. Returns count of indexed chunks."""
    from openagenticskyzer.indexer.embedder import embed
    col = _get_db(folder)
    all_files = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if d not in _EXCLUDED]
        for f in files:
            if Path(f).suffix in _EXTENSIONS:
                all_files.append(os.path.join(root, f))

    total = 0
    for i, filepath in enumerate(all_files):
        if on_progress:
            on_progress(i, len(all_files), filepath)
        try:
            text = Path(filepath).read_text(encoding="utf-8", errors="ignore")
            if not text.strip():
                continue
            rel = os.path.relpath(filepath, folder)
            chunks = _chunk(text)
            ids = [hashlib.md5(f"{rel}:{j}".encode()).hexdigest() for j in range(len(chunks))]
            embeddings = embed(chunks)
            metas = [{"file": rel, "chunk": j} for j in range(len(chunks))]
            col.upsert(ids=ids, embeddings=embeddings, documents=chunks, metadatas=metas)
            total += len(chunks)
        except Exception:
            continue
    return total


def search_codebase(folder: str, query: str, n: int = 5) -> list[dict]:
    from openagenticskyzer.indexer.embedder import embed
    col = _get_db(folder)
    q_emb = embed([query])
    results = col.query(query_embeddings=q_emb, n_results=min(n, col.count()))
    out = []
    for doc, meta, dist in zip(
        results["documents"][0], results["metadatas"][0], results["distances"][0]
    ):
        out.append({"file": meta["file"], "content": doc, "score": 1 - dist})
    return out
```

**Nouveau outil LangChain** dans `openagenticskyzer/tools/index_tools.py`:

```python
from langchain_core.tools import tool

@tool
def semantic_search(query: str, n: int = 5) -> str:
    """Search the codebase semantically. Returns the most relevant code chunks for the query.
    Use when grep_codebase doesn't find what you're looking for, or when the query is conceptual."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.indexer.indexer import search_codebase
    if not state.active_folder:
        return "No active folder."
    results = search_codebase(state.active_folder, query, n)
    if not results:
        return "No results found. The index may not be built yet."
    lines = [f"[{r['file']}] (score: {r['score']:.2f})\n{r['content']}" for r in results]
    return "\n\n---\n\n".join(lines)
```

**Indexation déclenchée** dans `app/main.py` lors de l'ouverture d'un dossier:

```python
import threading

def _index_folder_async(folder: str):
    """Lance l'indexation en arrière-plan sans bloquer l'UI."""
    def _run():
        try:
            from openagenticskyzer.indexer.indexer import index_folder
            def _progress(i, total, filepath):
                state.index_status = f"Index: {i}/{total}"
            index_folder(folder, on_progress=_progress)
            state.index_status = "✓ Index prêt"
        except Exception as e:
            state.index_status = ""

    threading.Thread(target=_run, daemon=True).start()
```

**Nouveau champ state.py:**

```python
index_status: str = ""  # affichage dans la context bar
```

**Affichage dans context_bar.py:**

```python
if state.index_status:
    ui.label(state.index_status).classes("text-xs text-gray-600")
```

**Nouvelles dépendances:**

```toml
[project.optional-dependencies]
index = [
    "chromadb>=0.5",
    "sentence-transformers>=2.7",
]
all = [..., "chromadb>=0.5", "sentence-transformers>=2.7"]
```

---

### 4.2 Base de connaissances RAG

**Objectif:** L'utilisateur peut ajouter n'importe quel document (PDF, TXT, URL, note) à une base locale persistante. L'agent y a accès via `knowledge_search()`.

**Nouveau fichier:** `openagenticskyzer/indexer/knowledge.py`

```python
"""Base de connaissances RAG — collection séparée du codebase index."""
import chromadb
import hashlib
from pathlib import Path


def _get_knowledge_db() -> chromadb.Collection:
    db_path = str(Path.home() / ".openagent" / "knowledge")
    client = chromadb.PersistentClient(path=db_path)
    return client.get_or_create_collection("knowledge", metadata={"hnsw:space": "cosine"})


def add_to_knowledge(source: str, text: str, tags: list[str] = None) -> int:
    """Chunke et indexe un texte dans la base de connaissances. Retourne nb chunks."""
    from openagenticskyzer.indexer.indexer import _chunk
    from openagenticskyzer.indexer.embedder import embed
    col = _get_knowledge_db()
    chunks = _chunk(text)
    if not chunks:
        return 0
    ids = [hashlib.md5(f"{source}:{j}".encode()).hexdigest() for j in range(len(chunks))]
    embeddings = embed(chunks)
    metas = [{"source": source, "chunk": j, "tags": ",".join(tags or [])}
             for j in range(len(chunks))]
    col.upsert(ids=ids, embeddings=embeddings, documents=chunks, metadatas=metas)
    return len(chunks)


def search_knowledge(query: str, n: int = 5) -> list[dict]:
    from openagenticskyzer.indexer.embedder import embed
    col = _get_knowledge_db()
    if col.count() == 0:
        return []
    q_emb = embed([query])
    results = col.query(query_embeddings=q_emb, n_results=min(n, col.count()))
    out = []
    for doc, meta, dist in zip(
        results["documents"][0], results["metadatas"][0], results["distances"][0]
    ):
        out.append({"source": meta["source"], "content": doc, "score": 1 - dist})
    return out


def list_sources() -> list[str]:
    col = _get_knowledge_db()
    if col.count() == 0:
        return []
    all_metas = col.get(include=["metadatas"])["metadatas"]
    return sorted(set(m["source"] for m in all_metas))


def remove_source(source: str) -> int:
    col = _get_knowledge_db()
    results = col.get(where={"source": source})
    if results["ids"]:
        col.delete(ids=results["ids"])
        return len(results["ids"])
    return 0
```

**Nouveau outil LangChain** dans `index_tools.py`:

```python
@tool
def knowledge_search(query: str, n: int = 5) -> str:
    """Search the personal knowledge base (documents, PDFs, notes added by the user).
    Use for questions about documents the user has explicitly added."""
    from openagenticskyzer.indexer.knowledge import search_knowledge
    results = search_knowledge(query, n)
    if not results:
        return "La base de connaissances est vide ou aucun résultat pertinent."
    lines = [f"[Source: {r['source']}] (score: {r['score']:.2f})\n{r['content']}"
             for r in results]
    return "\n\n---\n\n".join(lines)
```

**UI dans sidebar.py** — section "📚 Connaissances":

```python
def _render_knowledge_section():
    from openagenticskyzer.indexer.knowledge import list_sources, remove_source, add_to_knowledge

    with ui.expansion("📚 Base de connaissances", value=False).classes("w-full"):
        with ui.column().classes("w-full gap-1 px-2"):
            sources = list_sources()
            if not sources:
                ui.label("Aucun document").classes("text-xs text-gray-600")
            for src in sources:
                with ui.row().classes("w-full items-center gap-1"):
                    ui.label(src[:40]).classes("text-xs text-gray-400 flex-1 truncate")
                    ui.button("✕", on_click=lambda s=src: _remove_knowledge(s)).classes(
                        "w-5 h-5 bg-transparent text-gray-600 hover:text-red-400 text-xs"
                    )
            ui.button("+ Ajouter un document", on_click=_open_knowledge_import).classes(
                "w-full text-xs text-purple-400 bg-transparent border border-purple-900 "
                "hover:border-purple-600 rounded mt-1 py-1"
            )
```

---

## Phase 5 — Extensibilité

### 5.1 Système de plugins

**Objectif:** Les utilisateurs peuvent ajouter leurs propres outils LangChain en déposant un fichier `.py` dans `.openagent/tools/` ou `~/.openagent/tools/`.

**Nouveau fichier:** `openagenticskyzer/plugins/loader.py`

```python
"""Chargement dynamique des plugins utilisateur."""
import importlib.util
import sys
from pathlib import Path
from langchain_core.tools import BaseTool


def _plugin_dirs(folder: str | None) -> list[Path]:
    dirs = [Path.home() / ".openagent" / "tools"]
    if folder:
        dirs.append(Path(folder) / ".openagent" / "tools")
    return [d for d in dirs if d.exists()]


def load_plugins(folder: str | None = None) -> tuple[list[BaseTool], list[str]]:
    """
    Retourne (tools_chargés, erreurs).
    Chaque fichier .py doit exposer get_tools() -> list[BaseTool].
    """
    tools: list[BaseTool] = []
    errors: list[str] = []

    for plugin_dir in _plugin_dirs(folder):
        for py_file in sorted(plugin_dir.glob("*.py")):
            try:
                spec = importlib.util.spec_from_file_location(
                    f"openagent_plugin_{py_file.stem}", py_file
                )
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                get_tools_fn = getattr(module, "get_tools", None)
                if callable(get_tools_fn):
                    plugin_tools = get_tools_fn()
                    tools.extend(plugin_tools)
                else:
                    errors.append(f"{py_file.name}: pas de fonction get_tools()")
            except Exception as exc:
                errors.append(f"{py_file.name}: {exc}")

    return tools, errors
```

**Intégration dans agent.py — build_agent():**

```python
from openagenticskyzer.plugins.loader import load_plugins

def build_agent(...):
    plugin_tools, plugin_errors = load_plugins(folder=None)  # folder passé en arg
    if plugin_errors:
        logger.warning("Plugin errors: %s", plugin_errors)
    all_tools = _ALL_TOOLS + plugin_tools
    ...
```

**UI dans settings.py — onglet "Outils":**

```python
def _tab_tools():
    from openagenticskyzer.plugins.loader import load_plugins
    tools, errors = load_plugins(state.active_folder)
    _section("Plugins chargés")
    if not tools and not errors:
        ui.label("Aucun plugin").classes("text-xs text-gray-600 px-4")
    for t in tools:
        with ui.row().classes("px-4 py-1 gap-2 items-center"):
            ui.label("✓").classes("text-green-400 text-xs")
            ui.label(f"{t.name}").classes("text-xs text-gray-300 font-mono")
    for err in errors:
        with ui.row().classes("px-4 py-1 gap-2 items-center"):
            ui.label("✗").classes("text-red-400 text-xs")
            ui.label(err[:80]).classes("text-xs text-red-400")
    _section("Répertoires de plugins")
    ui.label(f"Global : ~/.openagent/tools/").classes("text-xs text-gray-600 px-4")
    if state.active_folder:
        ui.label(f"Dossier : {state.active_folder}/.openagent/tools/").classes("text-xs text-gray-600 px-4")
```

---

### 5.2 Support MCP (Model Context Protocol)

**Objectif:** Connecter des serveurs MCP (stdio ou SSE) pour exposer leurs outils à l'agent. Permet d'intégrer des services externes (bases de données, APIs, outils custom) via le protocole standardisé d'Anthropic.

**Nouveau fichier:** `openagenticskyzer/mcp_client/__init__.py` — vide

**Nouveau fichier:** `openagenticskyzer/mcp_client/adapter.py`

```python
"""Adaptateur MCP → LangChain BaseTool."""
import asyncio
from langchain_core.tools import BaseTool, ToolException
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def load_mcp_tools(server_config: dict) -> list[BaseTool]:
    """
    server_config: {"name": str, "command": str, "args": list, "env": dict}
    Retourne la liste des tools LangChain correspondants.
    """
    params = StdioServerParameters(
        command=server_config["command"],
        args=server_config.get("args", []),
        env=server_config.get("env"),
    )
    tools = []
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            mcp_tools = await session.list_tools()
            for t in mcp_tools.tools:
                tools.append(_make_lc_tool(t, server_config, session))
    return tools
```

**Config MCP** dans `storage.py`:

```python
def _mcp_config_path() -> Path:
    return _openagent_home() / "mcp.json"

def load_mcp_config() -> list[dict]:
    path = _mcp_config_path()
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []

def save_mcp_config(servers: list[dict]) -> None:
    path = _mcp_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(servers, indent=2), encoding="utf-8")
```

**Intégration dans agent.py:**

```python
from openagenticskyzer.app.storage import load_mcp_config

def build_agent(...):
    mcp_tools = []
    for server_cfg in load_mcp_config():
        try:
            import asyncio
            from openagenticskyzer.mcp_client.adapter import load_mcp_tools
            mcp_tools += asyncio.run(load_mcp_tools(server_cfg))
        except Exception as exc:
            logger.warning("MCP server %s failed: %s", server_cfg.get("name"), exc)
    all_tools = _ALL_TOOLS + plugin_tools + mcp_tools
```

**UI dans settings.py — onglet "MCP":**

```python
def _tab_mcp():
    from openagenticskyzer.app.storage import load_mcp_config, save_mcp_config
    servers = load_mcp_config()
    _section("Serveurs MCP connectés")
    for i, srv in enumerate(servers):
        with ui.row().classes("px-4 py-2 gap-2 items-center"):
            ui.label(f"⬡ {srv['name']}").classes("text-xs text-purple-400 flex-1")
            ui.label(srv['command']).classes("text-xs text-gray-600 font-mono")
            ui.button("✕", on_click=lambda idx=i: _remove_mcp(idx, servers)).classes(
                "w-5 h-5 bg-transparent text-gray-600 hover:text-red-400 text-xs"
            )
    ui.button("+ Ajouter un serveur MCP", on_click=_open_mcp_dialog).classes(
        "w-full text-xs text-purple-400 bg-transparent border border-purple-900 rounded mt-1 py-1"
    )
```

**Nouvelle dépendance:**

```toml
[project.optional-dependencies]
mcp = ["mcp>=1.0"]
all = [..., "mcp>=1.0"]
```

---

## Phase 6 — Multi-Agent

### 6.1 Sous-agents parallèles

**Objectif:** L'agent principal peut déléguer des sous-tâches à des agents fils indépendants qui s'exécutent en parallèle. Chaque sous-agent a son propre contexte, CWD, et retourne un résultat textuel.

**Nouveau outil:** `openagenticskyzer/tools/delegation.py`

```python
"""Outil de délégation de tâches à des sous-agents."""
import threading
import uuid
from langchain_core.tools import tool
from openagenticskyzer.app.state import state


@tool
def delegate_task(task: str, cwd: str = "", timeout: int = 120) -> str:
    """Delegate a subtask to an independent sub-agent and wait for the result.
    Use for parallelizable tasks: one agent writes tests while another writes code.
    Args:
        task: The complete task description for the sub-agent.
        cwd: Working directory for the sub-agent (default: same as current).
        timeout: Max seconds to wait (default: 120).
    Returns: The sub-agent's final response."""
    import concurrent.futures
    from openagenticskyzer.agent import build_agent

    sub_cwd = cwd or state.active_folder or "."
    sub_id = str(uuid.uuid4())[:8]

    # Enregistre le sous-agent dans l'état pour l'UI
    state.sub_agents.append({"id": sub_id, "task": task[:80], "status": "running"})

    def _run_sub():
        # IMPORTANT: Ne PAS utiliser os.chdir() dans un thread (process-global, race condition).
        # Le cwd est passé via la variable sub_cwd et injecté dans chaque tool call
        # via un PermissionManager qui wrappe les tools avec le bon cwd.
        agent = build_agent(
            mode="auto",
            permission_manager=None,
            folder_cwd=sub_cwd,   # nouveau param à ajouter à build_agent (voir ci-dessous)
        )
        try:
            result = agent.invoke({"messages": [{"role": "user", "content": task}]},
                                  {"recursion_limit": 100})
            for msg in reversed(result.get("messages", [])):
                content = getattr(msg, "content", "")
                if content and not getattr(msg, "tool_calls", None):
                    return content if isinstance(content, str) else str(content)
            return "Sous-agent terminé sans réponse."
        except Exception as exc:
            return f"Sous-agent erreur: {exc}"

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(_run_sub)
        try:
            result = future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            result = f"Sous-agent {sub_id} a dépassé le timeout de {timeout}s."

    # Met à jour le statut
    for sa in state.sub_agents:
        if sa["id"] == sub_id:
            sa["status"] = "done"
            break

    return result
```

**Note sur le CWD des sous-agents:** `os.chdir()` est process-global — dangereux dans un thread. Solution : ajouter `folder_cwd: str | None = None` à `build_agent()`, le passer au `PermissionManager` et aux outils via une variable de contexte thread-local (`threading.local()`). Chaque outil lit le cwd depuis `threading.local().cwd` au lieu de `os.getcwd()`.

**Nouveau champ state.py:**

```python
sub_agents: list[dict] = field(default_factory=list)
# Format: [{"id": str, "task": str, "status": "running"|"done"|"error"}]
```

**UI — panneau sous-agents** dans `sidebar.py` ou `context_bar.py`:

```python
@ui.refreshable
def sub_agents_panel():
    running = [sa for sa in state.sub_agents if sa["status"] == "running"]
    if not running:
        return
    with ui.row().classes("items-center px-3 py-1 gap-2"):
        ui.spinner("dots", size="xs").classes("text-purple-400")
        ui.label(f"{len(running)} sous-agent(s) actif(s)").classes("text-xs text-purple-400")
    for sa in running:
        ui.label(f"• {sa['task']}").classes("text-xs text-gray-500 px-4 truncate")
```

---

### 6.2 Orchestrateur de tâches

**Objectif:** Nouveau mode agent "orchestrate" qui, face à un projet complexe, décompose automatiquement en étapes et les délègue à des sous-agents parallèles.

**Nouveau mode** dans `agent.py`:

```python
def build_agent(mode: str = "auto", ...):
    if mode == "orchestrate":
        system_prompt = ORCHESTRATOR_PROMPT
    else:
        system_prompt = DEEP_AGENT_SYSTEM_PROMPT
```

**Nouveau prompt** dans `prompts/prompt.py`:

```python
ORCHESTRATOR_PROMPT = """
You are an orchestration agent. Your job is to analyze complex tasks and break them into parallel subtasks.

WORKFLOW:
1. Analyze the user request and identify independent subtasks
2. For each subtask, call delegate_task(task=..., cwd=...) — these run in parallel threads
3. Collect all results and synthesize a final summary

RULES:
- Maximum 5 parallel subtasks at once
- Each subtask must be completely self-contained (include all context)
- Never do work yourself — always delegate
- After all tasks complete, write a comprehensive summary

TOOLS: delegate_task(task, cwd, timeout) | internet_search | fetch_url
"""
```

**Sélecteur de mode** dans `model_modal.py` ou settings — ajouter "Orchestrateur" aux modes agent:

```python
# Dans le select du mode agent:
options = ["ask", "auto", "plan", "orchestrate"]
labels = {
    "ask": "💬 Ask — Questions uniquement",
    "auto": "⚡ Auto — Autonome",
    "plan": "📋 Plan — Avec validation",
    "orchestrate": "🕸️ Orchestrateur — Multi-agents",
}
```

---

## Dépendances entre phases

```
Phase 1 (Streaming)      → Aucune dépendance, commence immédiatement
Phase 2 (Git + Upload)   → Aucune dépendance, parallèle avec Phase 1
Phase 3 (Artifacts)      → Phase 1 recommandée (streaming + affichage)
Phase 4 (RAG + Index)    → Aucune dépendance fonctionnelle
Phase 5 (Plugins + MCP)  → Aucune dépendance
Phase 6 (Multi-agent)    → Phase 5 recommandée (plugins pour les sous-agents)
```

**Ordre recommandé:** 1 → 2 → 3 → 4 → 5 → 6
**Phases parallélisables:** 1+2 simultanément, 4+5 simultanément

---

## Nouvelles dépendances Python

| Phase | Package | Groupe |
|---|---|---|
| 1.3 | `plyer>=2.1` | `[app]` |
| 2.2 | `pypdf>=4.0` | `[app]` |
| 4 | `chromadb>=0.5` | `[index]` (nouveau groupe) |
| 4 | `sentence-transformers>=2.7` | `[index]` |
| 5.2 | `mcp>=1.0` | `[mcp]` (nouveau groupe) |

**Ajouter à requirements.txt:** `plyer>=2.1`, `pypdf>=4.0`

---

## Résumé des nouveaux fichiers

| Fichier | Phase | Description |
|---|---|---|
| `app/notifier.py` | 1.3 | Notifications OS |
| `app/file_processor.py` | 2.2 | Traitement uploads |
| `app/exporter.py` | 3.3 | Export conversation |
| `app/components/artifact_panel.py` | 3.1 | Preview HTML/SVG/Mermaid |
| `app/components/prompt_library.py` | 3.2 | Bibliothèque de prompts |
| `tools/git_tools.py` | 2.1 | 14 outils git |
| `tools/index_tools.py` | 4 | semantic_search + knowledge_search |
| `tools/delegation.py` | 6.1 | delegate_task |
| `indexer/__init__.py` | 4 | Module indexation |
| `indexer/embedder.py` | 4 | Modèle sentence-transformers |
| `indexer/indexer.py` | 4 | ChromaDB + chunking |
| `indexer/knowledge.py` | 4.2 | Base de connaissances RAG |
| `plugins/__init__.py` | 5.1 | Module plugins |
| `plugins/loader.py` | 5.1 | Chargement dynamique |
| `mcp_client/__init__.py` | 5.2 | Module MCP |
| `mcp_client/adapter.py` | 5.2 | Adaptateur MCP→LangChain |
| `prompts/orchestrator.py` | 6.2 | Prompt orchestrateur |

## Résumé des fichiers modifiés

| Fichier | Phases | Modifications |
|---|---|---|
| `app/state.py` | 1,2,4,6 | +streaming_content, +is_streaming, +attached_files, +index_status, +sub_agents |
| `app/main.py` | 1,3 | +highlight.js, +mermaid.js, +artifact_panel dans layout |
| `app/components/chat.py` | 1,3.3 | +streaming render, +bouton export |
| `app/components/input_bar.py` | 1,2.2,3.2 | astream_events, upload button, prompt picker |
| `app/components/sidebar.py` | 2.1,4.2 | +git widget, +knowledge section |
| `app/components/settings.py` | 1.3,5 | +notifs toggle, +onglet Outils, +onglet MCP |
| `app/storage.py` | 3.2,5.2 | +load_prompts, +save_prompts, +load_mcp_config, +save_mcp_config |
| `agent.py` | 2.1,4,5,6 | +git_tools, +index_tools, +plugin_tools, +mcp_tools, +delegate_task |
| `permissions.py` | 2.1 | +git_commit, git_push etc. dans _RESTRICTED_TOOLS |
| `prompts/prompt.py` | 2.1,4,6 | +section GIT, +semantic_search, +knowledge_search |
| `pyproject.toml` | 1,2,4,5 | +plyer, +pypdf, +chromadb, +sentence-transformers, +mcp |
| `requirements.txt` | 1,2 | +plyer, +pypdf |
