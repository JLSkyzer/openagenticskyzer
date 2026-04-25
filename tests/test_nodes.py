"""Tests unitaires pour les nœuds LangGraph (make_agent_node, route_after_agent)."""

from unittest.mock import MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END

from openagentic_ai.graph.nodes import make_agent_node, route_after_agent
from openagentic_ai.graph.state import AgentState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_model(response_content: str = "Réponse", tool_calls=None):
    """Crée un modèle mock qui retourne un AIMessage."""
    response = AIMessage(
        content=response_content,
        tool_calls=tool_calls or [],
    )
    model = MagicMock()
    model.invoke.return_value = response
    return model


def _state(*messages) -> AgentState:
    return {"messages": list(messages)}


# ---------------------------------------------------------------------------
# route_after_agent
# ---------------------------------------------------------------------------

class TestRouteAfterAgent:

    def test_routes_to_end_when_no_tool_calls(self):
        state = _state(HumanMessage(content="q"), AIMessage(content="ok"))
        result = route_after_agent(state)
        assert result == END

    def test_routes_to_tools_when_tool_calls_present(self):
        ai_with_tools = AIMessage(
            content="",
            tool_calls=[{"name": "run_command", "args": {"cmd": "ls"}, "id": "tc1"}],
        )
        state = _state(HumanMessage(content="q"), ai_with_tools)
        result = route_after_agent(state)
        assert result == "tools"

    def test_routes_to_end_when_tool_calls_empty_list(self):
        ai = AIMessage(content="réponse", tool_calls=[])
        state = _state(ai)
        result = route_after_agent(state)
        assert result == END

    def test_routes_based_on_last_message_only(self):
        """Seul le dernier message détermine le routage."""
        ai_with_tools = AIMessage(
            content="",
            tool_calls=[{"name": "tool", "args": {}, "id": "tc1"}],
        )
        ai_without_tools = AIMessage(content="done", tool_calls=[])
        # Dernier message = sans tool_calls → END
        state = _state(ai_with_tools, ai_without_tools)
        result = route_after_agent(state)
        assert result == END

    def test_human_message_has_no_tool_calls(self):
        """Un HumanMessage en dernier → END (pas d'attribut tool_calls)."""
        state = _state(HumanMessage(content="question"))
        result = route_after_agent(state)
        assert result == END


# ---------------------------------------------------------------------------
# make_agent_node
# ---------------------------------------------------------------------------

class TestMakeAgentNode:

    def test_returns_callable(self):
        model = _make_mock_model()
        node = make_agent_node(model, "System prompt")
        assert callable(node)

    def test_node_calls_model_invoke(self):
        model = _make_mock_model("Réponse LLM")
        node = make_agent_node(model, "Tu es un assistant.")
        state = _state(HumanMessage(content="Bonjour"))
        node(state)
        model.invoke.assert_called_once()

    def test_node_returns_messages_dict(self):
        model = _make_mock_model("Réponse")
        node = make_agent_node(model, "Prompt système")
        state = _state(HumanMessage(content="Hi"))
        result = node(state)
        assert "messages" in result
        assert isinstance(result["messages"], list)
        assert len(result["messages"]) == 1

    def test_system_prompt_prepended(self):
        """Le SystemMessage doit être le premier message envoyé au modèle."""
        model = _make_mock_model()
        system = "Tu es un assistant de code."
        node = make_agent_node(model, system)
        state = _state(HumanMessage(content="Question"))
        node(state)

        call_args = model.invoke.call_args[0][0]  # premier argument positionnel
        assert isinstance(call_args[0], SystemMessage)
        assert call_args[0].content == system

    def test_history_trimmed_to_max(self):
        """Avec max_history=2, seuls 2 messages (hors system) sont envoyés."""
        model = _make_mock_model()
        node = make_agent_node(model, "Sys", max_history=2)
        msgs = [HumanMessage(content=f"msg{i}") for i in range(10)]
        state = _state(*msgs)
        node(state)

        call_args = model.invoke.call_args[0][0]
        # Premier = SystemMessage, puis au max 2 messages
        non_system = [m for m in call_args if not isinstance(m, SystemMessage)]
        assert len(non_system) <= 2

    def test_default_max_history_is_20(self):
        """Sans argument, max_history vaut 20."""
        model = _make_mock_model()
        node = make_agent_node(model, "Sys")
        # 25 messages humains → les 20 derniers passent
        msgs = [HumanMessage(content=f"msg{i}") for i in range(25)]
        state = _state(*msgs)
        node(state)

        call_args = model.invoke.call_args[0][0]
        non_system = [m for m in call_args if not isinstance(m, SystemMessage)]
        assert len(non_system) == 20

    def test_system_messages_in_state_excluded(self):
        """Les SystemMessages dans l'état ne sont pas envoyés (réinjection propre)."""
        model = _make_mock_model()
        node = make_agent_node(model, "Mon prompt", max_history=10)
        state = _state(
            SystemMessage(content="Ancien prompt"),
            HumanMessage(content="Bonjour"),
        )
        node(state)

        call_args = model.invoke.call_args[0][0]
        system_msgs = [m for m in call_args if isinstance(m, SystemMessage)]
        # Seulement UN SystemMessage : celui injecté par le nœud
        assert len(system_msgs) == 1
        assert system_msgs[0].content == "Mon prompt"

    def test_response_ai_message_in_output(self):
        """Le message de retour du modèle est bien dans la liste output."""
        model = _make_mock_model("Voici la réponse.")
        node = make_agent_node(model, "Sys")
        state = _state(HumanMessage(content="q"))
        result = node(state)
        assert result["messages"][0].content == "Voici la réponse."

    def test_node_works_with_empty_history(self):
        """Un état avec zéro message ne lève pas d'exception."""
        model = _make_mock_model()
        node = make_agent_node(model, "Sys")
        state = _state()
        result = node(state)
        assert "messages" in result


# ---------------------------------------------------------------------------
# AgentState TypedDict
# ---------------------------------------------------------------------------

class TestAgentState:

    def test_state_accepts_messages(self):
        state: AgentState = {"messages": [HumanMessage(content="test")]}
        assert len(state["messages"]) == 1

    def test_state_accepts_empty_messages(self):
        state: AgentState = {"messages": []}
        assert state["messages"] == []
