# tests/test_context_bar.py
"""Tests de la logique pure de compaction LLM (Task 4).

`trigger_compact` lui-même est fortement couplé à NiceGUI (ui.notify,
run.io_bound, refresh...) et au LLM via build_agent/agent.invoke — pas
raisonnablement testable en isolation sans un harnais UI+LLM complet (même
constat que Task 3 pour `_send_message`). La logique de transformation pure
(construction du texte d'historique, extraction du résumé depuis le retour
de l'agent) a donc été extraite dans des fonctions dédiées, spécifiquement
pour les rendre testables — voir
openagenticskyzer/app/components/context_bar.py.
"""
from dataclasses import dataclass
from types import SimpleNamespace

from openagenticskyzer.app.components.context_bar import (
    _build_compact_history_text,
    _build_compact_summary_prompt,
    _extract_summary_from_result,
)


@dataclass
class _FakeMsg:
    role: str
    content: str


class TestBuildCompactHistoryText:
    def test_excludes_last_two_messages(self):
        messages = [
            _FakeMsg("user", "first"),
            _FakeMsg("ai", "second"),
            _FakeMsg("user", "third — should be excluded"),
            _FakeMsg("ai", "fourth — should be excluded"),
        ]
        result = _build_compact_history_text(messages)
        assert "first" in result
        assert "second" in result
        assert "third" not in result
        assert "fourth" not in result

    def test_filters_non_user_ai_roles(self):
        messages = [
            _FakeMsg("tool", "tool output"),
            _FakeMsg("user", "hello"),
            _FakeMsg("ai", "bye"),
            _FakeMsg("user", "trailing1"),
            _FakeMsg("ai", "trailing2"),
        ]
        result = _build_compact_history_text(messages)
        assert "tool output" not in result
        assert "hello" in result

    def test_truncates_long_content_to_800_chars(self):
        long_content = "x" * 1000
        messages = [
            _FakeMsg("user", long_content),
            _FakeMsg("ai", "pad1"),
            _FakeMsg("ai", "pad2"),
        ]
        result = _build_compact_history_text(messages)
        assert "x" * 800 in result
        assert "x" * 801 not in result

    def test_formats_role_uppercase(self):
        messages = [
            _FakeMsg("user", "hi"),
            _FakeMsg("ai", "pad1"),
            _FakeMsg("ai", "pad2"),
        ]
        result = _build_compact_history_text(messages)
        assert "[USER]: hi" in result

    def test_empty_list_returns_empty_string(self):
        assert _build_compact_history_text([]) == ""


class TestBuildCompactSummaryPrompt:
    def test_includes_history_text(self):
        result = _build_compact_summary_prompt("some history")
        assert "some history" in result
        assert "RÉSUMÉ" in result


class TestExtractSummaryFromResult:
    def test_returns_last_content_without_tool_calls(self):
        messages = [
            SimpleNamespace(content="first answer", tool_calls=None),
            SimpleNamespace(content="final answer", tool_calls=None),
        ]
        assert _extract_summary_from_result(messages) == "final answer"

    def test_skips_messages_with_tool_calls(self):
        messages = [
            SimpleNamespace(content="real summary", tool_calls=None),
            SimpleNamespace(content="", tool_calls=[{"name": "read_file"}]),
        ]
        assert _extract_summary_from_result(messages) == "real summary"

    def test_skips_empty_content(self):
        messages = [
            SimpleNamespace(content="prior text", tool_calls=None),
            SimpleNamespace(content="", tool_calls=None),
        ]
        assert _extract_summary_from_result(messages) == "prior text"

    def test_empty_list_returns_empty_string(self):
        assert _extract_summary_from_result([]) == ""

    def test_no_matching_message_returns_empty_string(self):
        messages = [
            SimpleNamespace(content="", tool_calls=[{"name": "x"}]),
        ]
        assert _extract_summary_from_result(messages) == ""

    def test_coerces_non_string_content_to_str(self):
        messages = [
            SimpleNamespace(content=["a", "b"], tool_calls=None),
        ]
        assert _extract_summary_from_result(messages) == "['a', 'b']"
