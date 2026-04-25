"""Tests unitaires pour les utilitaires de messages (trim + clean)."""

import pytest
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from openagentic_ai.context.messages import clean_messages, trim_message_history


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ai(content: str, **kwargs) -> AIMessage:
    return AIMessage(content=content, **kwargs)


def _human(content: str) -> HumanMessage:
    return HumanMessage(content=content)


def _system(content: str) -> SystemMessage:
    return SystemMessage(content=content)


def _tool(content: str, tool_call_id: str = "tc1") -> ToolMessage:
    return ToolMessage(content=content, tool_call_id=tool_call_id)


# ---------------------------------------------------------------------------
# trim_message_history
# ---------------------------------------------------------------------------

class TestTrimMessageHistory:

    def test_returns_all_when_under_limit(self):
        msgs = [_human("a"), _ai("b"), _human("c")]
        result = trim_message_history(msgs, max_messages=10)
        assert result == msgs

    def test_returns_all_when_equal_limit(self):
        msgs = [_human(f"msg{i}") for i in range(5)]
        result = trim_message_history(msgs, max_messages=5)
        assert result == msgs

    def test_trims_to_last_n(self):
        msgs = [_human(f"msg{i}") for i in range(10)]
        result = trim_message_history(msgs, max_messages=3)
        assert result == msgs[-3:]

    def test_excludes_system_messages(self):
        msgs = [_system("sys"), _human("h1"), _ai("a1")]
        result = trim_message_history(msgs, max_messages=10)
        assert not any(isinstance(m, SystemMessage) for m in result)
        assert len(result) == 2

    def test_system_messages_dont_count_towards_limit(self):
        """Les SystemMessages sont filtrés avant de compter."""
        msgs = [_system("sys")] + [_human(f"h{i}") for i in range(5)]
        result = trim_message_history(msgs, max_messages=3)
        # 5 non-system msgs → trim to 3
        assert len(result) == 3

    def test_strips_orphan_tool_message_at_start(self):
        """Un ToolMessage en tête (sans AIMessage parent) est supprimé."""
        msgs = [
            _human("older"),
            _ai("older ai"),
            _human("trigger"),
            _ai("invoke tool", tool_calls=[{"name": "t", "args": {}, "id": "tc1"}]),
            _tool("result", tool_call_id="tc1"),
            _human("follow up"),
            _ai("final"),
        ]
        # Force un trim qui laisse le ToolMessage en premier
        # history = last 3 → [ToolMessage, HumanMessage, AIMessage]
        result = trim_message_history(msgs, max_messages=3)
        # L'orphelin ToolMessage doit être supprimé
        assert not isinstance(result[0], ToolMessage)

    def test_no_orphan_when_ai_present(self):
        """Pas de suppression si le ToolMessage est précédé de son AIMessage."""
        ai_msg = _ai("call", tool_calls=[{"name": "t", "args": {}, "id": "tc1"}])
        tool_msg = _tool("result", tool_call_id="tc1")
        msgs = [_human("q"), ai_msg, tool_msg]
        result = trim_message_history(msgs, max_messages=10)
        assert tool_msg in result

    def test_empty_list_returns_empty(self):
        assert trim_message_history([], max_messages=5) == []

    def test_only_system_messages_returns_empty(self):
        msgs = [_system("s1"), _system("s2")]
        result = trim_message_history(msgs, max_messages=10)
        assert result == []

    def test_multiple_orphan_tool_messages_stripped(self):
        """Plusieurs ToolMessages en tête sont tous supprimés."""
        msgs = [
            _human("a"), _ai("b"), _human("c"), _ai("d"),
            _tool("t1", tool_call_id="tc1"),
            _tool("t2", tool_call_id="tc2"),
            _human("last"),
        ]
        result = trim_message_history(msgs, max_messages=4)
        # Dernier 4 : [AIMessage("d"), ToolMsg, ToolMsg, HumanMessage]
        # → les deux ToolMessages orphelins sont supprimés
        assert not isinstance(result[0], ToolMessage)


# ---------------------------------------------------------------------------
# clean_messages
# ---------------------------------------------------------------------------

class TestCleanMessages:

    def test_removes_bloat_keys(self):
        ai = _ai("hello", additional_kwargs={
            "__gemini_thinking__": "thinking...",
            "system_fingerprint": "fp-123",
            "tool_calls": [],  # clé légitime à conserver
        })
        result = clean_messages([ai])
        kwargs = result[0].additional_kwargs
        assert "__gemini_thinking__" not in kwargs
        assert "system_fingerprint" not in kwargs

    def test_preserves_legitimate_keys(self):
        ai = _ai("hello", additional_kwargs={
            "tool_calls": [{"id": "tc1"}],
            "raw_response": "bloat",
        })
        result = clean_messages([ai])
        assert "tool_calls" in result[0].additional_kwargs
        assert "raw_response" not in result[0].additional_kwargs

    def test_non_ai_messages_untouched(self):
        human = _human("hi")
        system = _system("sys")
        tool = _tool("res")
        result = clean_messages([human, system, tool])
        assert result[0] is human
        assert result[1] is system
        assert result[2] is tool

    def test_ai_without_bloat_untouched(self):
        ai = _ai("clean", additional_kwargs={"tool_calls": []})
        result = clean_messages([ai])
        assert result[0].additional_kwargs == {"tool_calls": []}

    def test_ai_empty_additional_kwargs_untouched(self):
        ai = _ai("clean")
        result = clean_messages([ai])
        assert result[0].content == "clean"

    def test_empty_list_returns_empty(self):
        assert clean_messages([]) == []

    def test_all_bloat_keys_removed(self):
        """Tous les champs de _METADATA_BLOAT_KEYS sont supprimés."""
        bloat_keys = {
            "__gemini_function_call_thought_signatures__",
            "__gemini_thinking__",
            "__mistral_thinking__",
            "raw_response",
            "system_fingerprint",
        }
        ai = _ai("x", additional_kwargs={k: "v" for k in bloat_keys})
        result = clean_messages([ai])
        for k in bloat_keys:
            assert k not in result[0].additional_kwargs

    def test_mixed_list_processes_only_ai(self):
        """Dans une liste mixte, seuls les AIMessages sont nettoyés."""
        ai = _ai("ai", additional_kwargs={"raw_response": "bloat"})
        human = _human("human")
        result = clean_messages([human, ai])
        assert result[0] is human
        assert "raw_response" not in result[1].additional_kwargs
