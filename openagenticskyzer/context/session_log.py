"""Session action logger.

Appends a compact one-line entry to `agent_actions.log` in the cwd after each
tool call. The agent can read this file to know what was already done without
needing the full tool output history in context.

Format:
  [HH:MM:SS] ACTION: summary
"""

import logging
import os
from datetime import datetime

logger = logging.getLogger("openagentic.session_log")

_LOG_FILENAME = "agent_actions.log"


def _log_path() -> str:
    return os.path.join(os.getcwd(), _LOG_FILENAME)


def log_action(action: str, summary: str) -> None:
    """Append one line to agent_actions.log in cwd."""
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {action}: {summary}\n"
    try:
        with open(_log_path(), "a", encoding="utf-8") as f:
            f.write(line)
    except OSError as e:
        logger.debug("session_log write failed: %s", e)
