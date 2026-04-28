from typing import Annotated, TypedDict

from langgraph.graph.message import add_messages
from langchain_core.messages import AnyMessage


class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    reasoning_mode: str       # "simple" | "standard" | "complex" | "critical"
    task_type: str            # "debug" | "architecture" | "code" | "math" | "research" | "general"
    reasoning_scratchpad: str # CoT interne invisible à l'utilisateur
    confidence_score: int     # 1-5 après critique
    critique_result: str      # JSON string des issues détectées
    needs_correction: bool    # True si critique demande une correction
    critique_iterations: int  # Nb de corrections effectuées (max 2)
