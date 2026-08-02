# tests/test_project_memory.py
"""Tests de la mémoire persistante par projet et globale."""
import re
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
        assert re.search(r"\d{4}-\d{2}-\d{2}", result)

    def test_append_to_empty_memory_has_no_leading_blank_lines(self, tmp_path):
        """Regression: appending to a fresh (empty) memory file must not leave
        stray leading blank lines from the '\\n\\n<!-- ts -->' entry separator
        — save_project_memory strips the combined content before writing."""
        append_to_project_memory(str(tmp_path), "Premier fait")
        result = load_project_memory(str(tmp_path))
        assert not result.startswith("\n")
        assert "Premier fait" in result

    def test_append_blank_facts_is_a_noop(self, tmp_path):
        """Appending whitespace-only facts must not create a junk entry
        (just a timestamp comment with nothing after it) — memory is
        replayed into every future conversation, so noise there is costly."""
        append_to_project_memory(str(tmp_path), "   ")
        result = load_project_memory(str(tmp_path))
        assert result == ""

    def test_clear_removes_file(self, tmp_path):
        save_project_memory(str(tmp_path), "Test")
        clear_project_memory(str(tmp_path))
        assert load_project_memory(str(tmp_path)) == ""

    def test_clear_on_missing_file_does_not_raise(self, tmp_path):
        clear_project_memory(str(tmp_path))
        assert load_project_memory(str(tmp_path)) == ""

    def test_save_creates_directory(self, tmp_path):
        folder = str(tmp_path / "nouveau_projet")
        save_project_memory(folder, "Contenu")
        memory_file = Path(folder) / ".openagent" / "memory.md"
        assert memory_file.exists()
        assert "Contenu" in memory_file.read_text(encoding="utf-8")


class TestGlobalMemory:

    def test_load_empty_when_no_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "openagenticskyzer.context.project_memory._global_memory_path",
            lambda: tmp_path / "memory.md"
        )
        assert load_global_memory() == ""

    def test_append_and_load_global(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "openagenticskyzer.context.project_memory._global_memory_path",
            lambda: tmp_path / "memory.md"
        )
        append_to_global_memory("Style: toujours PEP8")
        result = load_global_memory()
        assert "PEP8" in result

    def test_append_creates_parent_directory(self, tmp_path, monkeypatch):
        target = tmp_path / "nested" / "memory.md"
        monkeypatch.setattr(
            "openagenticskyzer.context.project_memory._global_memory_path",
            lambda: target
        )
        append_to_global_memory("Fait global")
        assert target.exists()
        assert "Fait global" in target.read_text(encoding="utf-8")
