"""Global mutable state for the GUI app (one instance per process)."""
from dataclasses import dataclass, field
from typing import Optional, Any


@dataclass
class ChatMessage:
    role: str              # 'user' | 'ai' | 'tool'
    content: str
    tool_name: Optional[str] = None   # e.g. 'run_command'
    tool_tag: Optional[str] = None    # 'run' | 'write' | 'read' | 'search'
    tool_detail: Optional[str] = None # file path or command
    tool_diff: Optional[str] = None   # short diff for write ops


@dataclass
class AppState:
    active_folder: Optional[str] = None
    messages: list[ChatMessage] = field(default_factory=list)
    agent_running: bool = False
    current_model: Optional[str] = None
    current_provider: Optional[str] = None
    context_pct: float = 0.0
    context_tokens: int = 0
    permission_mode: str = "demander"
    pending_permission: Any = None   # PermissionRequest | None


# Singleton — imported everywhere in the app
state = AppState()
