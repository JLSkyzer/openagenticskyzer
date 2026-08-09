# Mémoire Persistante + Apprentissage Adaptatif — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'IA retient les faits importants entre sessions (mémoire projet + globale) et apprend de ses erreurs et des corrections utilisateur (Phase 7 + Phase 15). La compaction de contexte génère un résumé LLM au lieu de supprimer brutalement.

**Architecture:** `context/project_memory.py` gère `.openagent/memory.md` par projet et `~/.openagent/memory.md` global. `tools/memory_tools.py` expose 3 outils à l'agent. `context/learnings.py` stocke les événements d'apprentissage en JSONL. La compaction dans `context_bar.py` fait un appel LLM pour résumer.

**Tech Stack:** Python 3.11+, LangChain `@tool`, pathlib, json, pytest

---

## Structure des fichiers

| Fichier | Action | Rôle |
|---------|--------|------|
| `openagenticskyzer/context/project_memory.py` | Créer | Lecture/écriture `.openagent/memory.md` |
| `openagenticskyzer/tools/memory_tools.py` | Créer | Outils `save_memory`, `read_memory`, `forget_memory` |
| `openagenticskyzer/context/learnings.py` | Créer | Modèle de données + JSONL pour apprentissage adaptatif |
| `openagenticskyzer/agent.py` | Modifier | Ajouter memory tools à `_ALL_TOOLS` |
| `openagenticskyzer/prompts/prompt.py` | Modifier | Ajouter section MEMORY TOOLS |
| `openagenticskyzer/app/components/context_bar.py` | Modifier | Compaction LLM réelle |
| `openagenticskyzer/app/components/input_bar.py` | Modifier | Injecter mémoire projet + learnings en début de session |
| `tests/test_project_memory.py` | Créer | Tests mémoire persistante |
| `tests/test_learnings.py` | Créer | Tests apprentissage adaptatif |

---

## Task 1 : Mémoire projet persistante (`context/project_memory.py`)

**Files:**
- Create: `openagenticskyzer/context/project_memory.py`
- Test: `tests/test_project_memory.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_project_memory.py
import pytest
from pathlib import Path
from openagenticskyzer.context.project_memory import (
    load_project_memory, save_project_memory, append_to_project_memory,
    clear_project_memory, load_global_memory, append_to_global_memory,
)


class TestProjectMemory:

    def test_load_empty_when_no_file(self, tmp_path):
        result = load_project_memory(str(tmp_path))
        assert result == ""

    def test_save_and_load(self, tmp_path):
        save_project_memory(str(tmp_path), "Architecture: microservices")
        result = load_project_memory(str(tmp_path))
        assert "microservices" in result

    def test_append_adds_to_existing(self, tmp_path):
        save_project_memory(str(tmp_path), "Fact 1")
        append_to_project_memory(str(tmp_path), "Fact 2")
        result = load_project_memory(str(tmp_path))
        assert "Fact 1" in result
        assert "Fact 2" in result

    def test_append_includes_timestamp(self, tmp_path):
        append_to_project_memory(str(tmp_path), "Nouveau fait")
        result = load_project_memory(str(tmp_path))
        import re
        assert re.search(r"\d{4}-\d{2}-\d{2}", result)

    def test_clear_removes_file(self, tmp_path):
        save_project_memory(str(tmp_path), "Test")
        clear_project_memory(str(tmp_path))
        assert load_project_memory(str(tmp_path)) == ""

    def test_save_creates_directory(self, tmp_path):
        folder = str(tmp_path / "nouveau_projet")
        save_project_memory(folder, "Contenu")
        assert Path(folder) / ".openagent" / "memory.md"


class TestGlobalMemory:

    def test_append_and_load_global(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "openagenticskyzer.context.project_memory._global_memory_path",
            lambda: tmp_path / "memory.md"
        )
        append_to_global_memory("Style: toujours PEP8")
        result = load_global_memory()
        assert "PEP8" in result
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_project_memory.py -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Créer `context/project_memory.py`**

```python
# openagenticskyzer/context/project_memory.py
"""Mémoire persistante par projet et globale."""
from datetime import datetime
from pathlib import Path


def _memory_path(folder: str) -> Path:
    return Path(folder) / ".openagent" / "memory.md"


def _global_memory_path() -> Path:
    return Path.home() / ".openagent" / "memory.md"


def load_project_memory(folder: str) -> str:
    path = _memory_path(folder)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def save_project_memory(folder: str, content: str) -> None:
    path = _memory_path(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.strip(), encoding="utf-8")


def append_to_project_memory(folder: str, new_facts: str) -> None:
    existing = load_project_memory(folder)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"\n\n<!-- {ts} -->\n{new_facts.strip()}"
    save_project_memory(folder, existing + entry)


def clear_project_memory(folder: str) -> None:
    path = _memory_path(folder)
    if path.exists():
        path.unlink()


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

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

```
pytest tests/test_project_memory.py -v
```
Attendu : tous PASS

- [ ] **Step 5 : Commit**

```bash
git add openagenticskyzer/context/project_memory.py tests/test_project_memory.py
git commit -m "feat: add persistent project and global memory (Phase 7.2/7.3)"
```

---

## Task 2 : Outils mémoire pour l'agent (`tools/memory_tools.py`)

**Files:**
- Create: `openagenticskyzer/tools/memory_tools.py`
- Modify: `openagenticskyzer/agent.py`
- Modify: `openagenticskyzer/prompts/prompt.py`

- [ ] **Step 1 : Créer `tools/memory_tools.py`**

```python
# openagenticskyzer/tools/memory_tools.py
"""Outils de mémoire persistante pour l'agent."""
from langchain_core.tools import tool


@tool
def save_memory(facts: str, scope: str = "project") -> str:
    """Save important facts, decisions, or preferences to persistent memory.
    scope='project' saves to current project, scope='global' saves for all projects.
    Use when user says 'remember that...', 'note that...', or after solving complex problems.
    Args: facts — text to save. scope — 'project' (default) or 'global'."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import (
        append_to_project_memory, append_to_global_memory,
    )
    if scope == "global":
        append_to_global_memory(facts)
        return "✓ Mémorisé dans la mémoire globale (~/.openagent/memory.md)"
    if not state.active_folder:
        return "Aucun dossier actif — impossible de sauvegarder la mémoire projet."
    append_to_project_memory(state.active_folder, facts)
    return f"✓ Mémorisé dans {state.active_folder}/.openagent/memory.md"


@tool
def read_memory() -> str:
    """Read the project's persistent memory (facts saved across sessions).
    Use when asked 'what do you know about this project?'."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import load_project_memory, load_global_memory
    parts = []
    global_mem = load_global_memory()
    if global_mem:
        parts.append(f"[Mémoire globale]\n{global_mem}")
    if state.active_folder:
        project_mem = load_project_memory(state.active_folder)
        if project_mem:
            parts.append(f"[Mémoire projet]\n{project_mem}")
    return "\n\n".join(parts) if parts else "La mémoire est vide."


@tool
def forget_memory(keyword: str) -> str:
    """Remove lines containing a keyword from project memory.
    Use when user says 'forget that...', 'remove from memory...'
    Args: keyword — word or phrase to search and remove."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import (
        load_project_memory, save_project_memory,
    )
    if not state.active_folder:
        return "Aucun dossier actif."
    mem = load_project_memory(state.active_folder)
    lines = [l for l in mem.splitlines() if keyword.lower() not in l.lower()]
    save_project_memory(state.active_folder, "\n".join(lines))
    return f"✓ Entrées contenant '{keyword}' supprimées."
```

- [ ] **Step 2 : Intégrer dans `agent.py`**

```python
from openagenticskyzer.tools.memory_tools import save_memory, read_memory, forget_memory

_ALL_TOOLS = [
    # ... outils existants ...
    save_memory, read_memory, forget_memory,
]
```

- [ ] **Step 3 : Mettre à jour le prompt dans `prompt.py`**

Dans `DEEP_AGENT_SYSTEM_PROMPT`, ajouter dans la section TOOLS :

```
MEMORY: save_memory(facts,[scope='project'|'global']) | read_memory() | forget_memory(keyword)
WHEN: "souviens-toi que..." → save_memory() | "qu'est-ce que tu sais ?" → read_memory()
      après résolution de problème complexe → save_memory() avec la solution
      après décision d'architecture → save_memory() avec la décision
```

- [ ] **Step 4 : Commit**

```bash
git add openagenticskyzer/tools/memory_tools.py openagenticskyzer/agent.py openagenticskyzer/prompts/prompt.py
git commit -m "feat: add save/read/forget memory tools to agent (Phase 7.2)"
```

---

## Task 3 : Injection mémoire en début de conversation (`input_bar.py`)

**Files:**
- Modify: `openagenticskyzer/app/components/input_bar.py`

- [ ] **Step 1 : Modifier `_send_message` dans `input_bar.py`**

Trouver la construction de `history` dans `_send_message` et injecter la mémoire :

```python
from openagenticskyzer.context.project_memory import load_project_memory, load_global_memory

# Avant de construire history :
memory_parts = []
global_mem = load_global_memory()
if global_mem:
    memory_parts.append(f"MÉMOIRE GLOBALE (préférences utilisateur) :\n{global_mem}")
if state.active_folder:
    project_mem = load_project_memory(state.active_folder)
    if project_mem:
        memory_parts.append(f"MÉMOIRE PROJET (contexte persistant) :\n{project_mem}")

if memory_parts:
    memory_injection = "\n\n".join(memory_parts)
    history = [{"role": "system", "content": memory_injection}] + history
```

- [ ] **Step 2 : Commit**

```bash
git add openagenticskyzer/app/components/input_bar.py
git commit -m "feat: inject project and global memory into each conversation (Phase 7.2)"
```

---

## Task 4 : Compaction LLM réelle (`context_bar.py`)

**Files:**
- Modify: `openagenticskyzer/app/components/context_bar.py`

- [ ] **Step 1 : Lire `context_bar.py` pour localiser `trigger_compact`**

```
Read openagenticskyzer/app/components/context_bar.py
```
Repérer la fonction `trigger_compact()` qui fait `state.messages = state.messages[-4:]`.

- [ ] **Step 2 : Remplacer `trigger_compact` par la version LLM**

```python
async def trigger_compact():
    """Summarise the conversation via LLM instead of brute-cut."""
    from nicegui import run, ui
    from openagenticskyzer.app.components.chat import chat_messages
    from openagenticskyzer.app.state import ChatMessage, state
    from openagenticskyzer.context.project_memory import append_to_project_memory

    if len(state.messages) < 6:
        ui.notify("Pas assez de messages à compresser.", type="warning")
        return

    history_text = "\n\n".join(
        f"[{m.role.upper()}]: {m.content[:800]}"
        for m in state.messages[:-2]
        if m.role in ("user", "ai")
    )
    summary_prompt = (
        "Résume cette conversation de manière dense et structurée.\n"
        "Conserve : décisions prises, fichiers modifiés, problèmes résolus, contexte technique.\n"
        "Omets : salutations, répétitions, tentatives ratées.\n"
        "Format : liste à puces, max 400 mots.\n\n"
        f"CONVERSATION :\n{history_text}\n\nRÉSUMÉ :"
    )

    ui.notify("Compression en cours…", type="info")
    try:
        from openagenticskyzer.agent import build_agent
        agent = build_agent(mode="ask",
                            provider=state.current_provider,
                            model_name=state.current_model)
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
            summary_msg = ChatMessage(
                role="ai",
                content=f"**[Résumé de contexte compressé]**\n\n{summary}",
            )
            state.messages = [summary_msg] + state.messages[-2:]
            state.context_pct = 15.0
            state.context_tokens = len(summary) // 4
            if state.active_folder:
                append_to_project_memory(state.active_folder, summary)
            chat_messages.refresh()
            context_bar.refresh()
            ui.notify("Contexte compressé avec résumé IA.", type="positive")
    except Exception as exc:
        state.messages = state.messages[-6:]
        state.context_pct = max(0.0, state.context_pct - 50.0)
        ui.notify(f"Compaction rapide (LLM indisponible : {exc})", type="warning")
        chat_messages.refresh()
        context_bar.refresh()
```

- [ ] **Step 3 : Commit**

```bash
git add openagenticskyzer/app/components/context_bar.py
git commit -m "feat: replace brute-cut compaction with LLM summarization (Phase 7.1)"
```

---

## Task 5 : Apprentissage adaptatif — modèle de données (`context/learnings.py`)

**Files:**
- Create: `openagenticskyzer/context/learnings.py`
- Test: `tests/test_learnings.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_learnings.py
import pytest
from pathlib import Path
from unittest.mock import patch
from openagenticskyzer.context.learnings import (
    Learning, new_learning, save_learning, load_learnings, delete_learning,
    format_learnings_for_injection,
)


@pytest.fixture
def learnings_dir(tmp_path):
    return tmp_path


class TestNewLearning:
    def test_creates_learning_with_required_fields(self):
        l = new_learning("error", "contexte test", "bad approach", "good approach",
                         tags=["python"], project_folder="/tmp/proj")
        assert l.type == "error"
        assert l.mistake == "bad approach"
        assert l.correction == "good approach"
        assert "python" in l.tags
        assert l.id != ""
        assert not l.confirmed

    def test_truncates_long_fields(self):
        l = new_learning("correction", "ctx", "x" * 600, "y" * 600)
        assert len(l.mistake) <= 500
        assert len(l.correction) <= 500


class TestSaveAndLoad:
    def test_save_and_load_roundtrip(self, tmp_path):
        l = new_learning("error", "test ctx", "bad", "good")
        l.confirmed = True
        save_learning(l, project_folder=str(tmp_path))
        loaded = load_learnings(project_folder=str(tmp_path), confirmed_only=True)
        assert len(loaded) == 1
        assert loaded[0].mistake == "bad"

    def test_load_confirmed_only_filters(self, tmp_path):
        l1 = new_learning("error", "ctx", "bad1", "good1")
        l1.confirmed = False
        l2 = new_learning("correction", "ctx", "bad2", "good2")
        l2.confirmed = True
        save_learning(l1, project_folder=str(tmp_path))
        save_learning(l2, project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=True)
        assert len(result) == 1
        assert result[0].correction == "good2"

    def test_delete_learning(self, tmp_path):
        l = new_learning("error", "ctx", "bad", "good")
        l.confirmed = True
        save_learning(l, project_folder=str(tmp_path))
        delete_learning(l.id, project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path))
        assert len(result) == 0


class TestFormatForInjection:
    def test_empty_returns_empty_string(self):
        assert format_learnings_for_injection([]) == ""

    def test_formats_learnings(self):
        l = new_learning("error", "ctx", "bad approach", "good approach", tags=["git"])
        l.confirmed = True
        result = format_learnings_for_injection([l])
        assert "bad approach" in result
        assert "good approach" in result
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_learnings.py -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Créer `context/learnings.py`**

```python
# openagenticskyzer/context/learnings.py
"""Apprentissage adaptatif — stockage et injection des learnings."""
import json
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

GLOBAL_LEARNINGS_PATH = Path.home() / ".openagent" / "learnings.jsonl"

LEARNING_TYPES = {
    "error":       "Erreur d'outil ou d'exécution récupérée",
    "correction":  "Correction fournie par l'utilisateur",
    "discovery":   "Bonne pratique découverte",
    "preference":  "Préférence de style ou comportement",
}


@dataclass
class Learning:
    id: str
    type: str
    context_summary: str
    mistake: str
    correction: str
    tags: list
    project_hash: str | None
    timestamp: str
    confirmed: bool
    contributed: bool
    source: str


def _learnings_path(project_folder: str | None) -> Path:
    if project_folder:
        return Path(project_folder) / ".openagent" / "learnings.jsonl"
    return GLOBAL_LEARNINGS_PATH


def new_learning(type_: str, context_summary: str, mistake: str, correction: str,
                 tags: list | None = None, project_folder: str | None = None,
                 source: str = "auto") -> Learning:
    import hashlib
    ph = hashlib.sha1(project_folder.encode()).hexdigest()[:8] if project_folder else None
    return Learning(
        id=str(uuid.uuid4())[:8],
        type=type_,
        context_summary=context_summary[:200],
        mistake=mistake[:500],
        correction=correction[:500],
        tags=tags or [],
        project_hash=ph,
        timestamp=datetime.now(timezone.utc).isoformat(),
        confirmed=False,
        contributed=False,
        source=source,
    )


def save_learning(learning: Learning, project_folder: str | None = None) -> None:
    path = _learnings_path(project_folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(asdict(learning), ensure_ascii=False) + "\n")


def load_learnings(project_folder: str | None = None,
                   confirmed_only: bool = True) -> list[Learning]:
    paths = []
    if project_folder:
        paths.append(_learnings_path(project_folder))
    paths.append(GLOBAL_LEARNINGS_PATH)
    result: list[Learning] = []
    seen_ids: set[str] = set()
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                d = json.loads(line)
                l = Learning(**d)
                if l.id in seen_ids:
                    continue
                seen_ids.add(l.id)
                if not confirmed_only or l.confirmed:
                    result.append(l)
            except Exception:
                continue
    return result


def delete_learning(learning_id: str, project_folder: str | None = None) -> None:
    for path in [_learnings_path(project_folder), GLOBAL_LEARNINGS_PATH]:
        if not path or not path.exists():
            continue
        lines = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                if json.loads(line).get("id") != learning_id:
                    lines.append(line)
            except Exception:
                lines.append(line)
        path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def format_learnings_for_injection(learnings: list[Learning]) -> str:
    """Formate les learnings pour injection dans le system prompt."""
    if not learnings:
        return ""
    lines = ["[LEÇONS APPRISES — à appliquer systématiquement]"]
    for l in learnings[:20]:  # max 20 pour ne pas saturer le contexte
        tag_str = f" [{', '.join(l.tags)}]" if l.tags else ""
        lines.append(f"• À éviter : {l.mistake}{tag_str}")
        lines.append(f"  Faire plutôt : {l.correction}")
    lines.append("[FIN LEÇONS]")
    return "\n".join(lines)
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

```
pytest tests/test_learnings.py -v
```
Attendu : tous PASS

- [ ] **Step 5 : Injecter les learnings dans `input_bar.py`**

Dans `_send_message`, après l'injection de la mémoire (Task 3), ajouter :

```python
from openagenticskyzer.context.learnings import load_learnings, format_learnings_for_injection

learnings = load_learnings(
    project_folder=state.active_folder,
    confirmed_only=True,
)
learnings_text = format_learnings_for_injection(learnings)
if learnings_text:
    history = [{"role": "system", "content": learnings_text}] + history
```

- [ ] **Step 6 : Commit**

```bash
git add openagenticskyzer/context/learnings.py tests/test_learnings.py openagenticskyzer/app/components/input_bar.py
git commit -m "feat: add adaptive learning system with JSONL storage and injection (Phase 15)"
```
