"""Global mutable state for the GUI app (one instance per process)."""
from dataclasses import dataclass, field
from typing import Optional, Any


@dataclass
class ChatMessage:
    role: str              # 'user' | 'ai' | 'tool'
    content: str
    tool_name: Optional[str] = None
    tool_tag: Optional[str] = None
    tool_detail: Optional[str] = None
    tool_diff: Optional[str] = None
    images: list = field(default_factory=list)  # data URIs, messages utilisateur avec images


@dataclass
class DownloadEntry:
    dl_id: str        # hf_id unique
    name: str         # nom affiché
    provider: str     # 'lmstudio' | 'llamacpp'
    progress: str = "En attente…"
    done: bool = False
    error: bool = False


@dataclass
class AttachedFile:
    name: str
    content_type: str   # "text" | "image" | "pdf" | "csv"
    content: str        # texte extrait OU data URI base64 pour images
    size_kb: int


@dataclass
class AppState:
    active_folder: Optional[str] = None
    messages: list[ChatMessage] = field(default_factory=list)
    live_log: list[ChatMessage] = field(default_factory=list)
    agent_running: bool = False
    current_model: Optional[str] = None
    current_provider: Optional[str] = None
    context_pct: float = 0.0
    context_tokens: int = 0
    permission_mode: str = "demander"
    pending_permission: Any = None
    stop_requested: bool = False
    live_tokens: int = 0
    downloads: list[DownloadEntry] = field(default_factory=list)
    # Streaming
    streaming_content: str = ""
    is_streaming: bool = False
    # Fichiers attachés
    attached_files: list = field(default_factory=list)  # list[AttachedFile]


# Singleton — imported everywhere in the app
state = AppState()
