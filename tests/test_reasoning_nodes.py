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
