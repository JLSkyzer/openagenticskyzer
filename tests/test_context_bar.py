# tests/test_context_bar.py
"""Tests de la logique pure de compaction LLM (Task 4) + du comportement de
`trigger_compact` autour de la concurrence (review follow-up).

`trigger_compact` lui-même est fortement couplé à NiceGUI (ui.notify,
run.io_bound, refresh...) et au LLM via build_agent/agent.invoke — pas
raisonnablement testable en isolation sans un harnais UI+LLM complet (même
constat que Task 3 pour `_send_message`). La logique de transformation pure
(construction du texte d'historique, extraction du résumé depuis le retour
de l'agent) a donc été extraite dans des fonctions dédiées, spécifiquement
pour les rendre testables — voir
openagenticskyzer/app/components/context_bar.py.

Le garde-fou de réentrance et le chemin "résumé vide" restent en revanche
directement dans `trigger_compact`, mais sont testables en patchant les
seuls points de contact NiceGUI/LLM (ui.notify, chat_messages.refresh,
context_bar.refresh, build_agent) — pas besoin d'un vrai client NiceGUI ni
d'un vrai LLM pour ça, donc on les teste ici plutôt que de les laisser
non couverts.
"""
import asyncio
from dataclasses import dataclass
from types import SimpleNamespace

import pytest

import openagenticskyzer.app.components.context_bar as context_bar_module
from openagenticskyzer.app.components.context_bar import (
    _build_compact_history_text,
    _build_compact_summary_prompt,
    _extract_summary_from_result,
    trigger_compact,
)
from openagenticskyzer.app.state import ChatMessage, state


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


# ── trigger_compact() concurrency/failure-path tests ─────────────────────


def _make_messages(n: int) -> list[ChatMessage]:
    return [
        ChatMessage(role="user" if i % 2 == 0 else "ai", content=f"msg{i}")
        for i in range(n)
    ]


@pytest.fixture(autouse=True)
def _isolate_app_state():
    """trigger_compact mutates module/app-level singletons — snapshot and
    restore them so tests in this file can't bleed into each other or into
    tests in other modules that import the same `state` singleton."""
    saved_messages = list(state.messages)
    saved_active_folder = state.active_folder
    saved_in_progress = context_bar_module._compact_in_progress
    yield
    state.messages = saved_messages
    state.active_folder = saved_active_folder
    context_bar_module._compact_in_progress = saved_in_progress


def _patch_nicegui_side_effects(monkeypatch):
    """Patch away the NiceGUI touchpoints trigger_compact calls (ui.notify,
    chat_messages.refresh, context_bar.refresh) so it can run to completion
    under plain asyncio.run() without a live NiceGUI client/page — none of
    these three are meaningful assertions on their own here, just required
    scaffolding. Returns the list of (message, type) notify calls."""
    import openagenticskyzer.app.components.chat as chat_module

    notifications: list[tuple[str, str | None]] = []
    monkeypatch.setattr(
        context_bar_module.ui, "notify",
        lambda msg, type=None: notifications.append((msg, type)),
    )
    monkeypatch.setattr(chat_module.chat_messages, "refresh", lambda: None)
    monkeypatch.setattr(context_bar_module.context_bar, "refresh", lambda: None)
    return notifications


class TestReentrancyGuard:
    def test_second_call_returns_early_without_invoking_llm(self, monkeypatch):
        notifications = _patch_nicegui_side_effects(monkeypatch)
        state.messages = _make_messages(6)
        context_bar_module._compact_in_progress = True  # a compaction is "already running"

        build_agent_calls = []
        monkeypatch.setattr(
            "openagenticskyzer.agent.build_agent",
            lambda **kw: build_agent_calls.append(kw) or SimpleNamespace(),
        )

        asyncio.run(trigger_compact())

        assert build_agent_calls == []  # never reached the LLM call
        assert any("cours" in msg.lower() for msg, _ in notifications)
        # The in-flight call (not us) owns clearing the flag.
        assert context_bar_module._compact_in_progress is True


class TestEmptySummaryIsNeverSilent:
    def test_notifies_and_leaves_state_untouched_when_summary_is_empty(self, monkeypatch):
        notifications = _patch_nicegui_side_effects(monkeypatch)
        messages = _make_messages(6)
        state.messages = messages
        state.active_folder = None
        context_bar_module._compact_in_progress = False

        class _FakeAgent:
            def invoke(self, payload, config):
                # Agent replied with only a tool call — extraction yields "".
                return {"messages": [SimpleNamespace(content="", tool_calls=[{"name": "x"}])]}

        monkeypatch.setattr(
            "openagenticskyzer.agent.build_agent",
            lambda **kw: _FakeAgent(),
        )

        asyncio.run(trigger_compact())

        assert state.messages == messages  # untouched — no silent partial mutation
        assert any(type_ == "negative" for _, type_ in notifications)
        assert context_bar_module._compact_in_progress is False  # guard released


class TestTailSnapshotSurvivesConcurrentGrowth:
    def test_reattached_tail_is_the_pre_await_snapshot_not_a_fresh_read(self, monkeypatch):
        notifications = _patch_nicegui_side_effects(monkeypatch)
        messages = _make_messages(6)  # m0..m5
        state.messages = messages
        state.active_folder = None
        context_bar_module._compact_in_progress = False
        original_tail = list(messages[-2:])  # [m4, m5] — expected survivors

        class _FakeAgent:
            def invoke(self, payload, config):
                # Simulates state.messages growing during the real `await`
                # (NiceGUI's single-threaded loop yields control there).
                # A fresh `state.messages[-2:]` read after this would
                # return [m5, concurrent] and silently lose m4 forever.
                state.messages.append(ChatMessage(role="user", content="concurrent"))
                return {"messages": [SimpleNamespace(content="SUMMARY TEXT", tool_calls=None)]}

        monkeypatch.setattr(
            "openagenticskyzer.agent.build_agent",
            lambda **kw: _FakeAgent(),
        )

        asyncio.run(trigger_compact())

        assert state.messages[1:] == original_tail
        assert state.messages[0].content == "**[Résumé de contexte compressé]**\n\nSUMMARY TEXT"
        assert any(type_ == "positive" for _, type_ in notifications)


class TestLlmFailureFallback:
    def test_brute_cut_fallback_and_warning_notify_on_llm_exception(self, monkeypatch):
        notifications = _patch_nicegui_side_effects(monkeypatch)
        messages = _make_messages(8)
        state.messages = messages
        state.active_folder = None
        context_bar_module._compact_in_progress = False

        def _raise(**kw):
            raise RuntimeError("boom")

        monkeypatch.setattr("openagenticskyzer.agent.build_agent", _raise)

        asyncio.run(trigger_compact())

        assert state.messages == messages[-6:]
        assert any("indisponible" in msg for msg, _ in notifications)
        assert context_bar_module._compact_in_progress is False
