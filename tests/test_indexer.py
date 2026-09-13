"""Tests de l'indexation sémantique, des plugins et du support MCP."""

from unittest.mock import MagicMock, patch


def test_embed_returns_plain_list_of_lists():
    mock_model = MagicMock()
    mock_model.encode.return_value = [[0.1, 0.2], [0.3, 0.4]]
    with patch("openagenticskyzer.indexer.embedder.get_model", return_value=mock_model):
        from openagenticskyzer.indexer.embedder import embed

        result = embed(["hello", "world"])

    assert result == [[0.1, 0.2], [0.3, 0.4]]
    mock_model.encode.assert_called_once_with(["hello", "world"], batch_size=32, show_progress_bar=False)


def test_get_model_is_singleton():
    from openagenticskyzer.indexer import embedder

    embedder._model = None
    with patch("openagenticskyzer.indexer.embedder.SentenceTransformer") as constructor:
        constructor.return_value = MagicMock()
        first = embedder.get_model()
        second = embedder.get_model()

    assert first is second
    assert constructor.call_count == 1
    embedder._model = None


def test_chunk_splits_with_bounded_overlap():
    from openagenticskyzer.indexer.indexer import _chunk

    chunks = _chunk("a" * 2000)
    assert len(chunks) > 1
    assert all(len(chunk) <= 800 for chunk in chunks)


def test_index_and_search_returns_relative_file_result(tmp_path):
    (tmp_path / "test.py").write_text("def hello(): return 'world'", encoding="utf-8")
    collection = MagicMock()
    collection.count.return_value = 1
    collection.query.return_value = {
        "documents": [["def hello(): return 'world'"]],
        "metadatas": [[{"file": "test.py", "chunk": 0}]],
        "distances": [[0.1]],
    }
    with patch("openagenticskyzer.indexer.indexer.embed", lambda texts: [[0.0] * 384 for _ in texts]), patch(
        "openagenticskyzer.indexer.indexer._get_db", return_value=collection
    ):
        from openagenticskyzer.indexer.indexer import index_folder, search_codebase

        assert index_folder(str(tmp_path)) == 1
        results = search_codebase(str(tmp_path), "hello")

    assert results == [{"file": "test.py", "content": "def hello(): return 'world'", "score": 0.9}]


def test_knowledge_add_and_search():
    collection = MagicMock()
    collection.count.return_value = 1
    collection.query.return_value = {
        "documents": [["contenu important"]],
        "metadatas": [[{"source": "doc.txt", "chunk": 0, "tags": "python"}]],
        "distances": [[0.2]],
    }
    with patch("openagenticskyzer.indexer.knowledge._get_knowledge_db", return_value=collection), patch(
        "openagenticskyzer.indexer.knowledge.embed", lambda texts: [[0.0] * 384 for _ in texts]
    ):
        from openagenticskyzer.indexer.knowledge import add_to_knowledge, search_knowledge

        assert add_to_knowledge("doc.txt", "contenu important", ["python"]) == 1
        results = search_knowledge("contenu")

    assert results[0]["source"] == "doc.txt"


def test_semantic_search_reports_missing_active_folder(monkeypatch):
    from openagenticskyzer.app.state import state
    from openagenticskyzer.tools.index_tools import semantic_search

    monkeypatch.setattr(state, "active_folder", "")
    result = semantic_search.invoke({"query": "test"})
    assert "No active folder" in result


def test_plugin_loader_loads_tools_from_project_directory(tmp_path):
    plugin_dir = tmp_path / "tools"
    plugin_dir.mkdir()
    (plugin_dir / "my_plugin.py").write_text(
        "from langchain_core.tools import tool\n"
        "@tool\n"
        "def my_custom_tool(x: str) -> str:\n"
        "    \"\"\"Custom test tool.\"\"\"\n"
        "    return f'result: {x}'\n"
        "def get_tools():\n"
        "    return [my_custom_tool]\n",
        encoding="utf-8",
    )
    from openagenticskyzer.plugins.loader import load_plugins

    tools, errors = load_plugins(folder=str(tmp_path))
    assert errors == []
    assert [tool.name for tool in tools] == ["my_custom_tool"]


def test_plugin_without_get_tools_is_reported(tmp_path):
    plugin_dir = tmp_path / "tools"
    plugin_dir.mkdir()
    (plugin_dir / "bad.py").write_text("x = 1\n", encoding="utf-8")
    from openagenticskyzer.plugins.loader import load_plugins

    _, errors = load_plugins(folder=str(tmp_path))
    assert any("get_tools" in error for error in errors)


def test_broken_plugin_isolated_as_error(tmp_path):
    plugin_dir = tmp_path / "tools"
    plugin_dir.mkdir()
    (plugin_dir / "broken.py").write_text("raise RuntimeError('crash')\n", encoding="utf-8")
    from openagenticskyzer.plugins.loader import load_plugins

    _, errors = load_plugins(folder=str(tmp_path))
    assert any("broken.py" in error for error in errors)

def test_mcp_config_round_trip_and_invalid_entries_are_ignored(tmp_path, monkeypatch):
    from openagenticskyzer.app import storage
    monkeypatch.setenv("OPENAGENT_HOME", str(tmp_path / "home"))
    storage.save_mcp_config([{"command": "demo", "args": ["--stdio"]}, {"args": []}, "bad"])
    assert storage.load_mcp_config() == [{"command": "demo", "args": ["--stdio"]}]
