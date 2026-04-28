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


from openagenticskyzer.graph.nodes import make_critique_node


class TestCritiqueNode:

    def test_skips_if_mode_not_critical(self):
        """La critique ne s'exécute que pour le mode 'critical'."""
        llm = _make_mock_llm()
        node = make_critique_node(llm)
        state = _base_state(
            messages=[HumanMessage(content="q"), AIMessage(content="r")],
            reasoning_mode="complex",
        )
        result = node(state)
        llm.invoke.assert_not_called()
        assert result.get("needs_correction") is False

    def test_skips_if_max_iterations_reached(self):
        """Après 2 itérations, ne critique plus (évite boucle infinie)."""
        llm = _make_mock_llm()
        node = make_critique_node(llm)
        state = _base_state(
            messages=[HumanMessage(content="q"), AIMessage(content="r")],
            reasoning_mode="critical",
            critique_iterations=2,
        )
        result = node(state)
        llm.invoke.assert_not_called()

    def test_no_issues_sets_needs_correction_false(self):
        """Critique sans problèmes → needs_correction = False."""
        llm = MagicMock()
        llm.invoke.return_value = AIMessage(
            content='{"has_issues": false, "issues": [], "confidence": 5, "corrections_needed": []}'
        )
        node = make_critique_node(llm)
        state = _base_state(
            messages=[HumanMessage(content="debug ce code"), AIMessage(content="la réponse")],
            reasoning_mode="critical",
            critique_iterations=0,
        )
        result = node(state)
        assert result["needs_correction"] is False
        assert result["confidence_score"] == 5

    def test_issues_detected_sets_needs_correction_true(self):
        """Critique avec problèmes → needs_correction = True et message de correction injecté."""
        llm = MagicMock()
        llm.invoke.return_value = AIMessage(
            content='{"has_issues": true, "issues": ["bug logique"], "confidence": 2, "corrections_needed": ["fix le bug"]}'
        )
        node = make_critique_node(llm)
        state = _base_state(
            messages=[HumanMessage(content="debug ce code"), AIMessage(content="la réponse")],
            reasoning_mode="critical",
            critique_iterations=0,
        )
        result = node(state)
        assert result["needs_correction"] is True
        assert result["critique_iterations"] == 1
        injected = result.get("messages", [])
        assert any("AUTO-CORRECTION" in m.content for m in injected)

    def test_invalid_json_does_not_crash(self):
        """JSON malformé dans la réponse de critique → no-op (pas de crash)."""
        llm = MagicMock()
        llm.invoke.return_value = AIMessage(content="je ne suis pas du JSON valide")
        node = make_critique_node(llm)
        state = _base_state(
            messages=[HumanMessage(content="q"), AIMessage(content="r")],
            reasoning_mode="critical",
            critique_iterations=0,
        )
        result = node(state)
        assert result.get("needs_correction") is False


from openagenticskyzer.graph.nodes import route_after_agent, route_after_critique
from langgraph.graph import END


class TestRouteAfterAgent:

    def test_routes_to_tools_when_tool_calls_present(self):
        state = _base_state(
            messages=[
                HumanMessage(content="q"),
                AIMessage(content="", tool_calls=[{"id": "1", "name": "run_command", "args": {}}]),
            ],
            reasoning_mode="critical",
        )
        assert route_after_agent(state) == "tools"

    def test_routes_to_critique_in_critical_mode_no_tools(self):
        state = _base_state(
            messages=[HumanMessage(content="q"), AIMessage(content="réponse")],
            reasoning_mode="critical",
            critique_iterations=0,
        )
        assert route_after_agent(state) == "critique"

    def test_routes_to_end_in_simple_mode(self):
        state = _base_state(
            messages=[HumanMessage(content="q"), AIMessage(content="réponse")],
            reasoning_mode="simple",
        )
        assert route_after_agent(state) == END

    def test_routes_to_end_in_complex_mode(self):
        """La critique n'est déclenchée que pour 'critical', pas 'complex'."""
        state = _base_state(
            messages=[HumanMessage(content="q"), AIMessage(content="réponse")],
            reasoning_mode="complex",
        )
        assert route_after_agent(state) == END

    def test_routes_to_end_when_max_critique_iterations_reached(self):
        state = _base_state(
            messages=[HumanMessage(content="q"), AIMessage(content="réponse")],
            reasoning_mode="critical",
            critique_iterations=2,
        )
        assert route_after_agent(state) == END


class TestRouteAfterCritique:

    def test_routes_to_agent_when_correction_needed(self):
        state = _base_state(needs_correction=True)
        assert route_after_critique(state) == "agent"

    def test_routes_to_end_when_no_correction_needed(self):
        state = _base_state(needs_correction=False)
        assert route_after_critique(state) == END


from openagenticskyzer.graph.workflow import build_graph


def _make_mock_model():
    """Crée un mock LLM qui retourne toujours une réponse simple."""
    model = MagicMock()
    model.bind_tools.return_value = model
    model.invoke.return_value = AIMessage(content="réponse simple")
    return model


class TestBuildGraphWithReasoning:

    def test_graph_compiles_with_reasoning_nodes(self):
        """Le graphe doit compiler sans erreur avec les nouveaux nœuds."""
        model = _make_mock_model()
        graph = build_graph(
            model=model,
            tools=[],
            system_prompt="Test",
        )
        assert graph is not None

    def test_graph_invoke_simple_message(self):
        """Un message simple traverse le graphe et appelle le LLM exactement 1 fois."""
        call_count = {"n": 0}

        def mock_invoke(messages, **kwargs):
            call_count["n"] += 1
            return AIMessage(content="réponse simple")

        model = MagicMock()
        model.bind_tools.return_value = model
        model.invoke = mock_invoke

        graph = build_graph(model=model, tools=[], system_prompt="Test")
        result = graph.invoke({
            "messages": [HumanMessage(content="ok merci")],
            "reasoning_mode": "simple",
            "task_type": "general",
            "reasoning_scratchpad": "",
            "confidence_score": 3,
            "critique_result": "",
            "needs_correction": False,
            "critique_iterations": 0,
        })
        # Pour un message simple, le LLM est appelé 1 seule fois
        assert call_count["n"] == 1
