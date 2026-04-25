from typing import Annotated, TypedDict

from langgraph.graph.message import add_messages
from langchain_core.messages import AnyMessage


class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
