"""Session persistence — save and resume agent conversations.

Sessions are stored as JSON files in ~/.openagentic/sessions/.
Each file contains the full serialized message history + metadata.

CLI usage (wired in agent.py):
  --save-session          print session ID after run (auto-saved)
  --resume SESSION_ID     reload a previous session's messages as context
  --list-sessions         print all saved sessions and exit

The messages are injected as the initial state on resume, giving the agent
full context from the previous run without any LangGraph checkpointer tricks.
"""

import json
import logging
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_core.messages import AnyMessage, messages_from_dict, messages_to_dict

logger = logging.getLogger("openagentic.persistence")


def _sessions_dir() -> Path:
    base = Path(os.environ.get("OPENAGENTIC_DATA_DIR", Path.home() / ".openagentic"))
    d = base / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class SessionMeta:
    session_id: str
    created_at: str
    updated_at: str
    turn_count: int
    message_count: int
    cwd: str
    tags: list[str] = field(default_factory=list)


class PersistenceManager:
    def __init__(self):
        self.sessions_dir = _sessions_dir()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def new_session_id(self) -> str:
        return uuid.uuid4().hex[:10]

    def save(
        self,
        session_id: str,
        messages: list[AnyMessage],
        turn_count: int = 0,
        cwd: str = "",
    ) -> Path:
        """Serialize messages to JSON and write to disk."""
        now = datetime.now().isoformat()
        path = self.sessions_dir / f"{session_id}.json"

        # Load existing metadata to preserve created_at
        created_at = now
        if path.exists():
            try:
                with open(path, encoding="utf-8") as f:
                    existing = json.load(f)
                created_at = existing.get("created_at", now)
            except Exception:
                pass

        data: dict[str, Any] = {
            "session_id": session_id,
            "created_at": created_at,
            "updated_at": now,
            "turn_count": turn_count,
            "cwd": cwd or os.getcwd(),
            "messages": messages_to_dict(messages),
        }

        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        logger.info(
            "Session saved: %s (%d messages) → %s", session_id, len(messages), path
        )
        return path

    def load(self, session_id: str) -> tuple[list[AnyMessage], dict[str, Any]]:
        """Load messages from a saved session. Returns (messages, meta_dict)."""
        path = self._find(session_id)
        if path is None:
            raise FileNotFoundError(
                f"Session '{session_id}' not found in {self.sessions_dir}"
            )

        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        messages = messages_from_dict(data["messages"])
        meta = {k: v for k, v in data.items() if k != "messages"}
        logger.info(
            "Session loaded: %s (%d messages, saved %s)",
            session_id,
            len(messages),
            meta.get("updated_at", "?"),
        )
        return messages, meta

    def list_sessions(self) -> list[dict[str, Any]]:
        """Return metadata for all saved sessions, newest first."""
        sessions = []
        for path in self.sessions_dir.glob("*.json"):
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
                sessions.append(
                    {
                        "session_id": data["session_id"],
                        "created_at": data.get("created_at", "?"),
                        "updated_at": data.get("updated_at", "?"),
                        "turn_count": data.get("turn_count", 0),
                        "message_count": len(data.get("messages", [])),
                        "cwd": data.get("cwd", "?"),
                    }
                )
            except Exception as exc:
                logger.warning("Could not read session file %s: %s", path, exc)

        sessions.sort(key=lambda s: s["updated_at"], reverse=True)
        return sessions

    def print_sessions(self) -> None:
        """Pretty-print all sessions to stdout."""
        sessions = self.list_sessions()
        if not sessions:
            print("No saved sessions found.")
            return

        print(f"\n{'ID':12}  {'Updated':20}  {'Turns':>5}  {'Msgs':>5}  CWD")
        print("-" * 72)
        for s in sessions:
            updated = s["updated_at"][:19].replace("T", " ")
            cwd = s["cwd"]
            if len(cwd) > 30:
                cwd = "…" + cwd[-29:]
            print(
                f"{s['session_id']:12}  {updated:20}  {s['turn_count']:>5}  "
                f"{s['message_count']:>5}  {cwd}"
            )
        print()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _find(self, session_id: str) -> Path | None:
        """Find session file by exact ID or unambiguous prefix."""
        exact = self.sessions_dir / f"{session_id}.json"
        if exact.exists():
            return exact

        # Prefix match
        matches = list(self.sessions_dir.glob(f"{session_id}*.json"))
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            ids = ", ".join(p.stem for p in matches)
            raise ValueError(f"Ambiguous session prefix '{session_id}': {ids}")
        return None
