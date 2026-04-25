import threading
from collections import deque

_SAME_CALL_THRESHOLD = 3  # same exact call N times in a row → warn
_CYCLE_WINDOW = 6          # look back N entries to detect 2-step cycles
_SAME_FILE_EDIT_THRESHOLD = 4  # same file edited N times without other files → warn


class LoopDetector:
    """Detects when the agent is calling the same tool in a loop and returns
    a warning message so the LLM is forced to change approach."""

    def __init__(self):
        self._history: deque[str] = deque(maxlen=_CYCLE_WINDOW)
        self._lock = threading.Lock()

    def record(self, tool_name: str, args_key: str) -> str | None:
        """Record a tool call.

        Returns a warning string if a loop is detected, otherwise None.
        ``args_key`` should be a short, stable representation of the arguments
        (e.g. ``f"{path}:{old_string[:60]}"``).
        """
        key = f"{tool_name}|{args_key[:80]}"
        with self._lock:
            self._history.append(key)
            history = list(self._history)

        n = len(history)

        # Same call repeated N times in a row
        if n >= _SAME_CALL_THRESHOLD:
            recent = history[-_SAME_CALL_THRESHOLD:]
            if len(set(recent)) == 1:
                return (
                    f"LOOP DETECTED: `{tool_name}` was called {_SAME_CALL_THRESHOLD} times "
                    f"in a row with identical arguments. "
                    f"Do NOT retry. Try a completely different approach: "
                    f"use view() to read the exact file content, then retry with the correct text."
                )

        # Repeating 2-step cycle: A → B → A → B
        if n >= 4:
            if history[-1] == history[-3] and history[-2] == history[-4]:
                a = history[-2].split("|")[0]
                b = history[-1].split("|")[0]
                return (
                    f"LOOP DETECTED: Cycle [{a} → {b}] is repeating. "
                    f"Stop and try a fundamentally different approach."
                )

        # Same file edited too many times — agent is stuck on one file
        if tool_name == "edit_file" and n >= _SAME_FILE_EDIT_THRESHOLD:
            recent = history[-_SAME_FILE_EDIT_THRESHOLD:]
            files = [e.split("|")[1].split(":")[0] for e in recent]
            if len(set(files)) == 1:
                return (
                    f"LOOP DETECTED: `{files[0]}` has been edited {_SAME_FILE_EDIT_THRESHOLD} times "
                    f"in a row without resolving the issue. "
                    f"Read the FULL file first, identify ALL errors at once, "
                    f"then rewrite the entire file with create_file instead of patching it."
                )

        return None

    def reset(self) -> None:
        with self._lock:
            self._history.clear()


# Module-level singleton — shared across all tools in the same process
_detector = LoopDetector()


def check_loop(tool_name: str, args_key: str) -> str | None:
    """Return a warning message if a loop is detected, otherwise None."""
    return _detector.record(tool_name, args_key)


def reset_loop_detector() -> None:
    """Reset the detector (e.g. at the start of a new agent run)."""
    _detector.reset()
