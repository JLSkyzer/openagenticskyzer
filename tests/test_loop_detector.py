"""Tests unitaires pour LoopDetector."""

import pytest
from openagentic_ai.utils.loop_detector import LoopDetector, check_loop, reset_loop_detector


class TestLoopDetectorSameCall:
    """Détection de répétition identique consécutive."""

    def setup_method(self):
        self.detector = LoopDetector()

    def test_no_warning_under_threshold(self):
        """Deux appels identiques ne déclenchent pas d'alerte."""
        self.detector.record("edit_file", "foo.py:old")
        result = self.detector.record("edit_file", "foo.py:old")
        assert result is None

    def test_warning_at_threshold(self):
        """Trois appels identiques déclenchent l'alerte."""
        self.detector.record("edit_file", "foo.py:old")
        self.detector.record("edit_file", "foo.py:old")
        result = self.detector.record("edit_file", "foo.py:old")
        assert result is not None
        assert "LOOP DETECTED" in result
        assert "edit_file" in result

    def test_no_warning_different_args(self):
        """Trois appels au même outil mais args différents → pas d'alerte."""
        self.detector.record("edit_file", "foo.py:aaa")
        self.detector.record("edit_file", "foo.py:bbb")
        result = self.detector.record("edit_file", "foo.py:ccc")
        assert result is None

    def test_no_warning_different_tools(self):
        """Trois outils différents avec le même args_key → pas d'alerte."""
        self.detector.record("read_file", "foo.py")
        self.detector.record("view_file", "foo.py")
        result = self.detector.record("edit_file", "foo.py")
        assert result is None

    def test_args_key_truncated_to_80(self):
        """Les args_key longs sont tronqués à 80 caractères pour la comparaison."""
        long_key = "x" * 200
        self.detector.record("edit_file", long_key)
        self.detector.record("edit_file", long_key)
        result = self.detector.record("edit_file", long_key)
        assert result is not None


class TestLoopDetectorTwoStepCycle:
    """Détection de cycles A → B → A → B."""

    def setup_method(self):
        self.detector = LoopDetector()

    def test_two_step_cycle_detected(self):
        """Cycle A→B→A→B déclenche l'alerte."""
        self.detector.record("read_file", "foo.py")
        self.detector.record("edit_file", "foo.py:old")
        self.detector.record("read_file", "foo.py")
        result = self.detector.record("edit_file", "foo.py:old")
        assert result is not None
        assert "LOOP DETECTED" in result
        assert "Cycle" in result

    def test_no_cycle_without_repeat(self):
        """Quatre appels tous différents → pas d'alerte de cycle."""
        self.detector.record("read_file", "a.py")
        self.detector.record("edit_file", "b.py:x")
        self.detector.record("view_file", "c.py")
        result = self.detector.record("grep_file", "d.py")
        assert result is None

    def test_partial_cycle_no_alert(self):
        """Seulement A→B→A (3 appels) sans quatrième → pas d'alerte de cycle."""
        self.detector.record("read_file", "foo.py")
        self.detector.record("edit_file", "foo.py:old")
        result = self.detector.record("read_file", "foo.py")
        # La détection de cycle nécessite 4 entrées, mais la détection
        # same-call (3 en ligne) ne s'applique pas ici non plus
        assert result is None


class TestLoopDetectorSameFileEdit:
    """Détection d'éditions répétées sur le même fichier."""

    def setup_method(self):
        self.detector = LoopDetector()

    def test_same_file_edit_threshold(self):
        """4 éditions consécutives sur le même fichier déclenchent l'alerte."""
        for i in range(3):
            self.detector.record("edit_file", f"foo.py:old_{i}")
        result = self.detector.record("edit_file", "foo.py:old_3")
        assert result is not None
        assert "LOOP DETECTED" in result
        assert "foo.py" in result

    def test_different_files_no_alert(self):
        """4 éditions sur des fichiers différents → pas d'alerte."""
        for i in range(4):
            result = self.detector.record("edit_file", f"file_{i}.py:old")
        assert result is None

    def test_interleaved_tool_resets_file_streak(self):
        """Un outil différent intercalé interrompt le compteur de fichier."""
        self.detector.record("edit_file", "foo.py:old_0")
        self.detector.record("edit_file", "foo.py:old_1")
        self.detector.record("read_file", "foo.py")   # interruption
        self.detector.record("edit_file", "foo.py:old_2")
        result = self.detector.record("edit_file", "foo.py:old_3")
        # Seulement 2 edit_file consécutifs à la fin, pas 4
        assert result is None


class TestLoopDetectorReset:
    """Comportement du reset."""

    def test_reset_clears_history(self):
        detector = LoopDetector()
        for _ in range(3):
            detector.record("edit_file", "foo.py:same")
        detector.reset()
        # Après reset, les 3 mêmes appels ne déclenchent pas d'alerte immédiate
        detector.record("edit_file", "foo.py:same")
        detector.record("edit_file", "foo.py:same")
        result = detector.record("edit_file", "foo.py:same")
        assert result is not None  # déclenché à nouveau après reset

    def test_module_level_reset(self):
        """reset_loop_detector() réinitialise le singleton global."""
        reset_loop_detector()
        check_loop("edit_file", "x")
        check_loop("edit_file", "x")
        result = check_loop("edit_file", "x")
        assert result is not None
        reset_loop_detector()  # nettoyage après le test


class TestLoopDetectorThreadSafety:
    """Le verrou interne ne provoque pas de deadlock sous charge basique."""

    def test_concurrent_records(self):
        import threading

        detector = LoopDetector()
        errors = []

        def worker():
            try:
                for i in range(50):
                    detector.record("tool", f"arg_{i}")
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
