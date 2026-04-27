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

---

#### Quand créer un plugin ?

Un plugin est utile chaque fois que le comportement dont tu as besoin est **trop spécifique** pour être intégré dans le cœur de l'app, ou **trop personnel** pour être partagé par défaut. Voici les cas concrets :

| Situation | Exemple de plugin |
|---|---|
| **Connecter un service externe** | Jira, Notion, Slack, Linear, GitHub API, Trello |
| **Intégrer une base de données** | PostgreSQL, MongoDB, SQLite, Redis, Supabase |
| **Ajouter un moteur de recherche** | Brave Search, SerpAPI, Perplexity, Algolia |
| **Automatiser un workflow métier** | Déployer sur ton infra, envoyer un rapport, notifier une équipe |
| **Traiter des formats de fichiers propriétaires** | `.dwg` AutoCAD, `.blend` Blender, fichiers DICOM, Excel complexe |
| **Domaines spécialisés** | Calcul scientifique (NumPy/Scipy), finance (yfinance), jeux (Pygame), 3D |
| **Wrapper CLI interne** | `kubectl`, `terraform`, `docker-compose`, tes propres scripts |
| **Enrichir l'accès aux fichiers** | Parser du YAML avec schéma, lire des logs structurés |
| **Ajouter de l'IA spécialisée** | Appeler un modèle de vision custom, un modèle audio (Whisper local) |
| **Hooks et automations** | Lancer des tests après chaque modification, git commit auto |

**Règle simple :** si tu te retrouves à copier-coller la même instruction dans chaque conversation ("pour déployer, fais `ssh prod ./deploy.sh`..."), c'est un plugin.

---

#### Ce que peut faire un plugin

Un plugin est un fichier Python qui expose des **outils LangChain**. Un outil LangChain = une fonction que l'IA peut appeler autonomement avec les bons arguments. Le plugin peut faire **n'importe quoi** que Python peut faire :

**Appels HTTP / APIs REST :**
```python
import requests
from langchain_core.tools import tool

@tool
def search_github_issues(repo: str, query: str) -> str:
    """Search GitHub issues in a repository."""
    resp = requests.get(
        f"https://api.github.com/search/issues",
        params={"q": f"{query} repo:{repo}", "per_page": 5},
        headers={"Authorization": f"token {os.environ['GITHUB_TOKEN']}"},
    )
    items = resp.json().get("items", [])
    return "\n".join(f"#{i['number']} {i['title']} — {i['html_url']}" for i in items)
```

**Requêtes base de données :**
```python
@tool
def query_database(sql: str) -> str:
    """Execute a read-only SQL query on the project database."""
    import sqlite3
    conn = sqlite3.connect(".openagent/project.db")
    cur = conn.execute(sql)
    rows = cur.fetchmany(50)
    cols = [d[0] for d in cur.description]
    return "\n".join([str(cols)] + [str(r) for r in rows])
```

**Commandes système enrichies :**
```python
@tool
def deploy_to_staging(service: str) -> str:
    """Deploy a specific service to the staging environment."""
    import subprocess
    result = subprocess.run(
        ["kubectl", "rollout", "restart", f"deployment/{service}", "-n", "staging"],
        capture_output=True, text=True, timeout=60
    )
    return result.stdout + result.stderr
```

**Lecture d'état de l'app :**
```python
# Les plugins ont accès à l'état de l'app
from openagenticskyzer.app.state import state

@tool
def get_current_folder_stats() -> str:
    """Return stats about the currently open folder."""
    import os
    folder = state.active_folder
    if not folder:
        return "No folder open."
    files = sum(1 for _ in os.walk(folder))
    return f"Folder: {folder}\nSubdirs: {files}\nModel: {state.current_model}"
```

**Accès à la mémoire et au stockage :**
```python
from openagenticskyzer.app.storage import load_global_config, save_global_config
from openagenticskyzer.context.project_memory import append_to_project_memory

@tool
def log_deployment(version: str, env: str) -> str:
    """Log a deployment event to project memory."""
    from datetime import datetime
    append_to_project_memory(
        state.active_folder,
        f"Déployé v{version} en {env} le {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    )
    return f"✓ Déploiement v{version} mémorisé."
```

---

#### Contrat API complet du plugin

Un fichier plugin peut exposer ces fonctions. Seule `get_tools()` est obligatoire :

```python
# ─────────────────────────────────────────────
# OBLIGATOIRE
# ─────────────────────────────────────────────

def get_tools() -> list[BaseTool]:
    """Retourne la liste des outils LangChain à injecter dans l'agent."""
    return [mon_outil_1, mon_outil_2]


# ─────────────────────────────────────────────
# OPTIONNEL — métadonnées affichées dans l'UI
# ─────────────────────────────────────────────

def get_info() -> dict:
    """Métadonnées du plugin affichées dans Settings > Outils."""
    return {
        "name": "Mon Plugin",           # Nom affiché dans l'UI
        "version": "1.0.0",             # Version sémantique
        "description": "Connecte X à l'agent.",
        "author": "ton-nom",
        "requires": ["requests>=2.28"], # Dépendances Python nécessaires
        "config_keys": ["API_KEY_X"],   # Clés d'env attendues
    }


# ─────────────────────────────────────────────
# OPTIONNEL — hooks de cycle de vie
# ─────────────────────────────────────────────

def on_load(folder: str | None) -> None:
    """Appelé une fois quand le plugin est chargé (au démarrage ou changement de dossier).
    Bon endroit pour vérifier les clés d'API, initialiser des connexions."""
    api_key = os.environ.get("API_KEY_X")
    if not api_key:
        raise EnvironmentError("API_KEY_X manquant — plugin désactivé.")


def on_folder_open(folder: str) -> None:
    """Appelé quand l'utilisateur ouvre un dossier. Reçoit le chemin absolu."""
    pass   # ex: charger un fichier de config spécifique au projet


def on_session_end(folder: str) -> None:
    """Appelé quand l'utilisateur change de dossier ou ferme l'app."""
    pass   # ex: sauvegarder un cache, fermer des connexions
```

**Le loader appellera ces hooks** dans `loader.py` :

```python
# Appel des hooks après chargement
if hasattr(module, "on_load"):
    module.on_load(folder)
```

---

#### Exemples de plugins complets

**Plugin 1 — Météo en temps réel** (`~/.openagent/tools/weather.py`) :

```python
"""Plugin météo — données en temps réel via Open-Meteo (gratuit, sans clé API)."""
import urllib.request
import json
from langchain_core.tools import tool


def get_info():
    return {
        "name": "Météo Open-Meteo",
        "version": "1.0.0",
        "description": "Météo actuelle et prévisions via Open-Meteo (sans clé API).",
        "author": "communauté",
        "requires": [],
    }


def get_tools():
    return [get_weather]


@tool
def get_weather(city: str) -> str:
    """Get current weather and 3-day forecast for a city.
    Args: city — city name (e.g. 'Paris', 'Tokyo')."""
    # 1. Géocode la ville
    geo_url = f"https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1&language=fr"
    with urllib.request.urlopen(geo_url, timeout=10) as r:
        geo = json.loads(r.read())
    if not geo.get("results"):
        return f"Ville '{city}' introuvable."
    loc = geo["results"][0]
    lat, lon, name = loc["latitude"], loc["longitude"], loc["name"]

    # 2. Météo actuelle + prévisions 3 jours
    meteo_url = (
        f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
        f"&current=temperature_2m,precipitation,windspeed_10m,weathercode"
        f"&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
        f"&timezone=auto&forecast_days=3"
    )
    with urllib.request.urlopen(meteo_url, timeout=10) as r:
        data = json.loads(r.read())
    cur = data["current"]
    daily = data["daily"]
    lines = [
        f"🌍 {name} — Météo actuelle",
        f"🌡️ {cur['temperature_2m']}°C  💨 {cur['windspeed_10m']} km/h  🌧️ {cur['precipitation']} mm",
        "",
        "📅 Prévisions 3 jours :"
    ]
    for i in range(3):
        lines.append(
            f"  {daily['time'][i]} : {daily['temperature_2m_min'][i]}°→{daily['temperature_2m_max'][i]}°C,"
            f" pluie: {daily['precipitation_sum'][i]}mm"
        )
    return "\n".join(lines)
```

---

**Plugin 2 — Connecteur Notion** (`.openagent/tools/notion.py`) :

```python
"""Plugin Notion — lire/créer des pages depuis l'agent.
Nécessite : NOTION_API_KEY dans .env"""
import os, json
import urllib.request
from langchain_core.tools import tool


def get_info():
    return {
        "name": "Notion",
        "version": "1.0.0",
        "description": "Cherche et crée des pages Notion depuis l'agent.",
        "config_keys": ["NOTION_API_KEY"],
        "requires": [],
    }

def on_load(folder):
    if not os.environ.get("NOTION_API_KEY"):
        raise EnvironmentError("NOTION_API_KEY manquant dans .env")

def get_tools():
    return [search_notion, create_notion_page]


def _notion_headers():
    return {
        "Authorization": f"Bearer {os.environ['NOTION_API_KEY']}",
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
    }


@tool
def search_notion(query: str) -> str:
    """Search pages in Notion workspace by keyword."""
    payload = json.dumps({"query": query, "page_size": 5}).encode()
    req = urllib.request.Request(
        "https://api.notion.com/v1/search",
        data=payload, headers=_notion_headers(), method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read())
    results = data.get("results", [])
    if not results:
        return "Aucun résultat Notion."
    lines = []
    for page in results:
        title_prop = page.get("properties", {}).get("title") or page.get("properties", {}).get("Name", {})
        title_parts = (title_prop.get("title") or title_prop.get("rich_text") or [])
        title = "".join(t.get("plain_text", "") for t in title_parts) or "Sans titre"
        url = page.get("url", "")
        lines.append(f"• {title} — {url}")
    return "\n".join(lines)


@tool
def create_notion_page(title: str, content: str, parent_page_id: str = "") -> str:
    """Create a new page in Notion.
    Args: title — page title, content — markdown text, parent_page_id — optional parent page ID."""
    # ... implémentation complète dans la vraie version
    return "Page Notion créée."
```

---

**Plugin 3 — Lint & Tests auto** (`.openagent/tools/quality.py`) :

```python
"""Plugin qualité — lance les tests et le linter sur demande."""
import subprocess
from pathlib import Path
from langchain_core.tools import tool
from openagenticskyzer.app.state import state


def get_info():
    return {
        "name": "Qualité Code",
        "version": "1.0.0",
        "description": "Lance pytest, ruff, mypy sur le projet courant.",
    }

def get_tools():
    return [run_tests, run_linter, run_type_check]


@tool
def run_tests(path: str = "") -> str:
    """Run pytest on the project or a specific path/file.
    Args: path — optional specific test file or directory."""
    cwd = state.active_folder or "."
    target = path or "tests/"
    result = subprocess.run(
        ["python", "-m", "pytest", target, "-v", "--tb=short", "--no-header"],
        cwd=cwd, capture_output=True, text=True, timeout=120, encoding="utf-8"
    )
    output = result.stdout + result.stderr
    return output[-3000:] if len(output) > 3000 else output


@tool
def run_linter(fix: bool = False) -> str:
    """Run ruff linter on the project. Set fix=True to auto-fix issues."""
    cwd = state.active_folder or "."
    cmd = ["python", "-m", "ruff", "check", "."]
    if fix:
        cmd.append("--fix")
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60, encoding="utf-8")
    return result.stdout + result.stderr or "✓ Aucun problème détecté."


@tool
def run_type_check() -> str:
    """Run mypy type checker on the project."""
    cwd = state.active_folder or "."
    result = subprocess.run(
        ["python", "-m", "mypy", ".", "--ignore-missing-imports"],
        cwd=cwd, capture_output=True, text=True, timeout=90, encoding="utf-8"
    )
    return result.stdout + result.stderr
```

---

#### Structure recommandée pour un plugin publié

Un plugin conçu pour être partagé avec la communauté doit suivre cette structure :

```
openagent-plugin-notion/        ← dépôt GitHub nommé openagent-plugin-<nom>
├── notion.py                   ← fichier principal (déposé dans ~/.openagent/tools/)
├── README.md                   ← description, installation, config requise
├── LICENSE                     ← MIT recommandé
├── requirements.txt            ← dépendances Python à installer
└── examples/
    └── demo.md                 ← exemples de prompts pour utiliser le plugin
```

**Convention de nommage des dépôts GitHub :** `openagent-plugin-<nom>` (ex: `openagent-plugin-notion`, `openagent-plugin-jira`, `openagent-plugin-weather`).

---

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

### 5.3 Documentation communautaire (Modding Guide)

**Objectif:** Créer une documentation complète qui permet à la communauté de comprendre le projet, de contribuer, et de créer des plugins de qualité sans aide extérieure. L'app ne vit que si la communauté peut s'approprier le système de plugins.

---

#### Fichiers à créer

```
docs/
├── CONTRIBUTING.md              ← Comment contribuer au projet principal
├── plugins/
│   ├── PLUGIN_GUIDE.md          ← Guide complet pour créer un plugin
│   ├── PLUGIN_API_REFERENCE.md  ← Référence de toutes les APIs accessibles
│   └── examples/
│       ├── weather/
│       │   ├── weather.py       ← Plugin météo complet (voir 5.1)
│       │   └── README.md
│       ├── database/
│       │   ├── sqlite_plugin.py ← Plugin base de données SQLite
│       │   └── README.md
│       └── quality/
│           ├── quality.py       ← Plugin tests + lint (voir 5.1)
│           └── README.md
└── architecture/
    ├── ARCHITECTURE.md          ← Vue d'ensemble technique du projet
    └── AGENT_FLOW.md            ← Comment fonctionne le graph LangGraph
```

---

#### Contenu de `docs/plugins/PLUGIN_GUIDE.md`

Ce fichier est le document principal pour les moddeurs. Il doit couvrir :

**Section 1 — Introduction**
```markdown
# Créer un plugin pour OpenAgentic Skyzer

Un plugin est un fichier Python qui ajoute de nouveaux outils à l'agent IA.
L'agent peut ensuite utiliser ces outils de manière autonome dans ses conversations.

## Ce que tu peux faire avec un plugin

- Connecter n'importe quelle API web (REST, GraphQL, WebSocket)
- Interroger des bases de données (SQL, NoSQL, Redis...)
- Lancer des commandes système enrichies
- Intégrer des services SaaS (Notion, Jira, Slack, Linear, GitHub...)
- Ajouter des domaines métier (finance, santé, science, jeux...)
- Automatiser des workflows complets
- Ajouter des modèles IA spécialisés (vision, audio, embedding)
```

**Section 2 — Démarrage rapide (Hello World)**
```markdown
## Ton premier plugin en 5 minutes

1. Crée le dossier plugin global :
   mkdir -p ~/.openagent/tools/

2. Crée le fichier ~/.openagent/tools/hello.py :

from langchain_core.tools import tool

def get_tools():
    return [hello_world]

@tool
def hello_world(name: str) -> str:
    """Say hello to someone. Args: name — the person's name."""
    return f"Bonjour {name}, je suis un plugin OpenAgentic !"

3. Redémarre OpenAgentic Skyzer.
4. Dans le chat, dis : "Dis bonjour à Alice."
   → L'agent appellera automatiquement hello_world(name="Alice").
```

**Section 3 — Contrat API**
```markdown
## Fonctions reconnues par le loader

| Fonction | Obligatoire | Description |
|---|---|---|
| get_tools() → list[BaseTool] | ✅ Oui | Retourne tes outils LangChain |
| get_info() → dict | Non | Métadonnées pour l'UI Settings |
| on_load(folder) | Non | Appelé au chargement (vérifie les clés API) |
| on_folder_open(folder) | Non | Appelé à l'ouverture d'un dossier |
| on_session_end(folder) | Non | Appelé à la fermeture/changement |
```

**Section 4 — Écrire un bon outil LangChain**
```markdown
## Écrire un outil efficace

L'IA choisit QUEL outil appeler en lisant uniquement la docstring.
Une bonne docstring = l'IA utilise l'outil au bon moment.

# ❌ Mauvais — docstring vague
@tool
def do_stuff(x: str) -> str:
    """Does stuff."""
    ...

# ✅ Bon — docstring précise avec quand/comment utiliser
@tool
def search_jira_tickets(query: str, project: str = "ALL", status: str = "open") -> str:
    """Search Jira tickets by keyword in a specific project.
    Use when the user asks about tasks, bugs, or issues in the project tracker.
    Args:
        query — search keywords (e.g. 'login bug', 'performance')
        project — Jira project key (e.g. 'BACKEND', 'ALL' for all projects)
        status — 'open', 'closed', or 'all'
    Returns: list of matching tickets with ID, title, assignee, and URL."""
    ...

Règles pour les docstrings :
- Commence par un verbe d'action ("Search", "Create", "Get", "Send")
- Inclus "Use when..." pour guider le choix de l'IA
- Décris chaque argument et sa valeur possible
- Précise le format de la valeur retournée
```

**Section 5 — Accès aux APIs internes**
```markdown
## APIs internes disponibles

Ton plugin peut importer et utiliser ces modules :

### État de l'application
from openagenticskyzer.app.state import state

state.active_folder   # Dossier actuellement ouvert (str | None)
state.current_model   # Modèle LLM actif (str | None)
state.current_provider  # Provider actif ("ollama", "groq"...)
state.messages        # Historique de la conversation

### Persistance
from openagenticskyzer.app.storage import load_global_config, save_global_config

cfg = load_global_config()    # dict — config globale de l'app
# Lire/écrire ta propre clé dans la config :
cfg["mon_plugin_setting"] = "valeur"
save_global_config(cfg)

### Mémoire projet
from openagenticskyzer.context.project_memory import (
    load_project_memory,       # → str
    append_to_project_memory,  # (folder, facts) → None
)

### Notifications utilisateur
from nicegui import ui
ui.notify("Message", type="positive")  # "positive", "negative", "warning", "info"
```

**Section 6 — Variables d'environnement et configuration**
```markdown
## Gérer les clés API

### Option A — .env dans le dossier projet
Crée un fichier .env à la racine de ton dossier :
NOTION_API_KEY=secret_...
MY_DB_URL=postgresql://...

OpenAgentic charge automatiquement les .env à l'ouverture d'un dossier.
Accès dans le plugin : os.environ.get("NOTION_API_KEY")

### Option B — .env global (~/.openagent/.env)
Pour les clés qui s'appliquent à tous tes projets.

### Vérifier dans on_load()
def on_load(folder):
    key = os.environ.get("NOTION_API_KEY")
    if not key:
        raise EnvironmentError(
            "NOTION_API_KEY manquant. Ajoute-le dans ton .env : NOTION_API_KEY=secret_..."
        )
```

**Section 7 — Publier son plugin**
```markdown
## Partager ton plugin avec la communauté

### Convention de nommage
Ton dépôt GitHub doit s'appeler : openagent-plugin-<nom>
Exemples : openagent-plugin-notion, openagent-plugin-jira, openagent-plugin-weather

### Structure minimale du dépôt
openagent-plugin-notion/
├── notion.py          ← Le plugin (à copier dans ~/.openagent/tools/)
├── README.md          ← Description + installation
├── requirements.txt   ← Dépendances pip (ex: requests>=2.28)
└── examples/
    └── prompts.md     ← Exemples de prompts pour utiliser le plugin

### README.md recommandé
# openagent-plugin-notion
Connecte Notion à OpenAgentic Skyzer. Cherche et crée des pages depuis le chat.

## Installation
pip install requests  # si nécessaire
cp notion.py ~/.openagent/tools/

## Configuration
Ajoute dans ton .env :
NOTION_API_KEY=secret_...  # obtenu sur https://www.notion.so/my-integrations

## Outils disponibles
- search_notion(query) — Cherche des pages par mot-clé
- create_notion_page(title, content) — Crée une nouvelle page

## Exemples
"Cherche mes notes sur le projet Alpha dans Notion"
"Crée une page Notion avec le compte-rendu de cette session"

### Listing communautaire
Une fois publié, ajoute ton plugin à la liste communautaire :
→ Ouvre une PR sur openagenticskyzer avec une ligne dans docs/plugins/COMMUNITY_REGISTRY.md
```

---

#### Contenu de `docs/plugins/PLUGIN_API_REFERENCE.md`

Ce fichier est la référence exhaustive de toutes les APIs internes disponibles pour les plugins, avec signature et description de chaque fonction. Structure :

```markdown
# Plugin API Reference

## openagenticskyzer.app.state
## openagenticskyzer.app.storage
## openagenticskyzer.context.project_memory
## openagenticskyzer.tools.crud_tools (si besoin de réutiliser)
## openagenticskyzer.tools.internet_search
## Callbacks NiceGUI disponibles
## Variables d'environnement connues
```

---

#### Contenu de `docs/plugins/COMMUNITY_REGISTRY.md`

```markdown
# Registre des plugins communautaires

Liste des plugins créés par la communauté OpenAgentic Skyzer.
Pour ajouter le tien : ouvre une PR en ajoutant une ligne dans ce fichier.

| Plugin | Auteur | Description | Lien |
|---|---|---|---|
| weather | communauté | Météo temps réel (Open-Meteo, sans clé API) | [→](https://github.com/.../openagent-plugin-weather) |
| quality | communauté | Tests pytest + lint ruff + mypy | [→](https://github.com/.../openagent-plugin-quality) |
```

---

#### Contenu de `docs/architecture/ARCHITECTURE.md`

Pour les contributeurs qui veulent comprendre le projet en profondeur :

```markdown
# Architecture OpenAgentic Skyzer

## Vue d'ensemble

openagenticskyzer/
├── agent.py          ← Point d'entrée CLI + build_agent()
├── app/              ← Interface NiceGUI (desktop)
│   ├── main.py       ← Page NiceGUI, tray, timer
│   ├── state.py      ← Singleton AppState (partagé entre composants)
│   ├── storage.py    ← Config JSON + sessions
│   └── components/   ← Composants UI (chat, sidebar, settings...)
├── graph/            ← LangGraph workflow
│   ├── workflow.py   ← build_graph() — START → agent → tools → END
│   ├── nodes.py      ← Logique des noeuds (forcing search, coercion)
│   └── state.py      ← AgentState (messages: Annotated[list, add_messages])
├── tools/            ← Outils LangChain
├── context/          ← Gestion de contexte (trim, persist, mémoire)
├── plugins/          ← Chargement dynamique des plugins
├── prompts/          ← System prompts
└── permissions.py    ← Système de permissions 3 niveaux

## Flux d'une conversation

1. Utilisateur tape un message → input_bar._send_message()
2. Pré-fetch web (si question factuelle) → internet_search + fetch_url
3. build_agent() construit le graph LangGraph avec les outils
4. agent.astream_events() → tokens streamés en temps réel
5. Nœud agent → appelle le LLM avec l'historique trimmé
6. Si tool_calls → nœud tools → PermissionManager → exécution
7. Boucle agent → tools jusqu'à pas de tool_calls → END
8. Résultat affiché + sauvegardé dans la mémoire projet

## Comment ajouter un outil natif (core)

1. Créer la fonction @tool dans openagenticskyzer/tools/mon_outil.py
2. L'importer dans agent.py et l'ajouter à _ALL_TOOLS
3. Si permission nécessaire : l'ajouter dans permissions._RESTRICTED_TOOLS
4. Mettre à jour le system prompt dans prompts/prompt.py
5. Écrire les tests dans tests/test_mon_outil.py
```

---

#### Implémentation — fichiers à créer pour la Phase 5.3

Ces fichiers sont de la **documentation pure** (pas de code Python). Ils doivent être écrits et committés :

| Fichier | Contenu |
|---|---|
| `docs/CONTRIBUTING.md` | Guide de contribution au projet principal (fork, PR, tests, style) |
| `docs/plugins/PLUGIN_GUIDE.md` | Guide complet moddeur (toutes les 7 sections ci-dessus) |
| `docs/plugins/PLUGIN_API_REFERENCE.md` | Référence exhaustive des APIs internes |
| `docs/plugins/COMMUNITY_REGISTRY.md` | Liste des plugins communautaires (vide au départ) |
| `docs/plugins/examples/weather/weather.py` | Plugin météo complet (exemple officiel) |
| `docs/plugins/examples/weather/README.md` | Readme du plugin météo |
| `docs/plugins/examples/quality/quality.py` | Plugin tests+lint (exemple officiel) |
| `docs/plugins/examples/quality/README.md` | Readme du plugin qualité |
| `docs/architecture/ARCHITECTURE.md` | Vue d'ensemble technique pour contributeurs |
| `docs/architecture/AGENT_FLOW.md` | Détail du graph LangGraph (diagramme + explication) |

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

## Phase 7 — Mémoire & Contexte Intelligent

**Diagnostic du problème actuel :**

La fonction `trigger_compact()` dans `context_bar.py` fait littéralement ceci :
```python
state.messages = state.messages[-4:]   # brutallement supprime tout sauf les 4 derniers
```
Il n'existe aucune mémoire entre sessions. L'IA repart de zéro à chaque ouverture. La "compaction" = amnésie totale.

---

### 7.1 Compaction LLM réelle (remplace le stub actuel)

**Objectif:** Quand le contexte est plein, au lieu de supprimer les vieux messages, demander à l'IA de les résumer en un bloc condensé qui préserve les décisions et le contexte clés.

**Fichier modifié:** `openagenticskyzer/app/components/context_bar.py`

Remplacer entièrement `trigger_compact()` par :

```python
async def trigger_compact():
    """Summarise the conversation via LLM, then replaces old messages with the summary."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.agent import build_agent
    from openagenticskyzer.app.components.chat import chat_messages

    if len(state.messages) < 6:
        ui.notify("Pas assez de messages à compresser.", type="warning")
        return

    # Construit un prompt de résumé
    history_text = "\n\n".join(
        f"[{m.role.upper()}]: {m.content[:800]}"
        for m in state.messages[:-2]   # conserve les 2 derniers intacts
        if m.role in ("user", "ai")
    )
    summary_prompt = f"""Résume cette conversation de manière dense et structurée.
Conserve : décisions prises, fichiers modifiés, problèmes résolus, contexte technique, préférences exprimées.
Omets : salutations, répétitions, tentatives ratées.
Format : liste à puces, max 400 mots.

CONVERSATION :
{history_text}

RÉSUMÉ :"""

    ui.notify("Compression en cours…", type="info")
    try:
        agent = build_agent(mode="ask",
                            provider=state.current_provider,
                            model_name=state.current_model)
        from langchain_core.messages import HumanMessage
        result = await run.io_bound(
            agent.invoke,
            {"messages": [{"role": "user", "content": summary_prompt}]},
            {"recursion_limit": 10},
        )
        summary = ""
        for msg in reversed(result.get("messages", [])):
            content = getattr(msg, "content", "")
            if content and not getattr(msg, "tool_calls", None):
                summary = content if isinstance(content, str) else str(content)
                break

        if summary:
            summary_message = ChatMessage(
                role="ai",
                content=f"**[Résumé de contexte compressé]**\n\n{summary}",
            )
            # Remplace l'historique : [résumé] + [2 derniers messages]
            state.messages = [summary_message] + state.messages[-2:]
            state.context_pct = 15.0
            state.context_tokens = len(summary) // 4
            chat_messages.refresh()
            context_bar.refresh()
            # Sauvegarde le résumé dans la mémoire projet
            _append_to_project_memory(summary)
            ui.notify("Contexte compressé avec résumé IA.", type="positive")
    except Exception as exc:
        # Fallback : compaction brutale si le LLM échoue
        state.messages = state.messages[-6:]
        state.context_pct = max(0.0, state.context_pct - 50.0)
        ui.notify(f"Compaction rapide (LLM indisponible : {exc})", type="warning")
        chat_messages.refresh()
        context_bar.refresh()
```

---

### 7.2 Mémoire de projet

**Objectif:** Chaque dossier dispose d'un fichier `.openagent/memory.md` qui persiste les faits importants entre sessions. L'IA peut y lire et y écrire. Injecté automatiquement en début de chaque conversation.

**Nouveau fichier:** `openagenticskyzer/context/project_memory.py`

```python
"""Mémoire persistante par projet — lire/écrire .openagent/memory.md."""
from pathlib import Path
from datetime import datetime


def _memory_path(folder: str) -> Path:
    return Path(folder) / ".openagent" / "memory.md"


def load_project_memory(folder: str) -> str:
    """Retourne le contenu de la mémoire projet, ou '' si vide."""
    path = _memory_path(folder)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def save_project_memory(folder: str, content: str) -> None:
    path = _memory_path(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.strip(), encoding="utf-8")


def append_to_project_memory(folder: str, new_facts: str) -> None:
    """Ajoute des faits à la mémoire existante, avec timestamp."""
    existing = load_project_memory(folder)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"\n\n<!-- {ts} -->\n{new_facts.strip()}"
    save_project_memory(folder, existing + entry)


def clear_project_memory(folder: str) -> None:
    path = _memory_path(folder)
    if path.exists():
        path.unlink()
```

**Injection en début de session** dans `input_bar.py` — dans `_send_message`, avant de construire `history` :

```python
from openagenticskyzer.context.project_memory import load_project_memory

# Injecte la mémoire projet comme premier message système
project_memory = load_project_memory(state.active_folder)
if project_memory:
    memory_msg = {
        "role": "system",
        "content": (
            "MÉMOIRE DU PROJET (faits persistants des sessions précédentes) :\n\n"
            + project_memory
            + "\n\nUtilise ces informations comme contexte de fond. "
            "Si l'utilisateur te demande de mémoriser quelque chose, "
            "appelle l'outil save_memory()."
        )
    }
    history = [memory_msg] + history
```

**Mise à jour du prompt** (`prompts/prompt.py`) — ajouter la section MÉMOIRE :

```
MEMORY TOOLS:
- save_memory(facts) — Persiste des faits importants dans la mémoire du projet (décisions, architecture, préférences)
- read_memory() — Lit toute la mémoire du projet
- clear_memory_entry(entry) — Supprime un fait spécifique

WHEN TO USE:
- L'utilisateur dit "souviens-toi que...", "retiens que...", "note que..." → appelle save_memory()
- L'utilisateur demande "qu'est-ce que tu sais sur ce projet ?" → appelle read_memory()
- Après avoir résolu un problème complexe → sauvegarde la solution dans la mémoire
- Après avoir pris une décision d'architecture → sauvegarde-la
```

**Nouveau fichier:** `openagenticskyzer/tools/memory_tools.py`

```python
"""Outils de mémoire persistante pour l'agent."""
from langchain_core.tools import tool


@tool
def save_memory(facts: str) -> str:
    """Save important facts, decisions, or preferences to the project's persistent memory.
    Use when the user says 'remember that...', 'note that...', or after solving a complex problem.
    Args: facts — The information to persist (plain text, bullet points welcome).
    Returns: Confirmation."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import append_to_project_memory
    if not state.active_folder:
        return "Aucun dossier actif."
    append_to_project_memory(state.active_folder, facts)
    return f"✓ Mémorisé dans {state.active_folder}/.openagent/memory.md"


@tool
def read_memory() -> str:
    """Read the full project memory (persistent facts from previous sessions).
    Use when the user asks what you know about this project."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import load_project_memory
    if not state.active_folder:
        return "Aucun dossier actif."
    mem = load_project_memory(state.active_folder)
    return mem if mem else "La mémoire du projet est vide."


@tool
def forget_memory(keyword: str) -> str:
    """Remove lines containing a keyword from the project memory.
    Use when the user says 'forget that...', 'remove from memory...'"""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import load_project_memory, save_project_memory
    if not state.active_folder:
        return "Aucun dossier actif."
    mem = load_project_memory(state.active_folder)
    lines = [l for l in mem.splitlines() if keyword.lower() not in l.lower()]
    save_project_memory(state.active_folder, "\n".join(lines))
    return f"✓ Entrées contenant '{keyword}' supprimées de la mémoire."
```

**Intégration dans agent.py:**

```python
from openagenticskyzer.tools.memory_tools import save_memory, read_memory, forget_memory

_ALL_TOOLS = [
    # ... outils existants ...
    save_memory, read_memory, forget_memory,
]
```

---

### 7.3 Mémoire utilisateur globale

**Objectif:** En plus de la mémoire par projet, une mémoire globale `~/.openagent/memory.md` qui persiste les préférences et faits sur l'utilisateur (style de code préféré, langue, conventions, outils favoris).

**Ajout dans `project_memory.py`:**

```python
def _global_memory_path() -> Path:
    return Path.home() / ".openagent" / "memory.md"


def load_global_memory() -> str:
    path = _global_memory_path()
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def append_to_global_memory(facts: str) -> None:
    existing = load_global_memory()
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"\n\n<!-- {ts} -->\n{facts.strip()}"
    path = _global_memory_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text((existing + entry).strip(), encoding="utf-8")
```

**Outil enrichi `save_memory`** — accepter un paramètre `scope`:

```python
@tool
def save_memory(facts: str, scope: str = "project") -> str:
    """Save facts to memory. scope='project' (default) or scope='global' (all projects).
    Use scope='global' for user preferences like coding style, language preference, tools."""
    if scope == "global":
        from openagenticskyzer.context.project_memory import append_to_global_memory
        append_to_global_memory(facts)
        return "✓ Mémorisé dans la mémoire globale (~/.openagent/memory.md)"
    # ... project scope comme avant
```

**Injection en début de session** — injecter les deux niveaux de mémoire :

```python
global_memory = load_global_memory()
project_memory = load_project_memory(state.active_folder)

memory_sections = []
if global_memory:
    memory_sections.append("PRÉFÉRENCES UTILISATEUR (globales) :\n" + global_memory)
if project_memory:
    memory_sections.append("MÉMOIRE DU PROJET (ce dossier) :\n" + project_memory)

if memory_sections:
    history = [{"role": "system", "content": "\n\n---\n\n".join(memory_sections)}] + history
```

---

### 7.4 Résumé automatique de fin de session

**Objectif:** À la fermeture de l'app ou quand l'utilisateur change de dossier, générer automatiquement un résumé de la session et l'ajouter à la mémoire projet.

**Déclenchement dans `main.py`** — sur changement de dossier et à la fermeture :

```python
async def _on_folder_change(new_folder: str):
    """Avant de changer de dossier, résume la session en cours."""
    if state.active_folder and len(state.messages) >= 4:
        await _auto_summarize_session(state.active_folder)
    # ... suite du changement de dossier ...

async def _auto_summarize_session(folder: str):
    """Génère un résumé de la session et l'ajoute à la mémoire projet."""
    from openagenticskyzer.agent import build_agent
    from openagenticskyzer.context.project_memory import append_to_project_memory

    convo = "\n\n".join(
        f"[{m.role.upper()}]: {m.content[:600]}"
        for m in state.messages
        if m.role in ("user", "ai")
    )
    if not convo.strip():
        return

    prompt = f"""En 3-5 points, résume ce qui a été accompli dans cette session de travail.
Inclus : tâches complétées, décisions prises, fichiers modifiés importants, problèmes rencontrés.
Sois concis et factuel. Format : liste à puces.

SESSION :
{convo[:3000]}

RÉSUMÉ :"""

    try:
        agent = build_agent(mode="ask",
                            provider=state.current_provider,
                            model_name=state.current_model)
        result = await run.io_bound(
            agent.invoke,
            {"messages": [{"role": "user", "content": prompt}]},
            {"recursion_limit": 5},
        )
        for msg in reversed(result.get("messages", [])):
            content = getattr(msg, "content", "")
            if content and not getattr(msg, "tool_calls", None):
                summary = content if isinstance(content, str) else str(content)
                append_to_project_memory(folder, f"## Session terminée\n{summary}")
                break
    except Exception:
        pass   # Silencieux — ne jamais bloquer le changement de dossier
```

---

### 7.5 UI Mémoire

**Objectif:** Permettre à l'utilisateur de consulter, modifier et vider la mémoire directement depuis l'interface.

**Nouvel onglet dans settings.py** — "🧠 Mémoire" :

```python
def _tab_memory():
    from openagenticskyzer.context.project_memory import (
        load_project_memory, save_project_memory,
        load_global_memory, append_to_global_memory,
    )

    _section("Mémoire du projet")
    project_mem = load_project_memory(state.active_folder or "")
    if project_mem:
        mem_area = ui.textarea(value=project_mem).classes("w-full font-mono text-xs").props("rows=8")
        with ui.row().classes("gap-2 px-4"):
            ui.button("Sauvegarder", on_click=lambda: save_project_memory(
                state.active_folder, mem_area.value
            )).classes("text-xs text-green-400 border border-green-900 bg-transparent")
            ui.button("Effacer tout", on_click=lambda: _clear_memory("project")).classes(
                "text-xs text-red-400 border border-red-900 bg-transparent"
            )
    else:
        ui.label("Mémoire projet vide.").classes("text-xs text-gray-600 px-4")

    _section("Mémoire globale (tous les projets)")
    global_mem = load_global_memory()
    if global_mem:
        gmem_area = ui.textarea(value=global_mem).classes("w-full font-mono text-xs").props("rows=6")
        ui.button("Sauvegarder", on_click=lambda: ...).classes("text-xs ...")
    else:
        ui.label("Mémoire globale vide.").classes("text-xs text-gray-600 px-4")
```

**Commandes naturelles reconnues** dans `input_bar.py` — détecter les intentions mémoire sans passer par le LLM :

| Message utilisateur | Action déclenchée |
|---|---|
| "souviens-toi que..." | `save_memory()` automatique via outil |
| "qu'est-ce que tu sais ?" | `read_memory()` automatique |
| "oublie que..." | `forget_memory()` automatique |
| "résume cette session" | `trigger_compact()` avec LLM |

---

### 7.6 Résumé des fichiers — Phase 7

**Nouveaux fichiers :**
- `openagenticskyzer/context/project_memory.py` — lecture/écriture `.openagent/memory.md` et `~/.openagent/memory.md`
- `openagenticskyzer/tools/memory_tools.py` — `save_memory`, `read_memory`, `forget_memory`

**Fichiers modifiés :**
- `openagenticskyzer/app/components/context_bar.py` — remplacement complet du stub `trigger_compact()` par la version LLM
- `openagenticskyzer/app/components/input_bar.py` — injection mémoire globale + projet dans le contexte
- `openagenticskyzer/app/components/settings.py` — nouvel onglet "🧠 Mémoire"
- `openagenticskyzer/app/main.py` — `_auto_summarize_session()` sur changement de dossier
- `openagenticskyzer/agent.py` — ajout `save_memory`, `read_memory`, `forget_memory` dans `_ALL_TOOLS`
- `openagenticskyzer/prompts/prompt.py` — section MEMORY TOOLS

---

## Phase 8 — UX Avancée

### 8.1 Édition de messages et régénération

**Objectif:** Permettre d'éditer un message utilisateur déjà envoyé (et relancer depuis ce point), ou de régénérer la dernière réponse de l'IA avec des paramètres différents.

**Modification `chat.py`** — ajouter un bouton "✏️" au survol de chaque message utilisateur :

```python
# Dans le rendu d'un message user
with ui.row().classes("w-full justify-end mb-2 group"):
    with ui.element("div").classes("flex flex-col items-end gap-1"):
        # Boutons apparaissent au hover (opacity-0 group-hover:opacity-100)
        with ui.row().classes("opacity-0 group-hover:opacity-100 gap-1 transition-opacity"):
            ui.button("✏️", on_click=lambda idx=i: _edit_message(idx)).classes(
                "w-6 h-6 bg-gray-800 text-gray-400 hover:text-white text-xs rounded"
            )
        with ui.card()...:
            ui.label(m.content)...
```

**Handler `_edit_message(idx)`** — remplace le textarea par le contenu du message et tronque l'historique à `idx` :

```python
def _edit_message(idx: int):
    msg = state.messages[idx]
    input_el.set_value(msg.content)
    state.messages = state.messages[:idx]   # supprime ce message et tout ce qui suit
    from openagenticskyzer.app.components.chat import chat_messages
    chat_messages.refresh()
    input_el.run_method("focus")
```

**Bouton "🔄 Régénérer"** sur le dernier message AI :

```python
# Affiché uniquement sur le dernier message AI, quand agent non actif
if i == last_ai_idx and not state.agent_running:
    ui.button("🔄", on_click=_regenerate).classes(
        "text-xs text-gray-500 hover:text-purple-400 bg-transparent"
    ).tooltip("Régénérer cette réponse")

def _regenerate():
    # Supprime le dernier message AI et relance avec le même message user
    last_user = next(
        (m for m in reversed(state.messages) if m.role == "user"), None
    )
    if not last_user:
        return
    # Retire tous les messages depuis le dernier user (inclus)
    idx = len(state.messages) - 1
    while idx >= 0 and state.messages[idx].role != "user":
        idx -= 1
    text = state.messages[idx].content
    state.messages = state.messages[:idx]
    asyncio.ensure_future(_send_message(text, input_el, send_lbl, send_btn))
```

---

### 8.2 Command Palette (Ctrl+K)

**Objectif:** Accès instantané à toutes les actions de l'app depuis un raccourci clavier, sans naviguer dans les menus.

**Nouveau composant:** `openagenticskyzer/app/components/command_palette.py`

```python
"""Command palette — Ctrl+K pour accéder à toutes les actions."""
from nicegui import ui
from openagenticskyzer.app.state import state

_COMMANDS = [
    # (label, description, action_fn)
    ("📂 Ouvrir un dossier",          "Choisir un nouveau dossier projet",      lambda: ...),
    ("🔄 Changer de modèle",           "Sélectionner un autre modèle LLM",       lambda: open_model_modal()),
    ("🗑️ Vider l'historique",          "Effacer tous les messages",               lambda: _clear_history()),
    ("⚙️ Paramètres",                  "Ouvrir les paramètres",                  lambda: ...),
    ("🧠 Voir la mémoire projet",      "Afficher .openagent/memory.md",          lambda: _show_memory()),
    ("📋 Bibliothèque de prompts",     "Parcourir les templates",                lambda: ...),
    ("⬇ Exporter la conversation",    "Sauvegarder en markdown/HTML/JSON",      lambda: ...),
    ("🔍 Recherche sémantique",        "Chercher dans le codebase par sens",     lambda: _focus_semantic_search()),
    ("⚡ Compacter le contexte",       "Résumer et compresser l'historique",     lambda: trigger_compact()),
    ("🌙 Basculer thème",              "Passer du mode sombre au mode clair",    lambda: _toggle_theme()),
]


def render_command_palette():
    with ui.dialog() as dlg:
        dlg.props("persistent")
        with ui.card().classes("bg-gray-900 border border-gray-700 w-[520px]"):
            search_input = ui.input(placeholder="Rechercher une action…").classes(
                "w-full text-sm"
            ).props("autofocus")

            results_col = ui.column().classes("w-full gap-0.5 mt-2 max-h-72 overflow-y-auto")

            def _filter(query: str):
                results_col.clear()
                q = query.lower()
                matches = [(l, d, fn) for l, d, fn in _COMMANDS if q in l.lower() or q in d.lower()]
                with results_col:
                    for label, desc, action in matches[:8]:
                        with ui.row().classes(
                            "w-full items-center px-3 py-2 rounded hover:bg-gray-800 "
                            "cursor-pointer gap-3"
                        ).on("click", lambda fn=action: (dlg.close(), fn())):
                            ui.label(label).classes("text-sm text-gray-200 flex-1")
                            ui.label(desc).classes("text-xs text-gray-500")

            search_input.on("update:model-value", lambda e: _filter(e.args or ""))
            _filter("")   # affiche tout au départ

    # Raccourci global Ctrl+K
    ui.keyboard(on_key=lambda e: dlg.open() if e.key == "k" and e.ctrl else None)
    return dlg
```

**Intégration dans `main.py`** — appeler `render_command_palette()` une fois dans `main_page()`.

**Hint dans l'UI** — ajouter `Ctrl+K` dans la barre de bas de l'input bar :

```python
ui.label("Entrée pour envoyer · Shift+Entrée nouvelle ligne · Ctrl+K commandes").classes(
    "text-xs text-gray-700 px-1"
)
```

---

### 8.3 Conversation Branching (Fork)

**Objectif:** Depuis n'importe quel message, créer une "branche" — une nouvelle conversation qui repart de ce point avec un historique différent. Utile pour essayer deux approches sans perdre la première.

**Nouveau champ `state.py`:**

```python
@dataclass
class ConversationBranch:
    branch_id: str
    label: str
    messages: list[ChatMessage]
    created_at: str

@dataclass
class AppState:
    # ... champs existants ...
    branches: list[ConversationBranch] = field(default_factory=list)
    current_branch_id: str = "main"
```

**Bouton Fork** sur chaque message dans `chat.py` :

```python
ui.button("⑂ Fork", on_click=lambda idx=i: _fork_from(idx)).classes(
    "opacity-0 group-hover:opacity-100 text-xs text-gray-500 hover:text-purple-400 bg-transparent"
).tooltip("Créer une branche depuis ici")

def _fork_from(idx: int):
    import uuid
    from datetime import datetime
    branch = ConversationBranch(
        branch_id=str(uuid.uuid4())[:8],
        label=f"Branche {len(state.branches) + 1}",
        messages=state.messages[:idx + 1].copy(),
        created_at=datetime.now().isoformat(),
    )
    state.branches.append(branch)
    # Switche sur la nouvelle branche
    _switch_branch(branch.branch_id)
    ui.notify(f"Branche '{branch.label}' créée — tu repars de ce point.", type="positive")
```

**Sélecteur de branches** dans le header du chat (visible si `len(state.branches) > 0`) :

```python
if state.branches:
    with ui.select(
        options={b.branch_id: b.label for b in [_main_branch()] + state.branches},
        value=state.current_branch_id,
        on_change=lambda e: _switch_branch(e.value),
    ).classes("text-xs bg-gray-900 border-gray-700"):
        pass
```

---

### 8.4 Onglets de conversations (Tabs)

**Objectif:** Avoir plusieurs conversations ouvertes en parallèle (projet A et projet B), chacune avec son propre historique et modèle actif.

**Refactoring `state.py`** — chaque onglet est une instance de `TabState` :

```python
@dataclass
class TabState:
    tab_id: str
    folder: str | None = None
    messages: list[ChatMessage] = field(default_factory=list)
    current_model: str | None = None
    current_provider: str | None = None
    agent_running: bool = False
    context_pct: float = 0.0

@dataclass
class AppState:
    tabs: list[TabState] = field(default_factory=lambda: [TabState(tab_id="tab_1")])
    active_tab_id: str = "tab_1"
    # Les champs existants deviennent des propriétés qui lisent l'onglet actif
    @property
    def active_folder(self) -> str | None:
        return self._active_tab.folder
    @property
    def messages(self) -> list[ChatMessage]:
        return self._active_tab.messages
    # ... etc.
```

**Header des tabs** dans `main.py`, sous la top bar :

```python
with ui.row().classes("w-full border-b border-gray-900 px-2 gap-0").style("background:#0d0d0d"):
    for tab in state.tabs:
        label = (tab.folder or "Nouveau").split("\\")[-1].split("/")[-1]
        active = tab.tab_id == state.active_tab_id
        with ui.row().classes(
            f"items-center px-3 py-1.5 gap-1 cursor-pointer border-b-2 "
            f"{'border-purple-500 text-gray-200' if active else 'border-transparent text-gray-500 hover:text-gray-300'}"
        ).on("click", lambda tid=tab.tab_id: _switch_tab(tid)):
            ui.label(label).classes("text-xs")
            ui.button("×", on_click=lambda tid=tab.tab_id: _close_tab(tid)).classes(
                "w-4 h-4 text-gray-600 hover:text-gray-300 bg-transparent text-xs"
            )
    ui.button("+", on_click=_new_tab).classes(
        "px-2 py-1.5 text-gray-600 hover:text-gray-300 bg-transparent text-sm"
    )
```

---

## Phase 9 — Dev Tools Pro

### 9.1 Terminal Embarqué

**Objectif:** Un vrai terminal interactif intégré dans l'app, accessible depuis un panneau coulissant en bas. L'utilisateur peut exécuter des commandes manuellement en parallèle de l'agent.

**Approche:** NiceGUI supporte l'injection de HTML/JS arbitraire. On intègre **xterm.js** (terminal web standard) connecté à un pseudo-terminal Python (`pty` sur Unix, `winpty` sur Windows).

**Nouveau fichier:** `openagenticskyzer/app/components/terminal_panel.py`

```python
"""Terminal interactif embarqué via xterm.js + pty."""
from nicegui import ui
from openagenticskyzer.app.state import state
import threading, os, sys

_pty_process = None


def _inject_xterm(container_id: str):
    ui.add_head_html("""
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/xterm@5/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8/lib/xterm-addon-fit.js"></script>
    """)
    ui.run_javascript(f"""
    const term = new Terminal({{
        theme: {{background: '#0d0d0d', foreground: '#e0e0e0'}},
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        cursorBlink: true,
    }});
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('{container_id}'));
    fitAddon.fit();
    window._openagentTerm = term;

    // WebSocket pour communiquer avec le pty Python
    const ws = new WebSocket('ws://127.0.0.1:8766/terminal');
    ws.onmessage = e => term.write(e.data);
    term.onData(data => ws.send(data));
    window.addEventListener('resize', () => fitAddon.fit());
    """)


@ui.refreshable
def terminal_panel():
    if not state.show_terminal:
        return
    with ui.column().classes("w-full border-t border-gray-800").style("height:240px;background:#0d0d0d"):
        with ui.row().classes("items-center px-3 py-1 border-b border-gray-800"):
            ui.label("Terminal").classes("text-xs text-gray-500 flex-1")
            ui.label(state.active_folder or "").classes("text-xs text-gray-700 font-mono")
            ui.button("✕", on_click=lambda: setattr(state, "show_terminal", False) or terminal_panel.refresh()).classes(
                "w-5 h-5 bg-transparent text-gray-600 text-xs"
            )
        ui.html('<div id="openagent-terminal" style="height:100%;padding:4px"></div>')
        _inject_xterm("openagent-terminal")
```

**Backend WebSocket** (`app/terminal_server.py`) — serveur pty séparé sur port 8766 :

```python
"""WebSocket server qui gère un pseudo-terminal (pty)."""
import asyncio, os, pty, subprocess
import websockets

async def handle(ws):
    folder = os.environ.get("OPENAGENT_TERMINAL_CWD", os.path.expanduser("~"))
    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(
        ["cmd.exe"] if os.name == "nt" else [os.environ.get("SHELL", "/bin/bash")],
        stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
        cwd=folder, close_fds=True,
    )
    # ... boucle read/write entre WebSocket et pty ...

async def main():
    async with websockets.serve(handle, "127.0.0.1", 8766):
        await asyncio.Future()
```

**Bouton terminal** dans la top bar de `main.py` :

```python
ui.button("⌨", on_click=lambda: (
    setattr(state, "show_terminal", not state.show_terminal),
    terminal_panel.refresh()
)).classes("text-xs text-gray-500 hover:text-gray-300 bg-transparent").tooltip("Terminal (Ctrl+`)")
```

**Nouveau champ `state.py`:**
```python
show_terminal: bool = False
```

---

### 9.2 Diff Viewer Interactif (Accepter / Rejeter)

**Objectif:** Quand l'agent modifie un fichier (`edit_file`), afficher le diff avec des boutons "✓ Accepter" et "✗ Rejeter" au lieu de juste montrer le texte. L'acceptation écrit réellement le fichier ; le rejet restaure l'original.

**Nouveau champ `ChatMessage`:**

```python
@dataclass
class ChatMessage:
    # ... champs existants ...
    tool_diff: str | None = None
    tool_file_path: str | None = None    # NOUVEAU — chemin absolu du fichier modifié
    tool_original: str | None = None     # NOUVEAU — contenu original avant modification
    diff_accepted: bool | None = None    # NOUVEAU — None=en attente, True=accepté, False=rejeté
```

**Modification `crud_tools.py` — `edit_file`** — retourner l'original dans le message tool :

```python
# edit_file stocke le contenu original avant modification
# Le tool node l'attache au ChatMessage correspondant
```

**Modification `chat.py` — rendu du diff** :

```python
# Si diff_accepted is None (en attente de décision)
if m.tool_diff and m.tool_file_path and m.diff_accepted is None:
    with ui.row().classes("gap-2 mt-2"):
        ui.button("✓ Accepter", on_click=lambda msg=m: _accept_diff(msg)).classes(
            "text-xs bg-green-900 text-green-300 hover:bg-green-800 px-3 py-1 rounded"
        )
        ui.button("✗ Rejeter", on_click=lambda msg=m: _reject_diff(msg)).classes(
            "text-xs bg-red-900 text-red-300 hover:bg-red-800 px-3 py-1 rounded"
        )
elif m.diff_accepted is True:
    ui.label("✓ Modification acceptée").classes("text-xs text-green-500 mt-1")
elif m.diff_accepted is False:
    ui.label("✗ Modification rejetée — fichier restauré").classes("text-xs text-red-400 mt-1")

def _accept_diff(msg: ChatMessage):
    msg.diff_accepted = True
    # Le fichier a déjà été modifié par edit_file — rien à faire
    chat_messages.refresh()

def _reject_diff(msg: ChatMessage):
    msg.diff_accepted = False
    # Restaurer le fichier original
    if msg.tool_file_path and msg.tool_original is not None:
        from pathlib import Path
        Path(msg.tool_file_path).write_text(msg.tool_original, encoding="utf-8")
    chat_messages.refresh()
    ui.notify("Fichier restauré.", type="positive")
```

**Note:** En mode `demander`, l'acceptation/rejet remplace la demande de permission. En mode `auto`, le diff interactif est affiché en post-validation (l'agent a déjà écrit, l'utilisateur peut annuler).

---

### 9.3 Browser Preview Intégré

**Objectif:** Quand l'agent lance un serveur de développement (Next.js, Flask, FastAPI, Vite...), afficher l'app directement dans un panneau sans ouvrir un navigateur externe.

**Détection du port** dans `shell_exec.py` — quand un serveur démarre en background, capturer le port :

```python
_PORT_RE = re.compile(r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})|port[:\s]+(\d{4,5})", re.IGNORECASE)

def _detect_server_port(output: str) -> int | None:
    m = _PORT_RE.search(output)
    if m:
        return int(m.group(1) or m.group(2))
    return None
```

**Nouveau champ `state.py`:**

```python
preview_url: str = ""    # ex: "http://127.0.0.1:3000"
show_preview: bool = False
```

**Nouveau composant:** `openagenticskyzer/app/components/preview_panel.py`

```python
"""Panneau de preview — iframe vers le serveur de dev."""
from nicegui import ui
from openagenticskyzer.app.state import state


@ui.refreshable
def preview_panel():
    if not state.show_preview or not state.preview_url:
        return
    with ui.column().classes("h-full border-l border-gray-800").style("width:480px;flex-shrink:0"):
        with ui.row().classes("items-center px-3 py-2 border-b border-gray-800 gap-2"):
            ui.label("Preview").classes("text-xs text-gray-400 flex-1")
            ui.input(value=state.preview_url).classes("text-xs font-mono bg-gray-950 border-gray-700 flex-1").on(
                "change", lambda e: setattr(state, "preview_url", e.args) or preview_panel.refresh()
            )
            ui.button("🔄", on_click=preview_panel.refresh).classes("text-xs text-gray-500 bg-transparent")
            ui.button("↗", on_click=lambda: ui.run_javascript(f"window.open('{state.preview_url}')")).classes(
                "text-xs text-gray-500 bg-transparent"
            ).tooltip("Ouvrir dans le navigateur")
            ui.button("✕", on_click=lambda: setattr(state, "show_preview", False) or preview_panel.refresh()).classes(
                "text-xs text-gray-600 bg-transparent"
            )
        ui.html(f'<iframe src="{state.preview_url}" style="width:100%;height:100%;border:none;background:white"></iframe>')
```

**Intégration dans shell_exec.py** — après démarrage d'un serveur background :

```python
port = _detect_server_port(output)
if port:
    state.preview_url = f"http://127.0.0.1:{port}"
    state.show_preview = True
    preview_panel.refresh()
```

---

## Phase 10 — Agent Personas & Comparaison

### 10.1 Personas d'agents pré-configurés

**Objectif:** Des agents avec des identités spécifiques, chacun avec son propre system prompt, ses outils activés/désactivés, et son ton. L'utilisateur choisit un persona dans le sélecteur de modèle.

**Nouveau fichier:** `openagenticskyzer/prompts/personas.py`

```python
"""Personas d'agents pré-configurés."""
from dataclasses import dataclass, field


@dataclass
class AgentPersona:
    id: str
    name: str
    icon: str
    description: str
    system_prompt_suffix: str      # Ajouté après DEEP_AGENT_SYSTEM_PROMPT
    enabled_tools: list[str] | None = None   # None = tous les outils
    disabled_tools: list[str] = field(default_factory=list)
    temperature: float = 0.3


PERSONAS: list[AgentPersona] = [
    AgentPersona(
        id="default",
        name="Assistant Général",
        icon="🤖",
        description="Agent polyvalent pour toutes les tâches.",
        system_prompt_suffix="",
    ),
    AgentPersona(
        id="devops",
        name="DevOps Engineer",
        icon="🚀",
        description="Spécialiste infra, CI/CD, Docker, Kubernetes, scripts shell.",
        system_prompt_suffix="""
You are a senior DevOps engineer. You specialize in:
- Infrastructure as Code (Terraform, Ansible, Pulumi)
- CI/CD pipelines (GitHub Actions, GitLab CI, Jenkins)
- Containerization (Docker, docker-compose, Kubernetes)
- Cloud providers (AWS, GCP, Azure)
- Shell scripting (bash, zsh, PowerShell)
- Monitoring (Prometheus, Grafana, Datadog)
Always suggest infrastructure best practices, consider security implications,
and prefer declarative configuration over imperative scripts.
""",
        disabled_tools=["internet_search"],  # DevOps = offline work
    ),
    AgentPersona(
        id="code_reviewer",
        name="Code Reviewer",
        icon="👁️",
        description="Revue de code rigoureuse : bugs, sécurité, performance, lisibilité.",
        system_prompt_suffix="""
You are an expert code reviewer. Your job is to:
1. Find bugs, edge cases, and logic errors
2. Identify security vulnerabilities (OWASP Top 10, injection, XSS, etc.)
3. Point out performance bottlenecks
4. Suggest readability and maintainability improvements
5. Check for proper error handling and logging
Be constructive but thorough. Use line references. Prioritize: CRITICAL > IMPORTANT > SUGGESTION.
Never approve code with security vulnerabilities or data loss risks.
""",
        disabled_tools=["run_command", "delete_file", "delete_dir"],
        temperature=0.1,
    ),
    AgentPersona(
        id="data_scientist",
        name="Data Scientist",
        icon="📊",
        description="Analyse de données, ML, visualisation, pandas, numpy, scikit-learn.",
        system_prompt_suffix="""
You are a senior data scientist. You specialize in:
- Exploratory data analysis (pandas, polars)
- Machine learning (scikit-learn, XGBoost, LightGBM)
- Deep learning (PyTorch, TensorFlow/Keras)
- Data visualization (matplotlib, seaborn, plotly)
- Statistical analysis and hypothesis testing
- Feature engineering and model evaluation
Always explain your statistical reasoning. Prefer reproducible pipelines.
Suggest visualization when it would clarify the data.
""",
    ),
    AgentPersona(
        id="architect",
        name="Software Architect",
        icon="🏗️",
        description="Conception de systèmes, patterns, APIs, scalabilité.",
        system_prompt_suffix="""
You are a software architect with 15+ years of experience. You focus on:
- System design and high-level architecture
- Design patterns (GoF, Enterprise, Distributed Systems)
- API design (REST, GraphQL, gRPC)
- Database schema design and optimization
- Scalability, reliability, and maintainability
- Trade-off analysis between architectural choices
Think at the system level. Draw ASCII diagrams when helpful.
Question requirements before designing. Prefer simple solutions over clever ones.
""",
        disabled_tools=["run_command"],
        temperature=0.5,
    ),
    AgentPersona(
        id="security",
        name="Security Auditor",
        icon="🔒",
        description="Audit de sécurité, pentest, vulnérabilités, OWASP.",
        system_prompt_suffix="""
You are a security expert and ethical hacker. You analyze code and systems for:
- Authentication and authorization flaws
- Injection vulnerabilities (SQL, command, LDAP, XPath)
- XSS, CSRF, SSRF vulnerabilities
- Insecure dependencies and supply chain risks
- Secrets and credentials exposure
- Cryptographic weaknesses
- Business logic flaws
Always provide a severity rating (CRITICAL/HIGH/MEDIUM/LOW/INFO) and a remediation.
Never suggest exploiting vulnerabilities on systems you don't own.
""",
        temperature=0.1,
    ),
]

PERSONAS_BY_ID = {p.id: p for p in PERSONAS}
```

**Intégration dans `build_agent()`:**

```python
def build_agent(mode: str = "auto", persona_id: str = "default", ...):
    from openagenticskyzer.prompts.personas import PERSONAS_BY_ID
    from openagenticskyzer.prompts.prompt import DEEP_AGENT_SYSTEM_PROMPT

    persona = PERSONAS_BY_ID.get(persona_id, PERSONAS_BY_ID["default"])
    system_prompt = DEEP_AGENT_SYSTEM_PROMPT + persona.system_prompt_suffix

    # Filtrer les outils selon le persona
    active_tools = [
        t for t in all_tools
        if t.name not in persona.disabled_tools
        and (persona.enabled_tools is None or t.name in persona.enabled_tools)
    ]
```

**Nouveau champ `state.py`:**
```python
current_persona_id: str = "default"
```

**UI dans `model_modal.py`** — section Persona avant le sélecteur de modèle :

```python
_section("Persona de l'agent")
with ui.row().classes("flex-wrap gap-2 px-4"):
    for persona in PERSONAS:
        selected = persona.id == state.current_persona_id
        with ui.card().classes(
            f"cursor-pointer p-2 {'border-purple-500 bg-purple-950' if selected else 'border-gray-700 bg-gray-900'} border rounded-lg"
        ).on("click", lambda pid=persona.id: _select_persona(pid)):
            ui.label(f"{persona.icon} {persona.name}").classes("text-xs text-gray-200 font-medium")
            ui.label(persona.description[:50]).classes("text-xs text-gray-500")
```

---

### 10.2 Comparaison Multi-Modèles

**Objectif:** Envoyer le même prompt à 2-3 modèles simultanément et afficher les réponses côte à côte pour comparer la qualité, la vitesse, et le style.

**Nouveau champ `state.py`:**

```python
compare_mode: bool = False
compare_models: list[tuple[str, str]] = field(default_factory=list)
# [(provider, model_name), ...]
compare_results: dict[str, str] = field(default_factory=dict)
# {f"{provider}:{model}" → response}
```

**Bouton "⊞ Comparer"** dans l'input bar (visible si compare_mode activé) :

```python
# Dans _send_message, si compare_mode:
async def _send_compare(text: str):
    tasks = []
    for provider, model in state.compare_models[:3]:
        agent = build_agent(provider=provider, model_name=model, mode="ask")
        tasks.append(run.io_bound(
            agent.invoke,
            {"messages": [{"role": "user", "content": text}]},
            {"recursion_limit": 50},
        ))
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for (provider, model), result in zip(state.compare_models, results):
        key = f"{provider}:{model}"
        if isinstance(result, Exception):
            state.compare_results[key] = f"❌ Erreur : {result}"
        else:
            for msg in reversed(result.get("messages", [])):
                content = getattr(msg, "content", "")
                if content:
                    state.compare_results[key] = content
                    break
```

**Rendu côte à côte dans `chat.py`** — après les messages normaux, si `compare_results` non vide :

```python
if state.compare_results:
    with ui.row().classes("w-full gap-2 p-2"):
        for key, content in state.compare_results.items():
            provider, model = key.split(":", 1)
            with ui.card().classes("flex-1 bg-gray-900 border border-gray-700 rounded-xl p-3"):
                ui.label(f"● {model}").classes("text-xs text-purple-400 font-medium mb-2")
                ui.markdown(content).classes("text-xs text-gray-200")
```

---

## Phase 11 — Voice Input

### 11.1 Dictée vocale locale (Whisper.cpp)

**Objectif:** Dicter ses messages via le micro, transcription 100% locale via Whisper.cpp — aucun audio envoyé dans le cloud. Fonctionne hors ligne.

**Approche:** Utiliser `faster-whisper` (implémentation CTranslate2, CPU-friendly) ou `whisper-cpp-python` (binding Python vers whisper.cpp).

**Nouveau fichier:** `openagenticskyzer/app/voice_input.py`

```python
"""Transcription vocale locale via faster-whisper."""
import io
import threading
import wave
import numpy as np

_model = None
_recording = False
_audio_frames = []


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        # "base" = 74MB, rapide, bon compromis qualité/vitesse
        # "small" = 244MB, meilleure qualité
        _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


def start_recording():
    global _recording, _audio_frames
    import sounddevice as sd
    _recording = True
    _audio_frames = []

    def _callback(indata, frames, time, status):
        if _recording:
            _audio_frames.append(indata.copy())

    # 16kHz mono, format attendu par Whisper
    stream = sd.InputStream(samplerate=16000, channels=1, dtype="float32",
                            callback=_callback)
    stream.start()
    return stream


def stop_and_transcribe(stream) -> str:
    global _recording
    _recording = False
    stream.stop()
    stream.close()

    if not _audio_frames:
        return ""
    audio = np.concatenate(_audio_frames, axis=0).flatten()
    model = _get_model()
    segments, _ = model.transcribe(audio, language="fr", beam_size=5)
    return " ".join(seg.text for seg in segments).strip()
```

**Bouton micro** dans `input_bar.py` — à côté du bouton 📎 :

```python
from openagenticskyzer.app.voice_input import start_recording, stop_and_transcribe

_stream = None

def _on_mic_click():
    global _stream
    if _stream is None:
        # Démarre l'enregistrement
        _stream = start_recording()
        mic_btn.classes(add="text-red-500 animate-pulse", remove="text-gray-500")
        mic_btn.props("icon=mic")
    else:
        # Arrête et transcrit
        mic_btn.classes(add="text-gray-500 animate-none", remove="text-red-500 animate-pulse")
        text = stop_and_transcribe(_stream)
        _stream = None
        if text:
            current = input_el.value or ""
            input_el.set_value((current + " " + text).strip())
        mic_btn.props("icon=mic_none")

mic_btn = ui.button("🎙️", on_click=_on_mic_click).classes(
    "w-8 h-10 bg-gray-900 border border-gray-800 text-gray-500 rounded-lg flex-shrink-0 text-sm"
).tooltip("Dicter un message (Whisper local)")
```

**Nouvelles dépendances:**

```toml
[project.optional-dependencies]
voice = [
    "faster-whisper>=1.0",
    "sounddevice>=0.4",
    "numpy>=1.24",
]
all = [..., "faster-whisper>=1.0", "sounddevice>=0.4", "numpy>=1.24"]
```

---

## Phase 12 — Analytics & Transparence

### 12.1 Suivi des coûts API

**Objectif:** Pour les providers cloud (Groq, Mistral, Together, OpenRouter, etc.), afficher le coût estimé en tokens × tarif de chaque session et au total.

**Nouveau fichier:** `openagenticskyzer/app/cost_tracker.py`

```python
"""Estimation du coût des appels LLM par provider/modèle."""

# Prix en USD par million de tokens (input / output)
# Sources : pages de tarification officielles — à mettre à jour régulièrement
PRICING: dict[str, dict[str, tuple[float, float]]] = {
    "groq": {
        "llama-3.3-70b-versatile":     (0.59, 0.79),
        "llama-3.1-8b-instant":        (0.05, 0.08),
        "mixtral-8x7b-32768":          (0.24, 0.24),
        "gemma2-9b-it":                (0.20, 0.20),
    },
    "mistral": {
        "mistral-large-latest":        (2.00, 6.00),
        "mistral-small-latest":        (0.20, 0.60),
        "codestral-latest":            (0.20, 0.60),
        "open-mistral-7b":             (0.25, 0.25),
    },
    "together": {
        "meta-llama/Llama-3.3-70B":   (0.88, 0.88),
        "mistralai/Mixtral-8x7B":      (0.60, 0.60),
    },
    "gemini": {
        "gemini-2.0-flash":            (0.075, 0.30),
        "gemini-1.5-pro":              (1.25, 5.00),
    },
    # Ollama et LM Studio → 0 (local, gratuit)
    "ollama":    {},
    "lmstudio":  {},
}


def estimate_cost(provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """Retourne le coût estimé en USD."""
    rates = PRICING.get(provider, {}).get(model)
    if not rates:
        return 0.0
    input_rate, output_rate = rates
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000


def format_cost(usd: float) -> str:
    if usd == 0.0:
        return "gratuit (local)"
    if usd < 0.001:
        return f"< $0.001"
    return f"${usd:.4f}"
```

**Nouveau champ `state.py`:**

```python
session_input_tokens: int = 0
session_output_tokens: int = 0
session_cost_usd: float = 0.0
total_cost_usd: float = 0.0    # persisté dans global config
```

**Tracking dans `GUIAgentCallback`** (`gui_callback.py`) — sur `on_llm_end` :

```python
def on_llm_end(self, response, **kwargs):
    usage = getattr(response, "llm_output", {}).get("token_usage", {})
    input_t = usage.get("prompt_tokens", 0)
    output_t = usage.get("completion_tokens", 0)
    state.session_input_tokens += input_t
    state.session_output_tokens += output_t
    from openagenticskyzer.app.cost_tracker import estimate_cost
    cost = estimate_cost(state.current_provider or "", state.current_model or "", input_t, output_t)
    state.session_cost_usd += cost
    state.total_cost_usd += cost
```

**Affichage dans `context_bar.py`** — à côté de la jauge :

```python
from openagenticskyzer.app.cost_tracker import format_cost

if state.session_cost_usd > 0 or state.current_provider not in ("ollama", "lmstudio"):
    ui.label(format_cost(state.session_cost_usd)).classes(
        "text-xs text-gray-600 ml-2"
    ).tooltip(f"Coût total toutes sessions : {format_cost(state.total_cost_usd)}")
```

---

### 12.2 Dashboard d'usage

**Objectif:** Un écran de statistiques accessible depuis les settings — sessions, tokens, coûts, outils les plus utilisés, évolution dans le temps.

**Nouveau fichier:** `openagenticskyzer/app/analytics.py`

```python
"""Agrégation des métriques d'usage depuis les sessions sauvegardées."""
import json
from collections import Counter
from pathlib import Path
from openagenticskyzer.app.storage import _sessions_dir


def compute_stats() -> dict:
    sessions_dir = _sessions_dir()
    tool_counts = Counter()
    total_tokens = 0
    total_cost = 0.0
    session_count = 0
    providers_used = Counter()

    for path in sessions_dir.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            session_count += 1
            total_tokens += data.get("total_tokens", 0)
            total_cost += data.get("cost_usd", 0.0)
            providers_used[data.get("provider", "unknown")] += 1
            for msg in data.get("messages", []):
                if msg.get("role") == "tool" and msg.get("tool_name"):
                    tool_counts[msg["tool_name"]] += 1
        except Exception:
            continue

    return {
        "session_count": session_count,
        "total_tokens": total_tokens,
        "total_cost_usd": total_cost,
        "top_tools": tool_counts.most_common(10),
        "providers": dict(providers_used),
    }
```

**Nouvel onglet dans `settings.py`** — "📈 Statistiques" :

```python
def _tab_analytics():
    from openagenticskyzer.app.analytics import compute_stats
    from openagenticskyzer.app.cost_tracker import format_cost

    stats = compute_stats()
    _section("Vue d'ensemble")
    with ui.grid(columns=3).classes("w-full px-4 gap-3"):
        _stat_card("Sessions", str(stats["session_count"]))
        _stat_card("Tokens total", f"{stats['total_tokens']:,}")
        _stat_card("Coût total", format_cost(stats["total_cost_usd"]))

    _section("Outils les plus utilisés")
    for tool_name, count in stats["top_tools"]:
        with ui.row().classes("px-4 items-center gap-2"):
            ui.label(tool_name).classes("text-xs text-gray-400 font-mono w-32")
            with ui.element("div").classes("flex-1 h-1.5 bg-gray-800 rounded"):
                max_count = stats["top_tools"][0][1] if stats["top_tools"] else 1
                pct = count / max_count * 100
                ui.element("div").classes("h-1.5 bg-purple-600 rounded").style(f"width:{pct:.0f}%")
            ui.label(str(count)).classes("text-xs text-gray-600")

    _section("Providers utilisés")
    for provider, count in stats["providers"].items():
        ui.label(f"{provider}: {count} sessions").classes("text-xs text-gray-500 px-4")


def _stat_card(label: str, value: str):
    with ui.card().classes("bg-gray-900 border border-gray-800 rounded-xl p-3 text-center"):
        ui.label(value).classes("text-lg text-gray-200 font-bold")
        ui.label(label).classes("text-xs text-gray-600")
```

---

### 12.3 Audit Log consultable

**Objectif:** Un historique de toutes les actions de l'agent (fichiers créés/modifiés, commandes lancées, URLs fetchées) — filtrable, searchable, horodaté.

**Nouveau fichier:** `openagenticskyzer/context/audit_log.py`

```python
"""Audit log — enregistre chaque action agent avec timestamp et contexte."""
import json
from datetime import datetime
from pathlib import Path
from openagenticskyzer.app.storage import get_data_home


def _audit_path() -> Path:
    p = get_data_home() / "audit.jsonl"
    return p


def log_action(tool_name: str, args: dict, result_summary: str, folder: str = "") -> None:
    """Enregistre une action dans l'audit log (format JSONL — 1 JSON par ligne)."""
    entry = {
        "ts": datetime.now().isoformat(),
        "tool": tool_name,
        "args": {k: str(v)[:200] for k, v in args.items()},
        "result": result_summary[:500],
        "folder": folder,
    }
    with open(_audit_path(), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read_audit_log(limit: int = 200, tool_filter: str = "", folder_filter: str = "") -> list[dict]:
    path = _audit_path()
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines()[-limit * 3:]:
        try:
            e = json.loads(line)
            if tool_filter and tool_filter not in e.get("tool", ""):
                continue
            if folder_filter and folder_filter not in e.get("folder", ""):
                continue
            entries.append(e)
        except Exception:
            continue
    return entries[-limit:]


def clear_audit_log() -> None:
    path = _audit_path()
    if path.exists():
        path.unlink()
```

**Intégration dans le tool node** (`graph/nodes.py`) — après chaque exécution d'outil :

```python
from openagenticskyzer.context.audit_log import log_action

# Dans le handler après exécution de chaque outil :
log_action(
    tool_name=tool_name,
    args=tool_args,
    result_summary=str(tool_result)[:500],
    folder=state.active_folder or "",
)
```

**Nouvel onglet dans `settings.py`** — "🔍 Audit" :

```python
def _tab_audit():
    from openagenticskyzer.context.audit_log import read_audit_log, clear_audit_log

    filter_input = ui.input(placeholder="Filtrer par outil…").classes("w-full mb-2 text-xs")
    entries = read_audit_log(limit=100)

    with ui.scroll_area().classes("w-full h-72"):
        for e in reversed(entries):
            with ui.row().classes("w-full px-4 py-1.5 border-b border-gray-900 gap-2 items-start"):
                ui.label(e["ts"][11:19]).classes("text-xs text-gray-600 font-mono w-16 flex-shrink-0")
                ui.label(e["tool"]).classes("text-xs text-purple-400 font-mono w-28 flex-shrink-0")
                ui.label(e["result"][:80]).classes("text-xs text-gray-500 flex-1 truncate")

    ui.button("🗑️ Effacer l'audit", on_click=lambda: clear_audit_log() or ui.notify("Audit effacé.")).classes(
        "text-xs text-red-400 border border-red-900 bg-transparent mt-2"
    )
```

---

## Phase 13 — API Server & Webhooks

### 13.1 Mode API Server

**Objectif:** Exposer l'agent comme une API HTTP REST locale (`POST /chat`) pour permettre à d'autres outils de l'utiliser — scripts, extensions VS Code, apps tierces, automations.

**Nouveau fichier:** `openagenticskyzer/api_server.py`

```python
"""Serveur API REST local — expose l'agent sur http://127.0.0.1:8767."""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="OpenAgentic Skyzer API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class ChatRequest(BaseModel):
    message: str
    folder: str = ""
    mode: str = "auto"
    model: str | None = None
    provider: str | None = None
    history: list[dict] = []


class ChatResponse(BaseModel):
    response: str
    tool_calls: list[dict] = []
    tokens_used: int = 0


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    from openagenticskyzer.agent import build_agent
    import os
    if req.folder:
        os.chdir(req.folder)
    agent = build_agent(mode=req.mode, provider=req.provider, model_name=req.model)
    messages = req.history + [{"role": "user", "content": req.message}]
    try:
        result = agent.invoke({"messages": messages}, {"recursion_limit": 100})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    ai_text = ""
    tool_calls_log = []
    for msg in reversed(result.get("messages", [])):
        content = getattr(msg, "content", "")
        if content and not getattr(msg, "tool_calls", None):
            ai_text = content if isinstance(content, str) else str(content)
            break
    for msg in result.get("messages", []):
        for tc in getattr(msg, "tool_calls", None) or []:
            name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
            args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {})
            if name:
                tool_calls_log.append({"tool": name, "args": args})

    return ChatResponse(response=ai_text, tool_calls=tool_calls_log)


@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


@app.get("/models")
async def list_models():
    from openagenticskyzer.utils.utils import list_ollama_models
    return {"ollama": list_ollama_models()}


def start_api_server(host: str = "127.0.0.1", port: int = 8767):
    uvicorn.run(app, host=host, port=port, log_level="warning")
```

**Activation via CLI** — nouveau flag `--api` dans `agent.py` :

```bash
openagent --api                        # Lance le serveur API sur 127.0.0.1:8767
openagent --api --api-port 9000        # Port personnalisé
```

**Toggle dans settings.py** — "Démarrer l'API server au lancement" :

```python
ui.switch(value=cfg.get("start_api_server", False)).bind_value_to(cfg, "start_api_server")
ui.label("Expose l'agent sur http://127.0.0.1:8767/chat").classes("text-xs text-gray-600")
```

**Exemple d'utilisation depuis un script Python :**

```python
import requests
resp = requests.post("http://127.0.0.1:8767/chat", json={
    "message": "Liste les fichiers Python dans ce dossier",
    "folder": "/mon/projet",
    "mode": "auto",
})
print(resp.json()["response"])
```

---

### 13.2 Webhooks entrants

**Objectif:** Déclencher l'agent depuis un événement externe — nouveau commit GitHub, alerte monitoring, message Slack, cron job — via une URL webhook exposée localement et/ou via tunnel (ngrok).

**Nouveau fichier:** `openagenticskyzer/webhooks.py`

```python
"""Webhooks entrants — déclenche l'agent depuis des événements externes."""
from fastapi import FastAPI, Request, HTTPException
from openagenticskyzer.app.storage import load_global_config
import hmac, hashlib

# Ajouté au serveur FastAPI de l'API server
def register_webhook_routes(app):

    @app.post("/webhook/{trigger_id}")
    async def webhook(trigger_id: str, request: Request):
        cfg = load_global_config()
        triggers = cfg.get("webhook_triggers", {})
        trigger = triggers.get(trigger_id)
        if not trigger:
            raise HTTPException(status_code=404, detail="Trigger not found")

        # Vérification HMAC optionnelle
        secret = trigger.get("secret")
        if secret:
            sig = request.headers.get("X-Hub-Signature-256", "")
            body = await request.body()
            expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expected):
                raise HTTPException(status_code=401, detail="Invalid signature")

        # Construit le message pour l'agent depuis le template du trigger
        payload = await request.json()
        message = trigger["message_template"].format(**_flatten(payload))

        from openagenticskyzer.agent import build_agent
        agent = build_agent(mode=trigger.get("mode", "auto"),
                            provider=trigger.get("provider"),
                            model_name=trigger.get("model"))
        result = agent.invoke({"messages": [{"role": "user", "content": message}]},
                              {"recursion_limit": 100})
        return {"status": "executed", "trigger": trigger_id}
```

**Config des triggers dans `global_config`** :

```json
{
  "webhook_triggers": {
    "github-push": {
      "message_template": "Nouveau commit sur {repository.name} par {pusher.name}: {head_commit.message}. Analyse les changements et résume-les.",
      "mode": "ask",
      "secret": "mon_secret_hmac"
    },
    "daily-summary": {
      "message_template": "Génère le rapport quotidien du projet et sauvegarde-le dans DAILY_REPORT.md",
      "mode": "auto"
    }
  }
}
```

**Nouvelle dépendance:**

```toml
[project.optional-dependencies]
api = ["fastapi>=0.115", "uvicorn>=0.30"]
all = [..., "fastapi>=0.115", "uvicorn>=0.30"]
```

---

## Dépendances entre phases

```
Phase 1  (Streaming + UX)        → Aucune dépendance, commence immédiatement
Phase 2  (Git + Upload/Vision)   → Aucune dépendance, parallèle avec Phase 1
Phase 7  (Mémoire)               → Phase 1 recommandée (LLM compact utilise astream)
Phase 3  (Artifacts + Prompts)   → Phase 1 recommandée (streaming + affichage)
Phase 8  (UX Avancée)            → Phase 1 requise (streaming avant édition/tabs)
Phase 9  (Dev Tools Pro)         → Phase 2 recommandée (git avant diff interactif)
Phase 4  (RAG + Index)           → Phase 7 synergique (mémoire + index = contexte complet)
Phase 5  (Plugins + MCP)         → Aucune dépendance
Phase 10 (Personas + Compare)    → Phase 1 requise (streaming pour comparaison)
Phase 11 (Voice Input)           → Aucune dépendance fonctionnelle
Phase 12 (Analytics)             → Phase 2 recommandée (git actions à logger)
Phase 6  (Multi-agent)           → Phase 5 recommandée (plugins pour les sous-agents)
Phase 13 (API Server)            → Phase 6 recommandée (API expose le multi-agent)
```

**Ordre recommandé:** 1 → 2 → 7 → 3 → 8 → 9 → 4 → 5 → 10 → 11 → 12 → 6 → 13

**Phases parallélisables:**
- Sprint A : 1 + 2 (fondations simultanées)
- Sprint B : 7 + 11 (mémoire + voice, indépendantes)
- Sprint C : 3 + 8 + 9 (UX enrichie)
- Sprint D : 4 + 5 + 12 (intelligence + plugins + analytics)
- Sprint E : 6 + 10 + 13 (multi-agent + personas + API)

---

## Nouvelles dépendances Python

| Phase | Package | Groupe pyproject |
|---|---|---|
| 1.3 | `plyer>=2.1` | `[app]` |
| 2.2 | `pypdf>=4.0` | `[app]` |
| 4 | `chromadb>=0.5` | `[index]` (nouveau) |
| 4 | `sentence-transformers>=2.7` | `[index]` |
| 5.2 | `mcp>=1.0` | `[mcp]` (nouveau) |
| 11 | `faster-whisper>=1.0` | `[voice]` (nouveau) |
| 11 | `sounddevice>=0.4` | `[voice]` |
| 11 | `numpy>=1.24` | `[voice]` |
| 13 | `fastapi>=0.115` | `[api]` (nouveau) |
| 13 | `uvicorn>=0.30` | `[api]` |
| 13 | `websockets>=12.0` | `[api]` (pour terminal xterm) |

**Ajouter à requirements.txt:** `plyer>=2.1`, `pypdf>=4.0`

**Groupes optionnels à créer dans pyproject.toml:**
```toml
[project.optional-dependencies]
index = ["chromadb>=0.5", "sentence-transformers>=2.7"]
voice = ["faster-whisper>=1.0", "sounddevice>=0.4", "numpy>=1.24"]
api   = ["fastapi>=0.115", "uvicorn>=0.30", "websockets>=12.0"]
mcp   = ["mcp>=1.0"]
all   = [
    # ... app existant ...
    "plyer>=2.1", "pypdf>=4.0",
    "chromadb>=0.5", "sentence-transformers>=2.7",
    "faster-whisper>=1.0", "sounddevice>=0.4", "numpy>=1.24",
    "fastapi>=0.115", "uvicorn>=0.30", "websockets>=12.0",
    "mcp>=1.0",
]
```

---

## Résumé des nouveaux fichiers

| Fichier | Phase | Description |
|---|---|---|
| `app/notifier.py` | 1.3 | Notifications OS |
| `app/file_processor.py` | 2.2 | Traitement uploads (PDF/CSV/image) |
| `app/exporter.py` | 3.3 | Export conversation MD/HTML/JSON |
| `app/cost_tracker.py` | 12.1 | Tarifs LLM + estimation coût par session |
| `app/analytics.py` | 12.2 | Agrégation métriques d'usage |
| `app/voice_input.py` | 11 | Transcription vocale via faster-whisper |
| `app/terminal_server.py` | 9.1 | WebSocket server pty pour terminal xterm |
| `app/api_server.py` | 13.1 | API REST FastAPI exposant l'agent |
| `app/webhooks.py` | 13.2 | Webhooks entrants avec vérification HMAC |
| `app/components/artifact_panel.py` | 3.1 | Preview HTML/SVG/Mermaid |
| `app/components/prompt_library.py` | 3.2 | Bibliothèque de prompts |
| `app/components/command_palette.py` | 8.2 | Command palette Ctrl+K |
| `app/components/terminal_panel.py` | 9.1 | Terminal embarqué xterm.js |
| `app/components/preview_panel.py` | 9.3 | Browser preview serveur dev |
| `tools/git_tools.py` | 2.1 | 14 outils git complets |
| `tools/index_tools.py` | 4 | semantic_search + knowledge_search |
| `tools/delegation.py` | 6.1 | delegate_task pour sous-agents |
| `tools/memory_tools.py` | 7 | save_memory, read_memory, forget_memory |
| `context/project_memory.py` | 7 | Mémoire projet + globale persistante |
| `context/audit_log.py` | 12.3 | Audit log JSONL de toutes les actions |
| `indexer/__init__.py` | 4 | Module indexation sémantique |
| `indexer/embedder.py` | 4 | Embeddings sentence-transformers local |
| `indexer/indexer.py` | 4 | ChromaDB + chunking codebase |
| `indexer/knowledge.py` | 4.2 | Base de connaissances RAG |
| `plugins/__init__.py` | 5.1 | Module plugins |
| `plugins/loader.py` | 5.1 | Chargement dynamique + hooks cycle de vie |
| `mcp_client/__init__.py` | 5.2 | Module MCP |
| `mcp_client/adapter.py` | 5.2 | Adaptateur MCP → LangChain BaseTool |
| `prompts/personas.py` | 10.1 | 6 personas pré-configurés (DevOps, Reviewer…) |
| `prompts/orchestrator.py` | 6.2 | Prompt orchestrateur multi-agent |
| `docs/plugins/PLUGIN_GUIDE.md` | 5.3 | Guide complet moddeur |
| `docs/plugins/PLUGIN_API_REFERENCE.md` | 5.3 | Référence APIs internes |
| `docs/plugins/COMMUNITY_REGISTRY.md` | 5.3 | Registre communautaire plugins |
| `docs/architecture/ARCHITECTURE.md` | 5.3 | Architecture technique pour contributeurs |

## Résumé des fichiers modifiés

| Fichier | Phases | Modifications clés |
|---|---|---|
| `app/state.py` | 1,2,4,6,7,8,9,10,11,12 | +streaming_content, +is_streaming, +attached_files, +index_status, +sub_agents, +branches, +tabs, +compare_mode, +compare_results, +preview_url, +show_terminal, +show_preview, +session_cost_usd, +current_persona_id |
| `app/main.py` | 1,3,5.3,8,9 | +highlight.js, +mermaid.js, +xterm.js CDN, +artifact_panel, +preview_panel, +terminal_panel, +command_palette dans layout |
| `app/components/chat.py` | 1,3.3,8.1,8.3,9.2 | +streaming render, +bouton export, +bouton edit/régénérer, +bouton fork, +diff accept/reject |
| `app/components/input_bar.py` | 1,2.2,3.2,8.1,11 | +astream_events, +upload button, +prompt picker, +mic button |
| `app/components/sidebar.py` | 2.1,4.2 | +git status widget, +knowledge section |
| `app/components/context_bar.py` | 7.1,12.1 | +compaction LLM réelle, +affichage coût session |
| `app/components/settings.py` | 1.3,5,7.5,10.1,12.2,12.3 | +notifs toggle, +onglets Outils/MCP/Mémoire/Analytics/Audit, +toggle API server |
| `app/components/model_modal.py` | 10.1 | +sélecteur de persona |
| `app/storage.py` | 3.2,5.2,7 | +load_prompts, +save_prompts, +load_mcp_config, +webhook_triggers |
| `agent.py` | 2.1,4,5,6,7,10,13 | +git_tools, +index_tools, +plugin_tools, +mcp_tools, +delegate_task, +memory_tools, +persona_id param, +folder_cwd param |
| `graph/nodes.py` | 12.3 | +log_action après chaque tool call |
| `permissions.py` | 2.1 | +git_commit, +git_push, +git_checkout dans _RESTRICTED_TOOLS |
| `prompts/prompt.py` | 2.1,4,6,7 | +section GIT, +semantic_search, +knowledge_search, +MEMORY TOOLS |
| `pyproject.toml` | 1,2,4,5,11,13 | +plyer, +pypdf, +chromadb, +sentence-transformers, +mcp, +faster-whisper, +sounddevice, +fastapi, +uvicorn, +websockets |
| `requirements.txt` | 1,2 | +plyer, +pypdf |

---

## Vue d'ensemble — 13 phases

| # | Phase | Features clés | Impact | Difficulté |
|---|---|---|---|---|
| 1 | **UX Professionnelle** | Streaming tokens, syntax highlight, notifs OS | 🔴 Critique | Moyenne |
| 2 | **Outils Dev Essentiels** | Git complet (14 outils), upload PDF/CSV/images, vision | 🔴 Critique | Moyenne |
| 3 | **Contenu & Productivité** | Artifacts HTML/SVG/Mermaid, prompt library, export conv. | 🟠 Important | Faible |
| 4 | **Intelligence Locale** | Embeddings ChromaDB, recherche sémantique, RAG local | 🟠 Important | Élevée |
| 5 | **Extensibilité** | Plugins `.py`, MCP, doc communautaire + 3 plugins exemple | 🟡 Valeur long terme | Moyenne |
| 6 | **Multi-Agent** | delegate_task, sous-agents parallèles, orchestrateur | 🟡 Valeur long terme | Élevée |
| 7 | **Mémoire & Contexte** | Compaction LLM réelle, memory.md projet+global, outils mémoire | 🔴 Critique | Moyenne |
| 8 | **UX Avancée** | Édition messages, régénération, Ctrl+K palette, fork, tabs | 🟠 Important | Moyenne |
| 9 | **Dev Tools Pro** | Terminal xterm.js, diff accept/reject, browser preview | 🟠 Important | Élevée |
| 10 | **Personas & Compare** | 6 personas agents, comparaison multi-modèles côte à côte | 🟡 Différenciateur | Faible |
| 11 | **Voice Input** | Whisper.cpp local, dictée hors ligne, bouton micro | 🟡 Différenciateur | Moyenne |
| 12 | **Analytics** | Coûts API en temps réel, dashboard usage, audit log | 🟡 Valeur long terme | Faible |
| 13 | **API & Webhooks** | REST API `POST /chat`, webhooks HMAC, intégration externe | 🔵 Écosystème | Moyenne |

**Total :** ~35 nouveaux fichiers Python, ~15 fichiers modifiés, 4 nouveaux groupes de dépendances optionnelles.

**Sprints recommandés (parallélisation maximale) :**
- **Sprint A** (semaine 1-2) : Phase 1 + Phase 2
- **Sprint B** (semaine 2-3) : Phase 7 + Phase 11
- **Sprint C** (semaine 3-4) : Phase 3 + Phase 8 + Phase 9
- **Sprint D** (semaine 4-6) : Phase 4 + Phase 5 + Phase 12
- **Sprint E** (semaine 6-8) : Phase 6 + Phase 10 + Phase 13

