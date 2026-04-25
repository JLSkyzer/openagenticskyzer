"""LangGraph node implementations."""

import logging

from langchain_core.messages import SystemMessage
from langgraph.graph import END

from openagentic_ai.context.messages import clean_messages, trim_message_history
from openagentic_ai.graph.state import AgentState

logger = logging.getLogger("openagentic.nodes")


def make_agent_node(model, system_prompt: str, max_history: int = 20, max_tokens: int | None = None):
    """Return an agent node closure bound to the given model and system prompt.

    Before each LLM call:
    - Trims history to last max_history messages and max_tokens
    - Cleans LLM metadata bloat from additional_kwargs
    - Prepends the system prompt fresh
    """
    def agent_node(state: AgentState) -> dict:
        messages = state["messages"]

        trimmed = trim_message_history(messages, max_messages=max_history, max_tokens=max_tokens)
        trimmed = clean_messages(trimmed)

        full_context = [SystemMessage(content=system_prompt)] + trimmed

        logger.info(
            "LLM call — history: %d msgs (trimmed from %d)",
            len(trimmed), len(messages),
        )

        response = model.invoke(full_context)
        return {"messages": [response]}

    return agent_node


def route_after_agent(state: AgentState) -> str:
    """Route to tools if the last AI message has tool calls, otherwise end."""
    last = state["messages"][-1]
    if getattr(last, "tool_calls", None):
        return "tools"
    return END
