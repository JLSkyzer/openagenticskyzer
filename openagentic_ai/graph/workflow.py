"""LangGraph workflow builder."""

import logging

from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

from openagentic_ai.graph.nodes import make_agent_node, route_after_agent
from openagentic_ai.graph.state import AgentState

logger = logging.getLogger("openagentic.workflow")


def build_graph(model, tools: list, system_prompt: str, max_history: int = 20):
    """Build and compile the LangGraph agent graph.

    Graph structure:
        START → agent → [tool_calls?] → tools → agent → ...
                       [no tool calls] → END

    The agent node trims + cleans history before each LLM call,
    keeping the context window lean without a separate middleware layer.
    """
    bound_model = model.bind_tools(tools)
    agent_node = make_agent_node(bound_model, system_prompt, max_history)
    tool_node = ToolNode(tools)

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)

    graph.set_entry_point("agent")
    graph.add_conditional_edges(
        "agent",
        route_after_agent,
        {"tools": "tools", END: END},
    )
    graph.add_edge("tools", "agent")

    compiled = graph.compile()
    logger.info("Graph compiled — %d tools, max_history=%d", len(tools), max_history)
    return compiled
