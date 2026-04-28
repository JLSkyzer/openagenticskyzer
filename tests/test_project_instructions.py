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


from unittest.mock import MagicMock
from langchain_core.messages import AIMessage, HumanMessage
from openagenticskyzer.graph.nodes import make_agent_node


class TestProjectInstructionsIntegration:

    def test_instructions_injected_in_system_prompt(self, tmp_path):
        """Les instructions OPENAGENT.md apparaissent dans l'appel au LLM."""
        (tmp_path / "OPENAGENT.md").write_text("Toujours utiliser des types Python.", encoding="utf-8")

        captured_messages = []

        def mock_invoke(messages, **kwargs):
            captured_messages.extend(messages)
            return AIMessage(content="ok")

        model = MagicMock()
        model.invoke = mock_invoke

        node = make_agent_node(
            model=model,
            system_prompt="Prompt de base.",
            max_history=20,
            max_tokens=None,
            lmstudio_compat=False,
            cwd=str(tmp_path),
        )

        state = {
            "messages": [HumanMessage(content="test")],
            "reasoning_mode": "simple",
            "task_type": "general",
            "reasoning_scratchpad": "",
            "confidence_score": 3,
            "critique_result": "",
            "needs_correction": False,
            "critique_iterations": 0,
        }
        node(state)

        all_content = " ".join(
            m.content for m in captured_messages
            if hasattr(m, "content") and isinstance(m.content, str)
        )
        assert "Toujours utiliser des types Python" in all_content

    def test_no_instructions_file_does_not_crash(self, tmp_path):
        """Sans fichier OPENAGENT.md, le nœud fonctionne normalement."""
        model = MagicMock()
        model.invoke.return_value = AIMessage(content="ok")

        node = make_agent_node(
            model=model,
            system_prompt="Test.",
            max_history=20,
            max_tokens=None,
            lmstudio_compat=False,
            cwd=str(tmp_path),
        )
        state = {
            "messages": [HumanMessage(content="test")],
            "reasoning_mode": "simple",
            "task_type": "general",
            "reasoning_scratchpad": "",
            "confidence_score": 3,
            "critique_result": "",
            "needs_correction": False,
            "critique_iterations": 0,
        }
        result = node(state)
        assert result is not None

    def test_cwd_none_does_not_crash(self):
        """cwd=None ne plante pas."""
        model = MagicMock()
        model.invoke.return_value = AIMessage(content="ok")

        node = make_agent_node(
            model=model,
            system_prompt="Test.",
            max_history=20,
            max_tokens=None,
            lmstudio_compat=False,
            cwd=None,
        )
        state = {
            "messages": [HumanMessage(content="test")],
            "reasoning_mode": "simple",
            "task_type": "general",
            "reasoning_scratchpad": "",
            "confidence_score": 3,
            "critique_result": "",
            "needs_correction": False,
            "critique_iterations": 0,
        }
        result = node(state)
        assert result is not None
