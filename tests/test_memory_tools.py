# tests/test_memory_tools.py
"""Tests des outils mémoire de l'agent (save_memory, read_memory, forget_memory)."""
from unittest.mock import patch


def _with_folder(folder):
    """Patch state.active_folder — même pattern que test_git_tools.py."""
    return patch("openagenticskyzer.app.state.state.active_folder", folder)


def _with_global_memory_path(tmp_path):
    """Redirige la mémoire globale vers un fichier temporaire, pour ne
    jamais toucher le vrai ~/.openagent/memory.md pendant les tests."""
    return patch(
        "openagenticskyzer.context.project_memory._global_memory_path",
        lambda: tmp_path / "global_memory.md",
    )


class TestSaveMemory:
    def test_saves_to_project_scope_by_default(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import save_memory
        from openagenticskyzer.context.project_memory import load_project_memory

        with _with_folder(str(tmp_path)):
            result = save_memory.invoke({"facts": "Le projet utilise PostgreSQL"})

        assert "Mémorisé" in result
        assert str(tmp_path) in result
        assert "PostgreSQL" in load_project_memory(str(tmp_path))

    def test_saves_to_global_scope(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import save_memory
        from openagenticskyzer.context.project_memory import load_global_memory

        with _with_global_memory_path(tmp_path):
            result = save_memory.invoke({"facts": "Toujours utiliser PEP8", "scope": "global"})
            assert "globale" in result
            assert "PEP8" in load_global_memory()

    def test_no_active_folder_returns_error_message(self):
        from openagenticskyzer.tools.memory_tools import save_memory

        with _with_folder(None):
            result = save_memory.invoke({"facts": "Un fait quelconque"})

        assert "Aucun dossier actif" in result

    def test_blank_facts_are_a_noop_and_do_not_crash(self, tmp_path):
        """append_to_project_memory no-ops on blank input (Task 1 behavior) —
        save_memory must not error out when the agent passes empty facts."""
        from openagenticskyzer.tools.memory_tools import save_memory
        from openagenticskyzer.context.project_memory import load_project_memory

        with _with_folder(str(tmp_path)):
            result = save_memory.invoke({"facts": "   "})

        assert "Mémorisé" in result  # tool still reports success to the LLM
        assert load_project_memory(str(tmp_path)) == ""


class TestReadMemory:
    def test_empty_when_nothing_saved(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import read_memory

        with _with_folder(str(tmp_path)), _with_global_memory_path(tmp_path):
            result = read_memory.invoke({})

        assert result == "La mémoire est vide."

    def test_reads_project_memory_only(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import read_memory
        from openagenticskyzer.context.project_memory import append_to_project_memory

        append_to_project_memory(str(tmp_path), "Architecture microservices")
        with _with_folder(str(tmp_path)), _with_global_memory_path(tmp_path):
            result = read_memory.invoke({})

        assert "Architecture microservices" in result
        assert "[Mémoire projet]" in result
        assert "[Mémoire globale]" not in result

    def test_reads_global_memory_only(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import read_memory
        from openagenticskyzer.context.project_memory import append_to_global_memory

        with _with_folder(None), _with_global_memory_path(tmp_path):
            append_to_global_memory("Style: toujours PEP8")
            result = read_memory.invoke({})

        assert "PEP8" in result
        assert "[Mémoire globale]" in result
        assert "[Mémoire projet]" not in result

    def test_reads_both_project_and_global_memory(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import read_memory
        from openagenticskyzer.context.project_memory import (
            append_to_project_memory, append_to_global_memory,
        )

        with _with_global_memory_path(tmp_path):
            append_to_global_memory("Style: toujours PEP8")
            append_to_project_memory(str(tmp_path), "Architecture microservices")
            with _with_folder(str(tmp_path)):
                result = read_memory.invoke({})

        assert "PEP8" in result
        assert "microservices" in result
        assert "[Mémoire globale]" in result
        assert "[Mémoire projet]" in result


class TestForgetMemory:
    def test_no_active_folder_returns_error_message(self):
        from openagenticskyzer.tools.memory_tools import forget_memory

        with _with_folder(None):
            result = forget_memory.invoke({"keyword": "PostgreSQL"})

        assert "Aucun dossier actif" in result

    def test_removes_entry_matching_keyword(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import forget_memory
        from openagenticskyzer.context.project_memory import (
            append_to_project_memory, load_project_memory,
        )

        append_to_project_memory(str(tmp_path), "Le projet utilise PostgreSQL")
        append_to_project_memory(str(tmp_path), "Le style de code suit PEP8")

        with _with_folder(str(tmp_path)):
            result = forget_memory.invoke({"keyword": "PostgreSQL"})

        assert "PostgreSQL" in result
        mem = load_project_memory(str(tmp_path))
        assert "PostgreSQL" not in mem
        assert "PEP8" in mem

    def test_keyword_match_is_case_insensitive(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import forget_memory
        from openagenticskyzer.context.project_memory import (
            append_to_project_memory, load_project_memory,
        )

        append_to_project_memory(str(tmp_path), "Utilise POSTGRESQL en prod")

        with _with_folder(str(tmp_path)):
            forget_memory.invoke({"keyword": "postgresql"})

        assert "POSTGRESQL" not in load_project_memory(str(tmp_path))

    def test_multiline_entry_removed_as_a_whole_no_orphaned_fragments(self, tmp_path):
        """Regression test: a naive per-line keyword filter (as suggested by
        the plan) would leave the timestamp header orphaned, or leave
        non-matching lines of the same fact behind as dangling fragments,
        when only some lines of a multi-line entry contain the keyword.
        forget_memory must remove the whole timestamped entry instead."""
        from openagenticskyzer.tools.memory_tools import forget_memory
        from openagenticskyzer.context.project_memory import (
            append_to_project_memory, load_project_memory,
        )

        append_to_project_memory(
            str(tmp_path),
            "Décision d'architecture:\nUtilise PostgreSQL comme base principale\n"
            "Justification: support JSONB natif",
        )
        append_to_project_memory(str(tmp_path), "Le style de code suit PEP8")

        with _with_folder(str(tmp_path)):
            forget_memory.invoke({"keyword": "PostgreSQL"})

        mem = load_project_memory(str(tmp_path))
        assert "PostgreSQL" not in mem
        assert "JSONB" not in mem  # whole entry gone, not just the matching line
        assert "Décision d'architecture" not in mem  # header line of the same entry gone too
        assert "PEP8" in mem
        # No leftover orphaned timestamp comment for the removed entry.
        import re
        assert len(re.findall(r"<!--\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*-->", mem)) == 1

    def test_no_match_keeps_memory_untouched(self, tmp_path):
        from openagenticskyzer.tools.memory_tools import forget_memory
        from openagenticskyzer.context.project_memory import (
            append_to_project_memory, load_project_memory,
        )

        append_to_project_memory(str(tmp_path), "Le style de code suit PEP8")
        before = load_project_memory(str(tmp_path))

        with _with_folder(str(tmp_path)):
            forget_memory.invoke({"keyword": "nonexistent"})

        assert load_project_memory(str(tmp_path)) == before
