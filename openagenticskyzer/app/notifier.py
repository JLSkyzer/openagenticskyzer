# openagenticskyzer/app/notifier.py
"""Notifications système cross-platform pour tâches longues."""
import time

_start_time: float = 0.0
_MIN_DURATION_S = 10


def _load_config() -> dict:
    try:
        from openagenticskyzer.app.storage import load_global_config
        return load_global_config()
    except Exception:
        return {}


def _notify_os(summary: str) -> None:
    try:
        from plyer import notification
        notification.notify(
            title="OpenAgentic Skyzer",
            message=summary[:200],
            app_name="OpenAgentic Skyzer",
            timeout=6,
        )
    except Exception:
        pass


def task_started() -> None:
    global _start_time
    _start_time = time.monotonic()


def task_finished(summary: str = "Tâche terminée") -> None:
    duration = time.monotonic() - _start_time
    if duration < _MIN_DURATION_S:
        return
    cfg = _load_config()
    if not cfg.get("os_notifications", True):
        return
    _notify_os(summary)
