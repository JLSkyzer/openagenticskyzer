"""Initialization exercises the actual scanner, writer and permission node."""
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from openagenticskyzer.tools import project_analyzer as analyzer


def test_initializes_real_project_with_utf8_lf(tmp_path):
    (tmp_path / "main.py").write_text("print('bonjour')", encoding="utf-8")
    result = analyzer.initialize_project(tmp_path)
    content = (tmp_path / "OPENAGENT.md").read_bytes()
    assert result.success
    assert "Python" in result.message
    assert "Instructions pour l'agent" in content.decode("utf-8")
    assert b"**Langages :** Python" in content
    assert b"\r\n" not in content
    assert sorted(p.name for p in tmp_path.iterdir()) == ["OPENAGENT.md", "main.py"]


def test_existing_instructions_require_explicit_overwrite(tmp_path):
    target = tmp_path / "OPENAGENT.md"
    target.write_text("instructions personnalisées", encoding="utf-8")
    result = analyzer.initialize_project(tmp_path)
    assert not result.success
    assert "existe" in result.message
    assert target.read_text(encoding="utf-8") == "instructions personnalisées"
    result = analyzer.initialize_project(tmp_path, overwrite=True)
    assert result.success
    assert target.read_text(encoding="utf-8").startswith("# OPENAGENT.md")


@pytest.mark.parametrize("kind", ["empty", "missing", "file", "invalid"])
def test_invalid_folder_reports_failure_without_creating_anything(tmp_path, kind):
    ordinary_file = tmp_path / "file.txt"
    ordinary_file.write_text("keep", encoding="utf-8")
    folder = {"empty": "", "missing": tmp_path / "missing", "file": ordinary_file,
              "invalid": "bad\x00path"}[kind]
    result = analyzer.initialize_project(folder)
    assert not result.success
    assert "dossier" in result.message.lower()
    assert [p.name for p in tmp_path.iterdir()] == ["file.txt"]


def test_failed_atomic_replace_preserves_original_and_cleans_temp(tmp_path, monkeypatch):
    target = tmp_path / "OPENAGENT.md"
    target.write_text("keep me", encoding="utf-8")

    def deny_replace(*args, **kwargs):
        raise PermissionError("locked by editor")

    monkeypatch.setattr(analyzer.os, "replace", deny_replace)
    result = analyzer.initialize_project(tmp_path, overwrite=True)
    assert not result.success
    assert "locked by editor" in result.message
    assert target.read_text(encoding="utf-8") == "keep me"
    assert [p.name for p in tmp_path.iterdir()] == ["OPENAGENT.md"]


def test_tool_wrapper_initializes_default_working_directory(tmp_path, monkeypatch):
    from openagenticskyzer.app.state import state

    monkeypatch.setattr(state, "active_folder", "")
    monkeypatch.chdir(tmp_path)
    (tmp_path / "index.ts").write_text("export {}", encoding="utf-8")
    result = analyzer.analyze_project_and_init.invoke({})
    assert "TypeScript" in result
    assert "TypeScript" in (tmp_path / "OPENAGENT.md").read_text(encoding="utf-8")


@pytest.mark.parametrize("arguments", [{}, {"folder": ""}])
def test_tool_default_uses_active_gui_folder_before_launch_directory(tmp_path, monkeypatch, arguments):
    from openagenticskyzer.app.state import state

    project = tmp_path / "active"
    project.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(state, "active_folder", str(project))
    result = analyzer.analyze_project_and_init.invoke(arguments)
    assert (project / "OPENAGENT.md").exists(), result
    assert not (tmp_path / "OPENAGENT.md").exists()


def test_creation_works_on_filesystems_without_hardlinks(tmp_path, monkeypatch):
    def unsupported_link(*args, **kwargs):
        raise OSError("hardlinks unsupported")

    monkeypatch.setattr(analyzer.os, "link", unsupported_link)
    result = analyzer.initialize_project(tmp_path)
    assert result.success, result.message
    assert (tmp_path / "OPENAGENT.md").read_text(encoding="utf-8").startswith("# OPENAGENT.md")


@pytest.mark.parametrize(("mode", "allow"), [("strict", False), ("demander", False), ("demander", True)])
def test_registered_tool_obeys_permissions_before_writing(tmp_path, mode, allow):
    from openagenticskyzer.agent import _ALL_TOOLS
    from openagenticskyzer.permissions import PermissionManager, make_permission_tool_node

    assert "analyze_project_and_init" in {t.name for t in _ALL_TOOLS}
    requests = []

    def answer(request):
        requests.append(request.tool_name)
        request.resolve(allow)

    node = make_permission_tool_node(_ALL_TOOLS, PermissionManager(mode=mode, on_request=answer))
    result = node({"messages": [AIMessage(content="", tool_calls=[{
        "name": "analyze_project_and_init", "args": {"folder": str(tmp_path)}, "id": "init1",
    }])]})
    assert (tmp_path / "OPENAGENT.md").exists() is allow
    assert requests == (["analyze_project_and_init"] if mode == "demander" else [])
    assert ("Permission refusée" in result["messages"][0].content) is (not allow)


@pytest.mark.parametrize(("exists", "claude", "expected"), [
    (False, False, "Créer"), (True, False, "Écraser"), (False, True, "prioritaire"),
])
def test_confirmation_explains_creation_overwrite_and_claude_precedence(exists, claude, expected):
    from openagenticskyzer.app.components import sidebar

    text = sidebar._project_init_confirmation(exists, claude)
    assert "OPENAGENT.md" in text
    assert expected in text
    if claude and not exists:
        assert "CLAUDE.md" in text


@pytest.mark.parametrize("existing", [False, True])
def test_sidebar_confirmation_is_required_and_captures_target(tmp_path, monkeypatch, existing):
    from openagenticskyzer.app.components import sidebar

    original = tmp_path / "original"
    original.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    target = original / "OPENAGENT.md"
    if existing:
        target.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(sidebar.state, "active_folder", str(original))
    callbacks = {}
    notifications = []
    real_button = sidebar.ui.button

    def capture_button(text, **kwargs):
        callbacks[text] = kwargs.get("on_click")
        return real_button(text, **kwargs)

    monkeypatch.setattr(sidebar.ui, "button", capture_button)
    monkeypatch.setattr(sidebar.ui, "notify", lambda message, **kw: notifications.append((message, kw)))
    with sidebar.ui.element("div") as container:
        sidebar._auto_init_project()
        assert (target.read_text(encoding="utf-8") if existing else target.exists()) == ("keep" if existing else False)
        callbacks["Annuler"]()
        assert (target.read_text(encoding="utf-8") if existing else target.exists()) == ("keep" if existing else False)
        sidebar._auto_init_project()
        monkeypatch.setattr(sidebar.state, "active_folder", str(other))
        callbacks["Confirmer"]()
        assert target.read_text(encoding="utf-8").startswith("# OPENAGENT.md")
        assert not (other / "OPENAGENT.md").exists()
        assert notifications[-1][1]["type"] == "positive"
    container.delete()


def test_sidebar_reports_invalid_folder_without_dialog_or_write(tmp_path, monkeypatch):
    from openagenticskyzer.app.components import sidebar

    notifications = []
    monkeypatch.setattr(sidebar.state, "active_folder", str(tmp_path / "missing"))
    monkeypatch.setattr(sidebar.ui, "notify", lambda message, **kw: notifications.append((message, kw)))
    sidebar._auto_init_project()
    assert not list(tmp_path.iterdir())
    assert "dossier" in notifications[-1][0].lower()
    assert notifications[-1][1]["type"] == "negative"
