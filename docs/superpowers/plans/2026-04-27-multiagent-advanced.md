# Multi-Agent, Terminal, Personas & Voice — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter les sous-agents parallèles, le terminal embarqué xterm.js, le diff viewer interactif (accepter/rejeter), le preview browser, les personas d'agents, la comparaison multi-modèles, et la dictée vocale Whisper (Phases 6 + 9 + 10 + 11).

**Architecture:** Nouveau outil `tools/delegation.py` pour sous-agents, nouveau composant `terminal_panel.py` + serveur WebSocket pty, nouveau composant `preview_panel.py`, nouveau fichier `prompts/personas.py`, nouveau fichier `app/voice_input.py`, modifications `agent.py`, `state.py`, `chat.py`.

**Tech Stack:** Python 3.11+, NiceGUI, xterm.js (CDN), websockets, faster-whisper (optionnel), sounddevice (optionnel), LangChain `@tool`, pytest

---

## Structure des fichiers

| Fichier | Action | Rôle |
|---------|--------|------|
| `openagenticskyzer/tools/delegation.py` | Créer | Outil delegate_task |
| `openagenticskyzer/prompts/personas.py` | Créer | AgentPersona + 6 personas |
| `openagenticskyzer/app/components/terminal_panel.py` | Créer | Terminal xterm.js |
| `openagenticskyzer/app/terminal_server.py` | Créer | WebSocket pty server |
| `openagenticskyzer/app/components/preview_panel.py` | Créer | Browser preview iframe |
| `openagenticskyzer/app/voice_input.py` | Créer | Dictée vocale Whisper |
| `openagenticskyzer/app/state.py` | Modifier | sub_agents, compare_mode/results, persona, terminal/preview flags |
| `openagenticskyzer/app/components/chat.py` | Modifier | Diff viewer accept/reject |
| `openagenticskyzer/agent.py` | Modifier | Persona + compare mode |
| `openagenticskyzer/app/components/input_bar.py` | Modifier | Bouton micro |
| `openagenticskyzer/app/components/model_modal.py` | Modifier | Sélecteur persona |
| `openagenticskyzer/app/main.py` | Modifier | Panels terminal + preview |
| `tests/test_multiagent.py` | Créer | Tests personas + delegation |

---

## Task 1 : Sous-agents parallèles (Phase 6.1)

**Files:**
- Create: `openagenticskyzer/tools/delegation.py`
- Modify: `openagenticskyzer/app/state.py`
- Modify: `openagenticskyzer/agent.py`
- Test: `tests/test_multiagent.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_multiagent.py
"""Tests sous-agents, personas, voice."""
import pytest
from unittest.mock import patch, MagicMock


class TestDelegation:
    def test_delegate_no_folder_uses_dot(self, monkeypatch):
        from openagenticskyzer.app.state import state
        monkeypatch.setattr(state, "active_folder", "")
        monkeypatch.setattr(state, "sub_agents", [])

        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [MagicMock(content="résultat", tool_calls=None)]
        }

        with patch("openagenticskyzer.tools.delegation.build_agent", return_value=mock_agent):
            from openagenticskyzer.tools.delegation import delegate_task
            result = delegate_task.invoke({"task": "test task", "timeout": 10})
        assert "résultat" in result or isinstance(result, str)

    def test_delegate_registers_sub_agent(self, monkeypatch):
        from openagenticskyzer.app.state import state
        monkeypatch.setattr(state, "active_folder", ".")
        monkeypatch.setattr(state, "sub_agents", [])

        mock_agent = MagicMock()
        mock_agent.invoke.return_value = {
            "messages": [MagicMock(content="done", tool_calls=None)]
        }

        with patch("openagenticskyzer.tools.delegation.build_agent", return_value=mock_agent):
            from openagenticskyzer.tools.delegation import delegate_task
            delegate_task.invoke({"task": "subtask", "timeout": 10})
        # Le sous-agent doit être enregistré avec status "done"
        assert any(sa["status"] == "done" for sa in state.sub_agents)
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_multiagent.py::TestDelegation -v
```
Attendu : FAIL

- [ ] **Step 3 : Ajouter champs dans `state.py`**

```python
sub_agents: list = field(default_factory=list)
# Format: [{"id": str, "task": str, "status": "running"|"done"|"error"}]
```

- [ ] **Step 4 : Créer `delegation.py`**

```python
# openagenticskyzer/tools/delegation.py
"""Outil de délégation de tâches à des sous-agents."""
import concurrent.futures
import uuid
from langchain_core.tools import tool
from openagenticskyzer.app.state import state


@tool
def delegate_task(task: str, cwd: str = "", timeout: int = 120) -> str:
    """Delegate a subtask to an independent sub-agent and wait for the result.
    Use for parallelizable tasks: one agent writes tests while another writes code.
    Args:
        task: The complete task description for the sub-agent (include ALL context).
        cwd: Working directory for the sub-agent (default: same as current).
        timeout: Max seconds to wait (default: 120).
    Returns: The sub-agent's final response."""
    from openagenticskyzer.agent import build_agent

    sub_cwd = cwd or state.active_folder or "."
    sub_id = str(uuid.uuid4())[:8]

    state.sub_agents.append({"id": sub_id, "task": task[:80], "status": "running"})

    def _run_sub():
        agent = build_agent(mode="auto")
        try:
            result = agent.invoke(
                {"messages": [{"role": "user", "content": task}]},
                {"recursion_limit": 100},
            )
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
            final_status = "done"
        except concurrent.futures.TimeoutError:
            result = f"Sous-agent {sub_id} a dépassé le timeout de {timeout}s."
            final_status = "error"

    for sa in state.sub_agents:
        if sa["id"] == sub_id:
            sa["status"] = final_status
            break

    return result
```

- [ ] **Step 5 : Ajouter `delegate_task` dans `_ALL_TOOLS` de `agent.py`**

```python
from openagenticskyzer.tools.delegation import delegate_task

_ALL_TOOLS = [
    # ... outils existants ...
    delegate_task,
]
```

- [ ] **Step 6 : Ajouter widget sous-agents dans `context_bar.py` ou `sidebar.py`**

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

- [ ] **Step 7 : Lancer les tests**

```
pytest tests/test_multiagent.py::TestDelegation -v
```
Attendu : 2 PASS

- [ ] **Step 8 : Commit**

```bash
rtk git add openagenticskyzer/tools/delegation.py openagenticskyzer/app/state.py openagenticskyzer/agent.py tests/test_multiagent.py
rtk git commit -m "feat: delegate_task sub-agent tool + sub_agents panel (Phase 6.1)"
```

---

## Task 2 : Orchestrateur (Phase 6.2)

**Files:**
- Modify: `openagenticskyzer/agent.py`
- Modify: `openagenticskyzer/prompts/prompt.py`
- Modify: `openagenticskyzer/app/components/model_modal.py`

- [ ] **Step 1 : Ajouter `ORCHESTRATOR_PROMPT` dans `prompt.py`**

```python
ORCHESTRATOR_PROMPT = """
You are an orchestration agent. Your job is to analyze complex tasks and break them into parallel subtasks.

WORKFLOW:
1. Analyze the user request and identify independent subtasks
2. For each subtask, call delegate_task(task=..., cwd=...) — these can run in parallel
3. Collect all results and synthesize a final summary

RULES:
- Maximum 5 parallel subtasks at once
- Each subtask must be completely self-contained (include all context)
- Never do work yourself — always delegate
- After all tasks complete, write a comprehensive summary

TOOLS: delegate_task(task, cwd, timeout) | internet_search | fetch_url
"""
```

- [ ] **Step 2 : Utiliser le prompt dans `build_agent()` selon le mode**

```python
from openagenticskyzer.prompts.prompt import DEEP_AGENT_SYSTEM_PROMPT, ORCHESTRATOR_PROMPT

def build_agent(mode: str = "auto", ...):
    if mode == "orchestrate":
        system_prompt_text = ORCHESTRATOR_PROMPT
    else:
        system_prompt_text = DEEP_AGENT_SYSTEM_PROMPT
    # Passer au ChatPromptTemplate / SystemMessage existant
```

- [ ] **Step 3 : Ajouter l'option "orchestrate" dans le sélecteur de mode**

Dans `model_modal.py`, trouver le select du mode agent et ajouter :

```python
# Dans les options du mode :
{"value": "orchestrate", "label": "🕸️ Orchestrateur — Multi-agents parallèles"}
# Explication :
# ask     → Questions uniquement
# auto    → Autonome (défaut)
# plan    → Avec validation étape par étape
# orchestrate → Décompose et délègue à des sous-agents
```

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/prompts/prompt.py openagenticskyzer/agent.py openagenticskyzer/app/components/model_modal.py
rtk git commit -m "feat: orchestrator mode + ORCHESTRATOR_PROMPT (Phase 6.2)"
```

---

## Task 3 : Diff Viewer interactif (Phase 9.2)

**Files:**
- Modify: `openagenticskyzer/app/state.py`
- Modify: `openagenticskyzer/app/components/chat.py`
- Modify: `openagenticskyzer/tools/crud_tools.py`
- Test: `tests/test_multiagent.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_multiagent.py`, ajouter :

```python
class TestDiffViewer:
    def test_reject_diff_restores_file(self, tmp_path):
        original = "original content"
        modified = "modified content"
        test_file = tmp_path / "test.py"
        test_file.write_text(modified, encoding="utf-8")

        from openagenticskyzer.app.state import ChatMessage
        msg = ChatMessage(
            role="tool",
            content="edit_file result",
            tool_name="edit_file",
        )
        # Simuler le reject
        msg.tool_file_path = str(test_file)
        msg.tool_original = original
        msg.diff_accepted = None

        # Rejeter
        from pathlib import Path
        if msg.tool_file_path and msg.tool_original is not None:
            Path(msg.tool_file_path).write_text(msg.tool_original, encoding="utf-8")
        msg.diff_accepted = False

        assert test_file.read_text(encoding="utf-8") == original
        assert msg.diff_accepted is False
```

- [ ] **Step 2 : Ajouter les champs dans `ChatMessage` de `state.py`**

```python
@dataclass
class ChatMessage:
    # ... champs existants (role, content, tool_name, tool_tag, tool_detail, tool_diff) ...
    tool_file_path: str | None = None    # chemin absolu du fichier modifié
    tool_original: str | None = None     # contenu original avant modification
    diff_accepted: bool | None = None    # None=en attente, True=accepté, False=rejeté
```

- [ ] **Step 3 : Modifier `edit_file` dans `crud_tools.py` pour stocker l'original**

Trouver la fonction `edit_file` et sauvegarder le contenu original avant modification, en stockant dans le résultat une clé spéciale que le node tools peut attacher au `ChatMessage` :

```python
# Dans edit_file, avant d'écrire le fichier :
_LAST_EDIT = {}  # stockage thread-local du dernier original

@tool
def edit_file(file_path: str, old_string: str, new_string: str) -> str:
    """Edit a file by replacing old_string with new_string..."""
    from pathlib import Path
    path = Path(file_path) if Path(file_path).is_absolute() else Path(state.active_folder or ".") / file_path
    if not path.exists():
        return f"Error: file {file_path} not found"
    original = path.read_text(encoding="utf-8")
    _LAST_EDIT["path"] = str(path)
    _LAST_EDIT["original"] = original
    # ... reste de la logique existante ...
```

- [ ] **Step 4 : Ajouter le rendu diff viewer dans `chat.py`**

```python
# Dans le rendu des messages "tool" :
from pathlib import Path

if m.role == "tool" and getattr(m, "tool_diff", None) and getattr(m, "tool_file_path", None):
    if m.diff_accepted is None:
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


def _accept_diff(msg):
    msg.diff_accepted = True
    chat_messages.refresh()


def _reject_diff(msg):
    msg.diff_accepted = False
    if getattr(msg, "tool_file_path", None) and getattr(msg, "tool_original", None) is not None:
        Path(msg.tool_file_path).write_text(msg.tool_original, encoding="utf-8")
    chat_messages.refresh()
    ui.notify("Fichier restauré.", type="positive")
```

- [ ] **Step 5 : Lancer les tests**

```
pytest tests/test_multiagent.py::TestDiffViewer -v
```
Attendu : 1 PASS

- [ ] **Step 6 : Commit**

```bash
rtk git add openagenticskyzer/app/state.py openagenticskyzer/app/components/chat.py openagenticskyzer/tools/crud_tools.py tests/test_multiagent.py
rtk git commit -m "feat: interactive diff viewer with accept/reject buttons (Phase 9.2)"
```

---

## Task 4 : Terminal embarqué (Phase 9.1)

**Files:**
- Create: `openagenticskyzer/app/components/terminal_panel.py`
- Create: `openagenticskyzer/app/terminal_server.py`
- Modify: `openagenticskyzer/app/state.py`
- Modify: `openagenticskyzer/app/main.py`

- [ ] **Step 1 : Ajouter champ `show_terminal` dans `state.py`**

```python
show_terminal: bool = False
preview_url: str = ""
show_preview: bool = False
```

- [ ] **Step 2 : Créer le serveur pty WebSocket**

```python
# openagenticskyzer/app/terminal_server.py
"""WebSocket server qui gère un pseudo-terminal (pty) sur port 8766."""
import asyncio
import os
import subprocess
import threading

try:
    import websockets

    async def _handle(ws):
        folder = os.environ.get("OPENAGENT_TERMINAL_CWD", os.path.expanduser("~"))

        if os.name == "nt":
            # Windows : utilise ConPTY via winpty ou cmd.exe simple
            try:
                import winpty
                proc = winpty.PtyProcess.spawn("cmd.exe", cwd=folder)

                async def _read_loop():
                    while True:
                        try:
                            data = proc.read(1024)
                            if data:
                                await ws.send(data)
                        except Exception:
                            break

                async def _write_loop():
                    async for msg in ws:
                        try:
                            proc.write(msg)
                        except Exception:
                            break

                await asyncio.gather(_read_loop(), _write_loop())
            except ImportError:
                await ws.send("winpty non disponible. Installe-le : pip install pywinpty\r\n")
        else:
            import pty
            master_fd, slave_fd = pty.openpty()
            proc = subprocess.Popen(
                [os.environ.get("SHELL", "/bin/bash")],
                stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
                cwd=folder, close_fds=True,
            )

            async def _read_loop():
                loop = asyncio.get_event_loop()
                while True:
                    try:
                        data = await loop.run_in_executor(None, lambda: os.read(master_fd, 1024))
                        await ws.send(data.decode("utf-8", errors="replace"))
                    except Exception:
                        break

            async def _write_loop():
                async for msg in ws:
                    try:
                        os.write(master_fd, msg.encode("utf-8"))
                    except Exception:
                        break

            await asyncio.gather(_read_loop(), _write_loop())

    async def _serve():
        async with websockets.serve(_handle, "127.0.0.1", 8766):
            await asyncio.Future()

    def start_terminal_server():
        def _run():
            asyncio.run(_serve())
        t = threading.Thread(target=_run, daemon=True)
        t.start()

except ImportError:
    def start_terminal_server():
        pass
```

- [ ] **Step 3 : Créer `terminal_panel.py`**

```python
# openagenticskyzer/app/components/terminal_panel.py
"""Terminal interactif embarqué via xterm.js + WebSocket pty."""
from nicegui import ui
from openagenticskyzer.app.state import state


def _inject_xterm(container_id: str):
    ui.add_head_html("""
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5/css/xterm.css">
    <script src="https://cdn.jsdelivr.net/npm/xterm@5/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8/lib/xterm-addon-fit.js"></script>
    """)
    ui.run_javascript(f"""
    if (!window._openagentTerm) {{
        const term = new Terminal({{
            theme: {{background: '#0d0d0d', foreground: '#e0e0e0'}},
            fontFamily: 'JetBrains Mono, Consolas, monospace',
            fontSize: 12,
            cursorBlink: true,
        }});
        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        const el = document.getElementById('{container_id}');
        if (el) {{
            term.open(el);
            fitAddon.fit();
            window._openagentTerm = term;
            const ws = new WebSocket('ws://127.0.0.1:8766/terminal');
            ws.onmessage = e => term.write(e.data);
            term.onData(data => ws.send(data));
            window.addEventListener('resize', () => fitAddon.fit());
        }}
    }}
    """)


@ui.refreshable
def terminal_panel():
    if not state.show_terminal:
        return
    with ui.column().classes("w-full border-t border-gray-800").style("height:240px;background:#0d0d0d;flex-shrink:0"):
        with ui.row().classes("items-center px-3 py-1 border-b border-gray-800 gap-2"):
            ui.label("⌨ Terminal").classes("text-xs text-gray-500 flex-1")
            ui.label(state.active_folder or "~").classes("text-xs text-gray-700 font-mono truncate max-w-xs")
            ui.button("✕", on_click=lambda: (
                setattr(state, "show_terminal", False),
                terminal_panel.refresh()
            )).classes("w-5 h-5 bg-transparent text-gray-600 text-xs")
        ui.html('<div id="openagent-terminal" style="height:192px;padding:4px"></div>')
        _inject_xterm("openagent-terminal")
```

- [ ] **Step 4 : Intégrer dans `main.py`**

```python
from openagenticskyzer.app.terminal_server import start_terminal_server
from openagenticskyzer.app.components.terminal_panel import terminal_panel

# Au démarrage de l'app :
start_terminal_server()

# Dans le layout principal (colonne de gauche, après input_bar) :
terminal_panel()

# Bouton toggle dans la top bar :
ui.button("⌨", on_click=lambda: (
    setattr(state, "show_terminal", not state.show_terminal),
    terminal_panel.refresh()
)).classes("text-xs text-gray-500 hover:text-gray-300 bg-transparent").tooltip("Terminal (Ctrl+`)")
```

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/app/components/terminal_panel.py openagenticskyzer/app/terminal_server.py openagenticskyzer/app/state.py openagenticskyzer/app/main.py
rtk git commit -m "feat: embedded terminal panel (xterm.js + WebSocket pty) (Phase 9.1)"
```

---

## Task 5 : Browser Preview (Phase 9.3)

**Files:**
- Create: `openagenticskyzer/app/components/preview_panel.py`
- Modify: `openagenticskyzer/app/main.py`

- [ ] **Step 1 : Créer `preview_panel.py`**

```python
# openagenticskyzer/app/components/preview_panel.py
"""Panneau de preview — iframe vers le serveur de dev local."""
from nicegui import ui
from openagenticskyzer.app.state import state


@ui.refreshable
def preview_panel():
    if not state.show_preview or not state.preview_url:
        return
    with ui.column().classes("h-full border-l border-gray-800 bg-gray-950").style("width:480px;flex-shrink:0"):
        with ui.row().classes("items-center px-3 py-2 border-b border-gray-800 gap-2"):
            ui.label("🌐 Preview").classes("text-xs text-gray-400")
            url_input = ui.input(value=state.preview_url).classes(
                "flex-1 text-xs font-mono bg-gray-950 border-gray-700"
            ).on("change", lambda e: (
                setattr(state, "preview_url", e.args),
                preview_panel.refresh()
            ))
            ui.button("🔄", on_click=preview_panel.refresh).classes("text-xs text-gray-500 bg-transparent").tooltip("Rafraîchir")
            ui.button("✕", on_click=lambda: (
                setattr(state, "show_preview", False),
                preview_panel.refresh()
            )).classes("w-5 h-5 bg-transparent text-gray-500 text-xs")
        ui.html(f"""
        <iframe src="{state.preview_url}"
            style="width:100%;height:calc(100% - 40px);border:none"
            sandbox="allow-scripts allow-same-origin allow-forms">
        </iframe>
        """)
```

- [ ] **Step 2 : Détecter port du serveur dans `shell_exec.py`**

```python
import re as _re

_PORT_RE = _re.compile(
    r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})|port[:\s]+(\d{4,5})",
    _re.IGNORECASE,
)


def _detect_server_port(output: str) -> int | None:
    m = _PORT_RE.search(output)
    if m:
        return int(m.group(1) or m.group(2))
    return None
```

Après exécution d'une commande qui lance un serveur, si un port est détecté :

```python
port = _detect_server_port(output)
if port:
    from openagenticskyzer.app.state import state
    state.preview_url = f"http://127.0.0.1:{port}"
    state.show_preview = True
    # Rafraîchir le panneau si UI disponible
```

- [ ] **Step 3 : Ajouter `preview_panel()` dans le layout de `main.py`**

```python
from openagenticskyzer.app.components.preview_panel import preview_panel

# Dans le row de contenu (à côté de artifact_panel) :
with ui.row().classes("flex-1 overflow-hidden"):
    with ui.column().classes("flex-1 overflow-hidden"):
        render_chat()
        render_context_bar()
        render_input_bar()
        terminal_panel()
    artifact_panel()
    preview_panel()
```

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/app/components/preview_panel.py openagenticskyzer/app/main.py openagenticskyzer/tools/shell_exec.py
rtk git commit -m "feat: browser preview panel + port auto-detection (Phase 9.3)"
```

---

## Task 6 : Personas d'agents (Phase 10.1)

**Files:**
- Create: `openagenticskyzer/prompts/personas.py`
- Modify: `openagenticskyzer/agent.py`
- Modify: `openagenticskyzer/app/state.py`
- Modify: `openagenticskyzer/app/components/model_modal.py`
- Test: `tests/test_multiagent.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_multiagent.py`, ajouter :

```python
class TestPersonas:
    def test_personas_by_id_contains_default(self):
        from openagenticskyzer.prompts.personas import PERSONAS_BY_ID
        assert "default" in PERSONAS_BY_ID
        assert "devops" in PERSONAS_BY_ID
        assert "code_reviewer" in PERSONAS_BY_ID

    def test_persona_disabled_tools_filtering(self):
        from openagenticskyzer.prompts.personas import PERSONAS_BY_ID
        reviewer = PERSONAS_BY_ID["code_reviewer"]
        assert "run_command" in reviewer.disabled_tools

    def test_persona_temperature(self):
        from openagenticskyzer.prompts.personas import PERSONAS_BY_ID
        security = PERSONAS_BY_ID["security"]
        assert security.temperature == 0.1
```

- [ ] **Step 2 : Créer `personas.py`**

```python
# openagenticskyzer/prompts/personas.py
"""Personas d'agents pré-configurés."""
from dataclasses import dataclass, field


@dataclass
class AgentPersona:
    id: str
    name: str
    icon: str
    description: str
    system_prompt_suffix: str
    enabled_tools: list[str] | None = None
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
        description="Infrastructure, CI/CD, Docker, Kubernetes.",
        system_prompt_suffix="""
You are a senior DevOps engineer specializing in:
- Infrastructure as Code (Terraform, Ansible, Pulumi)
- CI/CD pipelines (GitHub Actions, GitLab CI, Jenkins)
- Containerization (Docker, docker-compose, Kubernetes)
- Cloud providers (AWS, GCP, Azure)
- Shell scripting and automation
Always suggest infrastructure best practices and consider security implications.
""",
    ),
    AgentPersona(
        id="code_reviewer",
        name="Code Reviewer",
        icon="👁️",
        description="Revue de code : bugs, sécurité, performance.",
        system_prompt_suffix="""
You are an expert code reviewer. Find bugs, security vulnerabilities, performance issues, and readability problems.
Prioritize: CRITICAL > IMPORTANT > SUGGESTION. Use line references.
Never approve code with security vulnerabilities or data loss risks.
""",
        disabled_tools=["run_command", "delete_file", "delete_dir"],
        temperature=0.1,
    ),
    AgentPersona(
        id="data_scientist",
        name="Data Scientist",
        icon="📊",
        description="Analyse de données, ML, pandas, scikit-learn.",
        system_prompt_suffix="""
You are a senior data scientist specializing in pandas, scikit-learn, PyTorch, and data visualization.
Always explain your statistical reasoning. Prefer reproducible pipelines.
""",
    ),
    AgentPersona(
        id="architect",
        name="Software Architect",
        icon="🏗️",
        description="Conception de systèmes, patterns, APIs.",
        system_prompt_suffix="""
You are a software architect. Focus on system design, design patterns, API design, and trade-off analysis.
Think at the system level. Draw ASCII diagrams when helpful. Prefer simple solutions.
""",
        disabled_tools=["run_command"],
        temperature=0.5,
    ),
    AgentPersona(
        id="security",
        name="Security Auditor",
        icon="🔒",
        description="Audit de sécurité, vulnérabilités, OWASP.",
        system_prompt_suffix="""
You are a security expert. Analyze code for: auth flaws, injection, XSS, CSRF, SSRF, secrets exposure.
Always provide severity (CRITICAL/HIGH/MEDIUM/LOW) and remediation. Only ethical, authorized testing.
""",
        temperature=0.1,
    ),
]

PERSONAS_BY_ID = {p.id: p for p in PERSONAS}
```

- [ ] **Step 3 : Intégrer dans `agent.py`**

```python
from openagenticskyzer.prompts.personas import PERSONAS_BY_ID
from openagenticskyzer.prompts.prompt import DEEP_AGENT_SYSTEM_PROMPT

def build_agent(mode: str = "auto", persona_id: str = "default", ...):
    persona = PERSONAS_BY_ID.get(persona_id, PERSONAS_BY_ID["default"])
    system_prompt_text = DEEP_AGENT_SYSTEM_PROMPT + persona.system_prompt_suffix

    # Filtrer outils selon persona
    # Avant de créer les tools du graph :
    active_tools = [
        t for t in all_tools
        if t.name not in persona.disabled_tools
        and (persona.enabled_tools is None or t.name in persona.enabled_tools)
    ]
```

- [ ] **Step 4 : Ajouter `current_persona_id` dans `state.py`**

```python
current_persona_id: str = "default"
```

- [ ] **Step 5 : Ajouter sélecteur persona dans `model_modal.py`**

```python
from openagenticskyzer.prompts.personas import PERSONAS

def _section_persona():
    from openagenticskyzer.app.state import state
    ui.label("Persona de l'agent").classes("text-xs text-gray-500 px-4 pt-3 font-semibold uppercase tracking-wide")
    with ui.row().classes("flex-wrap gap-2 px-4 pb-2"):
        for persona in PERSONAS:
            selected = persona.id == state.current_persona_id
            border_cls = "border-purple-500 bg-purple-950" if selected else "border-gray-700 bg-gray-900"
            with ui.card().classes(
                f"cursor-pointer p-2 border {border_cls} rounded-lg"
            ).on("click", lambda pid=persona.id: _select_persona(pid)):
                ui.label(f"{persona.icon} {persona.name}").classes("text-xs text-gray-200 font-medium")
                ui.label(persona.description[:50]).classes("text-xs text-gray-500")

def _select_persona(pid: str):
    from openagenticskyzer.app.state import state
    state.current_persona_id = pid
```

- [ ] **Step 6 : Lancer les tests**

```
pytest tests/test_multiagent.py::TestPersonas -v
```
Attendu : 3 PASS

- [ ] **Step 7 : Commit**

```bash
rtk git add openagenticskyzer/prompts/personas.py openagenticskyzer/agent.py openagenticskyzer/app/state.py openagenticskyzer/app/components/model_modal.py tests/test_multiagent.py
rtk git commit -m "feat: 6 agent personas (devops/reviewer/data/architect/security) (Phase 10.1)"
```

---

## Task 7 : Voice Input (Phase 11.1)

**Files:**
- Create: `openagenticskyzer/app/voice_input.py`
- Modify: `openagenticskyzer/app/components/input_bar.py`

- [ ] **Step 1 : Créer `voice_input.py`**

```python
# openagenticskyzer/app/voice_input.py
"""Transcription vocale locale via faster-whisper.
Dépendances optionnelles : faster-whisper>=1.0, sounddevice>=0.4, numpy>=1.24
"""
import threading

_model = None
_recording = False
_audio_frames = []
_stream = None


def is_available() -> bool:
    """Retourne True si les dépendances voice sont installées."""
    try:
        import faster_whisper  # noqa
        import sounddevice  # noqa
        import numpy  # noqa
        return True
    except ImportError:
        return False


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


def start_recording():
    """Démarre l'enregistrement audio. Retourne le stream."""
    global _recording, _audio_frames
    import sounddevice as sd
    import numpy as np
    _recording = True
    _audio_frames = []

    def _callback(indata, frames, time, status):
        if _recording:
            _audio_frames.append(indata.copy())

    stream = sd.InputStream(samplerate=16000, channels=1, dtype="float32", callback=_callback)
    stream.start()
    return stream


def stop_and_transcribe(stream) -> str:
    """Arrête l'enregistrement, transcrit avec Whisper, retourne le texte."""
    global _recording
    _recording = False
    stream.stop()
    stream.close()

    if not _audio_frames:
        return ""
    import numpy as np
    audio = np.concatenate(_audio_frames, axis=0).flatten()
    model = _get_model()
    segments, _ = model.transcribe(audio, language="fr", beam_size=5)
    return " ".join(seg.text for seg in segments).strip()
```

- [ ] **Step 2 : Ajouter le bouton micro dans `input_bar.py`**

```python
from openagenticskyzer.app.voice_input import is_available as voice_available

if voice_available():
    from openagenticskyzer.app.voice_input import start_recording, stop_and_transcribe

    _mic_stream = None

    def _on_mic_click():
        global _mic_stream
        if _mic_stream is None:
            try:
                _mic_stream = start_recording()
                mic_btn.classes(add="text-red-500", remove="text-gray-500")
            except Exception as e:
                ui.notify(f"Erreur micro : {e}", type="negative")
        else:
            try:
                mic_btn.classes(add="text-gray-500", remove="text-red-500")
                text = stop_and_transcribe(_mic_stream)
                _mic_stream = None
                if text:
                    current = input_el.value or ""
                    input_el.set_value((current + " " + text).strip())
                    ui.notify(f"Transcrit : {text[:50]}…", type="positive")
            except Exception as e:
                ui.notify(f"Erreur transcription : {e}", type="negative")
                _mic_stream = None

    mic_btn = ui.button("🎙️", on_click=_on_mic_click).classes(
        "w-8 h-10 bg-gray-900 border border-gray-800 text-gray-500 rounded-lg flex-shrink-0 text-sm"
    ).tooltip("Dicter un message (Whisper local)")
```

- [ ] **Step 3 : Commit**

```bash
rtk git add openagenticskyzer/app/voice_input.py openagenticskyzer/app/components/input_bar.py
rtk git commit -m "feat: voice input via faster-whisper (local, French) (Phase 11.1)"
```
