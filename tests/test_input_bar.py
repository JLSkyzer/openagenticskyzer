# tests/test_input_bar.py
"""Tests de la logique pure de formatage pour l'injection mémoire (Task 3).

`_send_message` lui-même est fortement couplé à l'état NiceGUI (ui.notify,
input_el, chat_messages.refresh, etc.) et n'est pas raisonnablement testable
en isolation sans un harnais UI complet. La logique de formatage a donc été
extraite dans `_format_memory_injection`, une fonction pure, spécifiquement
pour la rendre testable — voir openagenticskyzer/app/components/input_bar.py.
"""
from openagenticskyzer.app.components.input_bar import _format_memory_injection


class TestFormatMemoryInjection:
    def test_both_empty_returns_empty_string(self):
        assert _format_memory_injection("", "") == ""

    def test_only_global_memory(self):
        result = _format_memory_injection("Style: toujours PEP8", "")
        assert "MÉMOIRE GLOBALE" in result
        assert "PEP8" in result
        assert "MÉMOIRE PROJET" not in result

    def test_only_project_memory(self):
        result = _format_memory_injection("", "Architecture: microservices")
        assert "MÉMOIRE PROJET" in result
        assert "microservices" in result
        assert "MÉMOIRE GLOBALE" not in result

    def test_both_present_global_comes_first(self):
        result = _format_memory_injection("Style: PEP8", "Architecture: microservices")
        assert result.index("MÉMOIRE GLOBALE") < result.index("MÉMOIRE PROJET")
        assert "PEP8" in result
        assert "microservices" in result
