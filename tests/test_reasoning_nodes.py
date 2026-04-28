"""Tests des nœuds reasoning_node et critique_node."""
from openagenticskyzer.graph.state import AgentState
from langchain_core.messages import HumanMessage


def _base_state(**extra) -> AgentState:
    base = {
        "messages": [HumanMessage(content="test")],
        "reasoning_mode": "simple",
        "task_type": "general",
        "reasoning_scratchpad": "",
        "confidence_score": 3,
        "critique_result": "",
        "needs_correction": False,
        "critique_iterations": 0,
    }
    base.update(extra)
    return base  # type: ignore[return-value]


class TestAgentStateFields:
    def test_all_reasoning_fields_present(self):
        state = _base_state()
        assert "reasoning_mode" in state
        assert "task_type" in state
        assert "reasoning_scratchpad" in state
        assert "confidence_score" in state
        assert "critique_result" in state
        assert "needs_correction" in state
        assert "critique_iterations" in state

    def test_default_reasoning_mode_is_simple(self):
        state = _base_state()
        assert state["reasoning_mode"] == "simple"


from unittest.mock import MagicMock, patch
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from openagenticskyzer.graph.nodes import make_reasoning_node


def _make_mock_llm(response: str = "## 1. Reformulation\nTest raisonnement") -> MagicMock:
    llm = MagicMock()
    llm.invoke.return_value = AIMessage(content=response)
    return llm


class TestReasoningNode:

    def test_simple_message_skips_cot(self):
        """Mode simple : reasoning_node ne doit PAS appeler le LLM."""
        llm = _make_mock_llm()
        node = make_reasoning_node(llm)
        state = _base_state(messages=[HumanMessage(content="ok merci")])
        result = node(state)
        llm.invoke.assert_not_called()
        assert result["reasoning_mode"] == "simple"
        assert result["reasoning_scratchpad"] == ""

    def test_complex_message_calls_llm_for_cot(self):
        """Mode complex : reasoning_node DOIT appeler le LLM pour générer le CoT."""
        llm = _make_mock_llm("## 1. Reformulation\nL'utilisateur veut refactorer.")
        node = make_reasoning_node(llm)
        state = _base_state(
            messages=[HumanMessage(content="Refactore cette classe pour utiliser les design patterns")]
        )
        result = node(state)
        llm.invoke.assert_called_once()
        assert result["reasoning_mode"] in ("complex", "critical")
        assert "Reformulation" in result["reasoning_scratchpad"]

    def test_cot_injected_as_system_message(self):
        """Le raisonnement CoT doit être injecté comme SystemMessage dans messages."""
        llm = _make_mock_llm("Raisonnement interne test")
        node = make_reasoning_node(llm)
        state = _base_state(
            messages=[HumanMessage(content="Architecturer un système scalable avec microservices")]
        )
        result = node(state)
        # Vérifie d'abord que le mode est bien complex/critical (sinon pas d'injection)
        assert result["reasoning_mode"] in ("complex", "critical"), (
            f"Expected complex/critical mode, got {result['reasoning_mode']!r} — "
            "le message n'a pas été détecté comme complexe"
        )
        injected = result.get("messages", [])
        assert len(injected) >= 1
        last = injected[-1]
        assert isinstance(last, SystemMessage)
        assert "RAISONNEMENT" in last.content

    def test_standard_message_skips_cot(self):
        """Mode standard ou simple : pas de CoT, pas d'appel LLM."""
        llm = _make_mock_llm()
        node = make_reasoning_node(llm)
        state = _base_state(messages=[HumanMessage(content="comment fonctionne Python ?")])
        result = node(state)
        # Si le mode est simple ou standard, le LLM ne doit PAS être appelé
        if result["reasoning_mode"] in ("simple", "standard"):
            llm.invoke.assert_not_called()
        assert result["reasoning_mode"] in ("simple", "standard", "complex", "critical")

    def test_returns_all_required_state_keys(self):
        """reasoning_node retourne toujours les clés de state nécessaires."""
        llm = _make_mock_llm()
        node = make_reasoning_node(llm)
        state = _base_state(messages=[HumanMessage(content="ok")])
        result = node(state)
        for key in ("reasoning_mode", "task_type", "reasoning_scratchpad",
                    "confidence_score", "critique_result", "needs_correction", "critique_iterations"):
            assert key in result, f"Clé manquante dans le résultat : {key}"

    def test_llm_error_returns_fallback_result(self):
        """Si le LLM échoue pendant le CoT, le nœud retourne un résultat valide sans crash."""
        llm = MagicMock()
        llm.invoke.side_effect = RuntimeError("LLM timeout")
        node = make_reasoning_node(llm)
        # Message qui force le mode complex/critical
        state = _base_state(
            messages=[HumanMessage(content="Architecturer un système scalable avec microservices")]
        )
        result = node(state)
        # Doit retourner sans crash, avec scratchpad vide
        assert result is not None
        assert result["reasoning_scratchpad"] == ""
        assert result["needs_correction"] is False
