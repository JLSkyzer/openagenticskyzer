"""Tests du chargement des instructions projet via OPENAGENT.md / CLAUDE.md."""
from pathlib import Path
import pytest
from openagenticskyzer.context.project_instructions import load_project_instructions


class TestLoadProjectInstructions:

    def test_returns_empty_string_when_no_file(self, tmp_path):
        result = load_project_instructions(str(tmp_path))
        assert result == ""

    def test_reads_openagent_md(self, tmp_path):
        (tmp_path / "OPENAGENT.md").write_text("# Instructions\nNe pas utiliser print().", encoding="utf-8")
        result = load_project_instructions(str(tmp_path))
        assert "Ne pas utiliser print()" in result

    def test_reads_claude_md_as_fallback(self, tmp_path):
        (tmp_path / "CLAUDE.md").write_text("# Fallback\nToujours écrire des tests.", encoding="utf-8")
        result = load_project_instructions(str(tmp_path))
        assert "Toujours écrire des tests" in result

    def test_openagent_md_takes_priority_over_claude_md(self, tmp_path):
        (tmp_path / "OPENAGENT.md").write_text("Instructions OPENAGENT.", encoding="utf-8")
        (tmp_path / "CLAUDE.md").write_text("Instructions CLAUDE uniquement.", encoding="utf-8")
        result = load_project_instructions(str(tmp_path))
        assert "Instructions OPENAGENT." in result
        assert "Instructions CLAUDE uniquement." not in result

    def test_returns_empty_string_for_empty_file(self, tmp_path):
        (tmp_path / "OPENAGENT.md").write_text("", encoding="utf-8")
        result = load_project_instructions(str(tmp_path))
        assert result == ""

    def test_returns_empty_string_when_cwd_is_none(self):
        result = load_project_instructions(None)
        assert result == ""

    def test_returns_empty_string_when_cwd_does_not_exist(self):
        result = load_project_instructions("/chemin/qui/nexiste/pas/12345")
        assert result == ""

    def test_wraps_content_with_header(self, tmp_path):
        (tmp_path / "OPENAGENT.md").write_text("Instruction test.", encoding="utf-8")
        result = load_project_instructions(str(tmp_path))
        assert "[INSTRUCTIONS PROJET — OPENAGENT.md]" in result
        assert "[FIN INSTRUCTIONS PROJET]" in result
        assert "Instruction test." in result

    def test_large_file_is_truncated(self, tmp_path):
        """Fichier > 8000 chars est tronqué pour ne pas saturer le contexte."""
        (tmp_path / "OPENAGENT.md").write_text("x" * 10000, encoding="utf-8")
        result = load_project_instructions(str(tmp_path))
        assert len(result) < 9500
