# openagenticskyzer/graph/workflow.py
"""LangGraph workflow builder — avec raisonnement CoT et auto-critique (Phase 16)."""

import logging

from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

from openagenticskyzer.graph.nodes import (
    make_agent_node,
    make_critique_node,
    make_reasoning_node,
    route_after_agent,
    route_after_critique,
)
from openagenticskyzer.graph.state import AgentState

logger = logging.getLogger("openagentic.workflow")


def build_graph(
    model,
    tools: list,
    system_prompt: str,
    max_history: int = 20,
    max_tokens: int | None = None,
    permission_manager=None,
    lmstudio_compat: bool = False,
):
    """Build and compile the LangGraph agent graph.

    Graph structure (Phase 16) :
        START → reasoning → agent → [tool_calls?] → tools → agent → ...
                                  → [critical, no tools] → critique → [issues?] → agent
                                  → [ok] → END
    """
    bound_model = model.bind_tools(tools)
    agent_node = make_agent_node(bound_model, system_prompt, max_history, max_tokens, lmstudio_compat)
    reasoning_node = make_reasoning_node(model)
    critique_node = make_critique_node(model)

    if permission_manager is not None:
        from openagenticskyzer.permissions import make_permission_tool_node
        tool_node = make_permission_tool_node(tools, permission_manager)
    elif tools:
        tool_node = ToolNode(tools)
    else:
        tool_node = _noop_tool_node

    graph = StateGraph(AgentState)
    graph.add_node("reasoning", reasoning_node)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_node("critique", critique_node)

    graph.set_entry_point("reasoning")
    graph.add_edge("reasoning", "agent")
    graph.add_conditional_edges(
        "agent",
        route_after_agent,
        {"tools": "tools", "critique": "critique", END: END},
    )
    graph.add_edge("tools", "agent")
    graph.add_conditional_edges(
        "critique",
        route_after_critique,
        {"agent": "agent", END: END},
    )

    compiled = graph.compile()
    logger.info(
        "Graph compiled — %d tools, max_history=%d, reasoning=enabled",
        len(tools), max_history,
    )
    return compiled


def _noop_tool_node(state: AgentState) -> dict:
    """Nœud tools vide quand aucun outil n'est fourni (tests)."""
    return {}
