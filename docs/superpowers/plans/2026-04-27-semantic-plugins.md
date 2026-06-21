# Indexation Sémantique & Système de Plugins — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter l'indexation sémantique du codebase (ChromaDB + sentence-transformers), la base de connaissances RAG, le système de plugins dynamiques, et le support MCP (Phases 4 + 5).

**Architecture:** Nouveau module `openagenticskyzer/indexer/` (embedder, indexer, knowledge), nouveau module `openagenticskyzer/plugins/` (loader), nouveau module `openagenticskyzer/mcp_client/` (adapter). Deux nouveaux outils LangChain (`semantic_search`, `knowledge_search`). UI dans sidebar et settings.

**Tech Stack:** Python 3.11+, chromadb>=0.5, sentence-transformers>=2.7, mcp>=1.0 (optionnel), LangChain `@tool`, pytest, unittest.mock

---

## Structure des fichiers

| Fichier | Action | Rôle |
|---------|--------|------|
| `openagenticskyzer/indexer/__init__.py` | Créer | Package vide |
| `openagenticskyzer/indexer/embedder.py` | Créer | Modèle all-MiniLM-L6-v2 |
| `openagenticskyzer/indexer/indexer.py` | Créer | Index ChromaDB + chunking |
| `openagenticskyzer/indexer/knowledge.py` | Créer | Base de connaissances RAG |
| `openagenticskyzer/tools/index_tools.py` | Créer | semantic_search + knowledge_search |
| `openagenticskyzer/plugins/__init__.py` | Créer | Package vide |
| `openagenticskyzer/plugins/loader.py` | Créer | Chargement dynamique plugins |
| `openagenticskyzer/mcp_client/__init__.py` | Créer | Package vide |
| `openagenticskyzer/mcp_client/adapter.py` | Créer | Adaptateur MCP → LangChain |
| `openagenticskyzer/app/state.py` | Modifier | Ajouter `index_status` |
| `openagenticskyzer/app/components/sidebar.py` | Modifier | Section "📚 Connaissances" |
| `openagenticskyzer/app/components/settings.py` | Modifier | Onglets "Outils" et "MCP" |
| `openagenticskyzer/agent.py` | Modifier | Intégrer plugins + MCP tools |
| `openagenticskyzer/app/main.py` | Modifier | Lancer indexation async à l'ouverture dossier |
| `tests/test_indexer.py` | Créer | Tests indexation + plugins |

---

## Task 1 : Module d'embedding

**Files:**
- Create: `openagenticskyzer/indexer/__init__.py`
- Create: `openagenticskyzer/indexer/embedder.py`
- Test: `tests/test_indexer.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_indexer.py
"""Tests indexation sémantique et base de connaissances."""
import pytest
from unittest.mock import patch, MagicMock


class TestEmbedder:
    def test_embed_returns_list_of_lists(self):
        mock_model = MagicMock()
        mock_model.encode.return_value = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
        with patch("openagenticskyzer.indexer.embedder.get_model", return_value=mock_model):
            from openagenticskyzer.indexer.embedder import embed
            result = embed(["hello", "world"])
        assert isinstance(result, list)
        assert len(result) == 2
        assert isinstance(result[0], list)

    def test_get_model_returns_singleton(self):
        from openagenticskyzer.indexer import embedder
        embedder._model = None
        with patch("openagenticskyzer.indexer.embedder.SentenceTransformer") as mock_cls:
            mock_cls.return_value = MagicMock()
            m1 = embedder.get_model()
            m2 = embedder.get_model()
        assert m1 is m2
        assert mock_cls.call_count == 1
        embedder._model = None  # cleanup
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_indexer.py::TestEmbedder -v
```
Attendu : FAIL — `ModuleNotFoundError`

- [ ] **Step 3 : Créer les fichiers**

```python
# openagenticskyzer/indexer/__init__.py
```

```python
# openagenticskyzer/indexer/embedder.py
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

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

```
pytest tests/test_indexer.py::TestEmbedder -v
```
Attendu : 2 PASS

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/indexer/ tests/test_indexer.py
rtk git commit -m "feat: add semantic embedder (all-MiniLM-L6-v2) (Phase 4.1)"
```

---

## Task 2 : Indexer ChromaDB

**Files:**
- Create: `openagenticskyzer/indexer/indexer.py`
- Test: `tests/test_indexer.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_indexer.py`, ajouter :

```python
class TestIndexer:
    def test_chunk_splits_text(self):
        from openagenticskyzer.indexer.indexer import _chunk
        text = "a" * 2000
        chunks = _chunk(text)
        assert len(chunks) > 1
        assert all(len(c) <= 900 for c in chunks)

    def test_chunk_overlap(self):
        from openagenticskyzer.indexer.indexer import _chunk
        text = "abcdefghij" * 100  # 1000 chars
        chunks = _chunk(text)
        # Overlap → les chunks se chevauchent
        assert len(chunks) >= 2

    def test_index_and_search(self, tmp_path):
        # Test complet avec un vrai fichier + mock embeddings
        (tmp_path / "test.py").write_text("def hello(): return 'world'", encoding="utf-8")

        mock_embed = lambda texts: [[float(i) for i in range(384)] for _ in texts]
        mock_col = MagicMock()
        mock_col.count.return_value = 1
        mock_col.query.return_value = {
            "documents": [["def hello(): return 'world'"]],
            "metadatas": [[{"file": "test.py", "chunk": 0}]],
            "distances": [[0.1]],
        }

        with patch("openagenticskyzer.indexer.indexer.embed", mock_embed), \
             patch("openagenticskyzer.indexer.indexer._get_db", return_value=mock_col):
            from openagenticskyzer.indexer.indexer import index_folder, search_codebase
            n = index_folder(str(tmp_path))
            assert n > 0

            results = search_codebase(str(tmp_path), "hello function")
        assert len(results) == 1
        assert results[0]["file"] == "test.py"
        assert results[0]["score"] > 0
```

- [ ] **Step 2 : Créer `indexer.py`**

```python
# openagenticskyzer/indexer/indexer.py
"""Indexation des fichiers du projet dans ChromaDB."""
import hashlib
import os
from pathlib import Path
import chromadb

_CHUNK_SIZE = 800
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

- [ ] **Step 3 : Lancer les tests**

```
pytest tests/test_indexer.py::TestIndexer -v
```
Attendu : 3 PASS

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/indexer/indexer.py tests/test_indexer.py
rtk git commit -m "feat: ChromaDB indexer with chunking + semantic search (Phase 4.1)"
```

---

## Task 3 : Base de connaissances RAG + outils

**Files:**
- Create: `openagenticskyzer/indexer/knowledge.py`
- Create: `openagenticskyzer/tools/index_tools.py`
- Modify: `openagenticskyzer/agent.py`
- Test: `tests/test_indexer.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_indexer.py`, ajouter :

```python
class TestKnowledge:
    def test_add_and_search(self):
        mock_col = MagicMock()
        mock_col.count.return_value = 1
        mock_col.query.return_value = {
            "documents": [["contenu important"]],
            "metadatas": [[{"source": "doc.txt", "chunk": 0, "tags": "python"}]],
            "distances": [[0.2]],
        }
        mock_embed = lambda texts: [[0.0] * 384 for _ in texts]

        with patch("openagenticskyzer.indexer.knowledge._get_knowledge_db", return_value=mock_col), \
             patch("openagenticskyzer.indexer.knowledge.embed", mock_embed):
            from openagenticskyzer.indexer.knowledge import add_to_knowledge, search_knowledge
            n = add_to_knowledge("doc.txt", "contenu important", ["python"])
            results = search_knowledge("contenu")
        assert results[0]["source"] == "doc.txt"

    def test_semantic_search_tool_no_folder(self, monkeypatch):
        from openagenticskyzer.app.state import state
        monkeypatch.setattr(state, "active_folder", "")
        from openagenticskyzer.tools.index_tools import semantic_search
        result = semantic_search.invoke({"query": "test"})
        assert "No active folder" in result or "dossier" in result.lower()
```

- [ ] **Step 2 : Créer `knowledge.py`**

```python
# openagenticskyzer/indexer/knowledge.py
"""Base de connaissances RAG — collection séparée du codebase index."""
import chromadb
import hashlib
from pathlib import Path


def _get_knowledge_db() -> chromadb.Collection:
    db_path = str(Path.home() / ".openagent" / "knowledge")
    client = chromadb.PersistentClient(path=db_path)
    return client.get_or_create_collection("knowledge", metadata={"hnsw:space": "cosine"})


def add_to_knowledge(source: str, text: str, tags: list[str] | None = None) -> int:
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

- [ ] **Step 3 : Créer `index_tools.py`**

```python
# openagenticskyzer/tools/index_tools.py
"""Outils de recherche sémantique pour l'agent."""
from langchain_core.tools import tool


@tool
def semantic_search(query: str, n: int = 5) -> str:
    """Search the codebase semantically. Returns the most relevant code chunks for the query.
    Use when grep_codebase doesn't find what you're looking for, or when the query is conceptual.
    Args:
        query — what you're looking for (e.g., 'authentication logic', 'database connection')
        n — number of results (default 5)"""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.indexer.indexer import search_codebase
    if not state.active_folder:
        return "No active folder. Open a folder first."
    try:
        results = search_codebase(state.active_folder, query, n)
    except Exception as e:
        return f"Index not ready: {e}. Index the project first."
    if not results:
        return "No results found. The index may not be built yet."
    lines = [f"[{r['file']}] (score: {r['score']:.2f})\n{r['content']}" for r in results]
    return "\n\n---\n\n".join(lines)


@tool
def knowledge_search(query: str, n: int = 5) -> str:
    """Search the personal knowledge base (documents, PDFs, notes added by the user).
    Use for questions about documents the user has explicitly added.
    Args:
        query — the question or topic to search for
        n — number of results (default 5)"""
    from openagenticskyzer.indexer.knowledge import search_knowledge
    try:
        results = search_knowledge(query, n)
    except Exception as e:
        return f"Erreur base de connaissances : {e}"
    if not results:
        return "La base de connaissances est vide ou aucun résultat pertinent."
    lines = [f"[Source: {r['source']}] (score: {r['score']:.2f})\n{r['content']}"
             for r in results]
    return "\n\n---\n\n".join(lines)
```

- [ ] **Step 4 : Ajouter les outils dans `agent.py`**

```python
from openagenticskyzer.tools.index_tools import semantic_search, knowledge_search

# Dans _ALL_TOOLS :
_ALL_TOOLS = [
    # ... outils existants ...
    semantic_search, knowledge_search,
]
```

- [ ] **Step 5 : Ajouter `index_status` dans `state.py`**

```python
index_status: str = ""  # ex: "Index: 23/150" ou "✓ Index prêt"
```

- [ ] **Step 6 : Lancer les tests**

```
pytest tests/test_indexer.py -v
```
Attendu : 5 PASS

- [ ] **Step 7 : Commit**

```bash
rtk git add openagenticskyzer/indexer/knowledge.py openagenticskyzer/tools/index_tools.py openagenticskyzer/agent.py openagenticskyzer/app/state.py tests/test_indexer.py
rtk git commit -m "feat: knowledge base RAG + semantic_search/knowledge_search tools (Phase 4.1-4.2)"
```

---

## Task 4 : Indexation async à l'ouverture + UI

**Files:**
- Modify: `openagenticskyzer/app/main.py`
- Modify: `openagenticskyzer/app/components/context_bar.py`
- Modify: `openagenticskyzer/app/components/sidebar.py`

- [ ] **Step 1 : Lancer indexation async dans `main.py` à l'ouverture d'un dossier**

Trouver la fonction qui gère l'ouverture d'un dossier (probablement dans `sidebar.py` ou `main.py`) et ajouter après la mise à jour de `state.active_folder` :

```python
import threading
from openagenticskyzer.app.state import state

def _index_folder_async(folder: str):
    def _run():
        try:
            from openagenticskyzer.indexer.indexer import index_folder
            def _progress(i, total, filepath):
                state.index_status = f"📊 Index: {i}/{total}"
            index_folder(folder, on_progress=_progress)
            state.index_status = "✓ Index prêt"
        except ImportError:
            state.index_status = ""  # chromadb non installé — silencieux
        except Exception:
            state.index_status = ""

    threading.Thread(target=_run, daemon=True).start()

# Appel après ouverture dossier :
_index_folder_async(folder)
```

- [ ] **Step 2 : Afficher `index_status` dans `context_bar.py`**

```python
# À la fin du rendu de la context_bar :
if state.index_status:
    ui.label(state.index_status).classes("text-xs text-gray-600 ml-2")
```

- [ ] **Step 3 : Ajouter section "📚 Connaissances" dans `sidebar.py`**

```python
def _render_knowledge_section():
    try:
        from openagenticskyzer.indexer.knowledge import list_sources, remove_source
    except ImportError:
        return  # chromadb non installé

    with ui.expansion("📚 Base de connaissances", value=False).classes("w-full"):
        with ui.column().classes("w-full gap-1 px-2"):
            sources = list_sources()
            if not sources:
                ui.label("Aucun document").classes("text-xs text-gray-600")
            for src in sources:
                with ui.row().classes("w-full items-center gap-1"):
                    ui.label(src[:40]).classes("text-xs text-gray-400 flex-1 truncate")
                    ui.button("✕", on_click=lambda s=src: _remove_knowledge(s, src)).classes(
                        "w-5 h-5 bg-transparent text-gray-600 hover:text-red-400 text-xs"
                    )
            ui.button("+ Ajouter un document", on_click=_open_knowledge_import).classes(
                "w-full text-xs text-purple-400 bg-transparent border border-purple-900 "
                "hover:border-purple-600 rounded mt-1 py-1"
            )

def _remove_knowledge(name: str, src: str):
    from openagenticskyzer.indexer.knowledge import remove_source
    n = remove_source(src)
    ui.notify(f"Supprimé {n} chunks pour '{name}'", type="positive")

def _open_knowledge_import():
    ui.notify("Glisse un fichier .txt ou .md sur l'app pour l'ajouter.", type="info")
```

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/app/main.py openagenticskyzer/app/components/context_bar.py openagenticskyzer/app/components/sidebar.py
rtk git commit -m "feat: async folder indexing + knowledge section in sidebar (Phase 4.1)"
```

---

## Task 5 : Système de plugins

**Files:**
- Create: `openagenticskyzer/plugins/__init__.py`
- Create: `openagenticskyzer/plugins/loader.py`
- Modify: `openagenticskyzer/agent.py`
- Modify: `openagenticskyzer/app/components/settings.py`
- Test: `tests/test_indexer.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_indexer.py`, ajouter :

```python
class TestPluginLoader:
    def test_load_plugin_with_get_tools(self, tmp_path):
        plugin_dir = tmp_path / "tools"
        plugin_dir.mkdir()
        plugin_file = plugin_dir / "my_plugin.py"
        plugin_file.write_text("""
from langchain_core.tools import tool

@tool
def my_custom_tool(x: str) -> str:
    \"\"\"My custom tool for testing.\"\"\"
    return f"result: {x}"

def get_tools():
    return [my_custom_tool]
""", encoding="utf-8")

        from openagenticskyzer.plugins.loader import load_plugins
        tools, errors = load_plugins(folder=str(tmp_path))
        assert len(errors) == 0
        assert any(t.name == "my_custom_tool" for t in tools)

    def test_plugin_without_get_tools_gives_error(self, tmp_path):
        plugin_dir = tmp_path / "tools"
        plugin_dir.mkdir()
        (plugin_dir / "bad_plugin.py").write_text("x = 1\n", encoding="utf-8")

        from openagenticskyzer.plugins.loader import load_plugins
        tools, errors = load_plugins(folder=str(tmp_path))
        assert any("get_tools" in e for e in errors)

    def test_broken_plugin_gives_error(self, tmp_path):
        plugin_dir = tmp_path / "tools"
        plugin_dir.mkdir()
        (plugin_dir / "broken.py").write_text("raise RuntimeError('crash')\n", encoding="utf-8")

        from openagenticskyzer.plugins.loader import load_plugins
        tools, errors = load_plugins(folder=str(tmp_path))
        assert any("broken.py" in e for e in errors)
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_indexer.py::TestPluginLoader -v
```
Attendu : FAIL

- [ ] **Step 3 : Créer le loader**

```python
# openagenticskyzer/plugins/__init__.py
```

```python
# openagenticskyzer/plugins/loader.py
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
                    # Appel hook on_load si présent
                    on_load = getattr(module, "on_load", None)
                    if callable(on_load):
                        try:
                            on_load(folder)
                        except Exception as exc:
                            errors.append(f"{py_file.name}: on_load() error: {exc}")
                else:
                    errors.append(f"{py_file.name}: pas de fonction get_tools()")
            except Exception as exc:
                errors.append(f"{py_file.name}: {exc}")

    return tools, errors
```

- [ ] **Step 4 : Intégrer dans `agent.py`**

```python
from openagenticskyzer.plugins.loader import load_plugins
import logging
logger = logging.getLogger(__name__)

def build_agent(mode: str = "auto", folder_cwd: str | None = None, ...):
    plugin_tools, plugin_errors = load_plugins(folder=folder_cwd)
    if plugin_errors:
        logger.warning("Plugin errors: %s", plugin_errors)
    all_tools = _ALL_TOOLS + plugin_tools
    # ... suite build_agent ...
```

- [ ] **Step 5 : Ajouter onglet "Outils" dans `settings.py`**

```python
def _tab_tools():
    from openagenticskyzer.plugins.loader import load_plugins
    from openagenticskyzer.app.state import state
    tools, errors = load_plugins(state.active_folder)
    _section("Plugins chargés")
    if not tools and not errors:
        ui.label("Aucun plugin — dépose un .py dans ~/.openagent/tools/").classes("text-xs text-gray-600 px-4")
    for t in tools:
        with ui.row().classes("px-4 py-1 gap-2 items-center"):
            ui.label("✓").classes("text-green-400 text-xs w-4")
            ui.label(t.name).classes("text-xs text-gray-300 font-mono flex-1")
    for err in errors:
        with ui.row().classes("px-4 py-1 gap-2 items-center"):
            ui.label("✗").classes("text-red-400 text-xs w-4")
            ui.label(err[:80]).classes("text-xs text-red-400 flex-1")
    _section("Répertoires de plugins")
    ui.label("Global : ~/.openagent/tools/").classes("text-xs text-gray-600 px-4")
    if state.active_folder:
        ui.label(f"Dossier : .openagent/tools/").classes("text-xs text-gray-600 px-4")
```

- [ ] **Step 6 : Lancer les tests**

```
pytest tests/test_indexer.py::TestPluginLoader -v
```
Attendu : 3 PASS

- [ ] **Step 7 : Commit**

```bash
rtk git add openagenticskyzer/plugins/ openagenticskyzer/agent.py openagenticskyzer/app/components/settings.py tests/test_indexer.py
rtk git commit -m "feat: dynamic plugin loader from ~/.openagent/tools/ (Phase 5.1)"
```

---

## Task 6 : Support MCP

**Files:**
- Create: `openagenticskyzer/mcp_client/__init__.py`
- Create: `openagenticskyzer/mcp_client/adapter.py`
- Modify: `openagenticskyzer/app/storage.py`
- Modify: `openagenticskyzer/agent.py`
- Modify: `openagenticskyzer/app/components/settings.py`

- [ ] **Step 1 : Créer l'adaptateur MCP**

```python
# openagenticskyzer/mcp_client/__init__.py
```

```python
# openagenticskyzer/mcp_client/adapter.py
"""Adaptateur MCP → LangChain BaseTool."""
import asyncio
from langchain_core.tools import BaseTool, StructuredTool
from typing import Any


async def load_mcp_tools(server_config: dict) -> list[BaseTool]:
    """
    server_config: {"name": str, "command": str, "args": list, "env": dict}
    Retourne la liste des tools LangChain correspondants.
    Nécessite : pip install mcp
    """
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError:
        return []

    params = StdioServerParameters(
        command=server_config["command"],
        args=server_config.get("args", []),
        env=server_config.get("env"),
    )
    tools = []
    try:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                mcp_tools = await session.list_tools()
                for t in mcp_tools.tools:
                    tool_name = t.name
                    tool_desc = t.description or f"MCP tool: {tool_name}"

                    def _make_tool(name: str, sess):
                        def _run(**kwargs: Any) -> str:
                            async def _call():
                                result = await sess.call_tool(name, kwargs)
                                return str(result.content[0].text if result.content else "")
                            return asyncio.run(_call())

                        return StructuredTool.from_function(
                            func=_run,
                            name=name,
                            description=tool_desc,
                        )

                    tools.append(_make_tool(tool_name, session))
    except Exception:
        pass
    return tools
```

- [ ] **Step 2 : Ajouter `load_mcp_config`/`save_mcp_config` dans `storage.py`**

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

- [ ] **Step 3 : Intégrer MCP dans `agent.py`**

```python
from openagenticskyzer.app.storage import load_mcp_config

def build_agent(...):
    # ... après plugin_tools ...
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

- [ ] **Step 4 : Ajouter onglet "MCP" dans `settings.py`**

```python
def _tab_mcp():
    from openagenticskyzer.app.storage import load_mcp_config, save_mcp_config
    servers = load_mcp_config()
    _section("Serveurs MCP connectés")
    if not servers:
        ui.label("Aucun serveur MCP configuré.").classes("text-xs text-gray-600 px-4")
    for i, srv in enumerate(servers):
        with ui.row().classes("px-4 py-2 gap-2 items-center"):
            ui.label(f"⬡ {srv.get('name', '?')}").classes("text-xs text-purple-400 flex-1")
            ui.label(srv.get("command", "")).classes("text-xs text-gray-600 font-mono")
            ui.button("✕", on_click=lambda idx=i: _remove_mcp_server(idx)).classes(
                "w-5 h-5 bg-transparent text-gray-600 hover:text-red-400 text-xs"
            )
    ui.button("+ Ajouter un serveur MCP", on_click=_open_mcp_dialog).classes(
        "w-full text-xs text-purple-400 bg-transparent border border-purple-900 rounded mt-1 py-1"
    )

def _remove_mcp_server(idx: int):
    from openagenticskyzer.app.storage import load_mcp_config, save_mcp_config
    servers = load_mcp_config()
    if 0 <= idx < len(servers):
        servers.pop(idx)
        save_mcp_config(servers)
        ui.notify("Serveur MCP supprimé.", type="positive")

def _open_mcp_dialog():
    with ui.dialog() as dlg, ui.card().classes("bg-gray-900 border border-gray-700 w-96 gap-3"):
        ui.label("Ajouter un serveur MCP").classes("text-sm text-gray-300 font-semibold")
        name_el = ui.input(placeholder="Nom (ex: filesystem)").classes("w-full")
        cmd_el = ui.input(placeholder="Commande (ex: npx)").classes("w-full")
        args_el = ui.input(placeholder="Args JSON (ex: [\"-y\", \"@mcp/server\"])").classes("w-full")

        def _save():
            import json as _json
            try:
                args = _json.loads(args_el.value or "[]")
            except Exception:
                args = []
            from openagenticskyzer.app.storage import load_mcp_config, save_mcp_config
            servers = load_mcp_config()
            servers.append({"name": name_el.value, "command": cmd_el.value, "args": args})
            save_mcp_config(servers)
            dlg.close()
            ui.notify(f"Serveur '{name_el.value}' ajouté.", type="positive")

        with ui.row():
            ui.button("Annuler", on_click=dlg.close).classes("text-xs text-gray-500")
            ui.button("Ajouter", on_click=_save).classes("text-xs text-purple-400 border border-purple-700 bg-transparent px-3 py-1")
    dlg.open()
```

- [ ] **Step 5 : Lancer tous les tests**

```
pytest tests/test_indexer.py -v
```
Attendu : 8 PASS

- [ ] **Step 6 : Commit**

```bash
rtk git add openagenticskyzer/mcp_client/ openagenticskyzer/app/storage.py openagenticskyzer/agent.py openagenticskyzer/app/components/settings.py
rtk git commit -m "feat: MCP server support + settings tab (Phase 5.2)"
```
