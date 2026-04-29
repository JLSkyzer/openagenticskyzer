# tests/test_notifier.py
import time
from unittest.mock import patch
from openagenticskyzer.app.notifier import task_started, task_finished


class TestNotifier:

    def test_no_notification_for_short_task(self):
        """Tâche < 10s → pas de notification."""
        task_started()
        with patch("openagenticskyzer.app.notifier._notify_os") as mock_notify:
            task_finished("Terminé")
        mock_notify.assert_not_called()

    def test_notification_disabled_in_config(self):
        """Si os_notifications=False en config → pas de notification même pour tâche longue."""
        with patch("openagenticskyzer.app.notifier._start_time", time.monotonic() - 15), \
             patch("openagenticskyzer.app.notifier._load_config", return_value={"os_notifications": False}):
            with patch("openagenticskyzer.app.notifier._notify_os") as mock_notify:
                task_finished("Terminé")
        mock_notify.assert_not_called()

    def test_task_started_sets_start_time(self):
        """task_started() doit enregistrer le temps de début."""
        import openagenticskyzer.app.notifier as n
        task_started()
        assert n._start_time > 0
