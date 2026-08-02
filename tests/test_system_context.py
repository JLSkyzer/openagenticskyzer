# tests/test_system_context.py
"""Tests de l'assemblage du contexte système dynamique (context/system_context.py)
et — surtout — de son arrivée effective dans l'appel au LLM.

Contexte : jusqu'au correctif, custom_prompt / mémoire / learnings étaient
préfixés à l'historique sous forme de `{"role": "system", ...}` par
`app/components/input_bar.py`, puis supprimés silencieusement par
`trim_message_history` (qui retire inconditionnellement tout SystemMessage)
avant d'atteindre le modèle. Les tests de `TestContextReachesTheLLM` échouent
contre cet ancien comportement et passent contre le nouveau : ils vérifient le
SystemMessage réellement passé à `model.invoke`.

Ces tests reprennent aussi les cas de formatage mémoire qui vivaient dans
tests/test_input_bar.py (fonction `_format_memory_injection`, supprimée de
input_bar.py avec le reste du câblage mort).
"""
import json
from pathlib import Path
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from openagenticskyzer.context.learnings import new_learning, save_learning
from openagenticskyzer.context.system_context import (
    _MAX_LEARNINGS_CHARS,
    _MAX_MEMORY_CHARS,
    _MAX_TOTAL_CHARS,
    build_context_prefix,
    build_effective_system_prompt,
    format_memory_injection,
    load_custom_prompt_block,
)
from openagenticskyzer.graph.nodes import make_agent_node


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_project_memory(folder: Path, content: str) -> None:
    (folder / ".openagent").mkdir(parents=True, exist_ok=True)
    (folder / ".openagent" / "memory.md").write_text(content, encoding="utf-8")


def _write_folder_config(folder: Path, config: dict) -> None:
    (folder / ".openagent").mkdir(parents=True, exist_ok=True)
    (folder / ".openagent" / "config.json").write_text(
        json.dumps(config), encoding="utf-8"
    )


def _capture_system_prompt(cwd, system_prompt="PROMPT STATIQUE.") -> str:
    """Construit un agent_node avec un modèle mock et retourne le contenu du
    SystemMessage réellement passé à model.invoke."""
    captured = {}

    def mock_invoke(messages, **kwargs):
        captured["messages"] = list(messages)
        return AIMessage(content="ok")

    model = MagicMock()
    model.invoke = mock_invoke

    node = make_agent_node(
        model=model,
        system_prompt=system_prompt,
        max_history=20,
        max_tokens=None,
        lmstudio_compat=False,
        cwd=str(cwd) if cwd is not None else None,
    )
    node({"messages": [HumanMessage(content="question")]})

    messages = captured["messages"]
    assert isinstance(messages[0], SystemMessage), "le 1er message doit être le SystemMessage"
    return messages[0].content


# ---------------------------------------------------------------------------
# format_memory_injection (fonction pure — ex-_format_memory_injection)
# ---------------------------------------------------------------------------

class TestFormatMemoryInjection:

    def test_both_empty_returns_empty_string(self):
        assert format_memory_injection("", "") == ""

    def test_only_global_memory(self):
        result = format_memory_injection("Style: toujours PEP8", "")
        assert "MÉMOIRE GLOBALE" in result
        assert "PEP8" in result
        assert "MÉMOIRE PROJET" not in result

    def test_only_project_memory(self):
        result = format_memory_injection("", "Architecture: microservices")
        assert "MÉMOIRE PROJET" in result
        assert "microservices" in result
        assert "MÉMOIRE GLOBALE" not in result

    def test_both_present_global_comes_first(self):
        result = format_memory_injection("Style: PEP8", "Architecture: microservices")
        assert result.index("MÉMOIRE GLOBALE") < result.index("MÉMOIRE PROJET")
        assert "PEP8" in result
        assert "microservices" in result

    def test_block_is_bracketed_by_markers(self):
        result = format_memory_injection("g", "p")
        assert result.startswith("[MÉMOIRE PERSISTANTE]")
        assert result.endswith("[FIN MÉMOIRE PERSISTANTE]")


# ---------------------------------------------------------------------------
# Caps de taille (croissance non bornée des stores append-only)
# ---------------------------------------------------------------------------

class TestSizeCaps:

    def test_oversized_global_memory_is_capped(self):
        result = format_memory_injection("g" * 50_000, "")
        assert len(result) < _MAX_MEMORY_CHARS + 500
        assert "[... début tronqué]" in result

    def test_oversized_project_memory_is_capped(self):
        result = format_memory_injection("", "p" * 50_000)
        assert len(result) < _MAX_MEMORY_CHARS + 500

    def test_each_scope_capped_independently(self):
        """Une mémoire globale démesurée n'évince pas la mémoire projet."""
        result = format_memory_injection("g" * 50_000, "FAIT PROJET UNIQUE")
        assert "FAIT PROJET UNIQUE" in result

    def test_memory_truncation_keeps_the_most_recent_entries(self):
        """memory.md est append-only : la fin (récente) doit survivre, pas le début."""
        old = "VIEUX-FAIT " + "x" * 50_000
        result = format_memory_injection("", old + "\nFAIT-RECENT")
        assert "FAIT-RECENT" in result
        assert "VIEUX-FAIT" not in result

    def test_learnings_block_is_capped(self, tmp_path):
        from openagenticskyzer.context.system_context import load_learnings_block
        for i in range(20):
            learning = new_learning(
                "error", f"ctx{i}", "m" * 500, "c" * 500,
                project_folder=str(tmp_path),
            )
            learning.confirmed = True
            save_learning(learning, project_folder=str(tmp_path))
        block = load_learnings_block(str(tmp_path))
        assert len(block) <= _MAX_LEARNINGS_CHARS + 50
        assert "[... tronqué]" in block

    def test_total_prefix_is_capped(self, tmp_path):
        """Plafond global : même avec tous les blocs saturés, le préfixe reste borné."""
        (tmp_path / "OPENAGENT.md").write_text("i" * 50_000, encoding="utf-8")
        _write_folder_config(tmp_path, {"custom_prompt": "c" * 50_000})
        _write_project_memory(tmp_path, "m" * 50_000)
        prefix = build_context_prefix(str(tmp_path))
        assert len(prefix) <= _MAX_TOTAL_CHARS + 50


# ---------------------------------------------------------------------------
# Blocs individuels
# ---------------------------------------------------------------------------

class TestCustomPromptBlock:

    def test_empty_when_no_cwd(self):
        assert load_custom_prompt_block(None) == ""

    def test_empty_when_no_config(self, tmp_path):
        assert load_custom_prompt_block(str(tmp_path)) == ""

    def test_empty_when_custom_prompt_blank(self, tmp_path):
        _write_folder_config(tmp_path, {"custom_prompt": "   "})
        assert load_custom_prompt_block(str(tmp_path)) == ""

    def test_reads_custom_prompt(self, tmp_path):
        _write_folder_config(tmp_path, {"custom_prompt": "Réponds toujours en breton."})
        block = load_custom_prompt_block(str(tmp_path))
        assert "Réponds toujours en breton." in block
        assert "[CONTEXTE PERSONNALISÉ DU DOSSIER]" in block

    def test_corrupted_config_does_not_raise(self, tmp_path):
        (tmp_path / ".openagent").mkdir(parents=True)
        (tmp_path / ".openagent" / "config.json").write_text("{pas du json", encoding="utf-8")
        assert load_custom_prompt_block(str(tmp_path)) == ""


class TestBuildEffectiveSystemPrompt:

    def test_returns_system_prompt_unchanged_when_nothing_to_inject(self, tmp_path):
        assert build_effective_system_prompt(str(tmp_path), "STATIQUE") == "STATIQUE"

    def test_cwd_none_returns_system_prompt_unchanged(self):
        assert build_effective_system_prompt(None, "STATIQUE") == "STATIQUE"

    def test_static_prompt_always_present(self, tmp_path):
        _write_project_memory(tmp_path, "un fait")
        result = build_effective_system_prompt(str(tmp_path), "STATIQUE")
        assert result.endswith("STATIQUE")
        assert "un fait" in result

    def test_block_order_is_stable(self, tmp_path):
        (tmp_path / "OPENAGENT.md").write_text("INSTRUCTION-PROJET", encoding="utf-8")
        _write_folder_config(tmp_path, {"custom_prompt": "CUSTOM-PROMPT"})
        _write_project_memory(tmp_path, "MEM-PROJET")
        result = build_effective_system_prompt(str(tmp_path), "STATIQUE")
        assert (
            result.index("INSTRUCTION-PROJET")
            < result.index("CUSTOM-PROMPT")
            < result.index("MEM-PROJET")
            < result.index("STATIQUE")
        )


# ---------------------------------------------------------------------------
# LE test central : le contexte atteint-il vraiment le LLM ?
# (échoue contre l'ancien code où tout passait par des SystemMessage
#  d'historique, supprimés par trim_message_history)
# ---------------------------------------------------------------------------

class TestContextReachesTheLLM:

    def test_project_memory_reaches_the_llm(self, tmp_path):
        _write_project_memory(tmp_path, "L'utilisateur préfère les tests pytest.")
        content = _capture_system_prompt(tmp_path)
        assert "L'utilisateur préfère les tests pytest." in content

    def test_global_memory_reaches_the_llm(self, tmp_path, _isolate_home):
        (_isolate_home / ".openagent").mkdir(parents=True, exist_ok=True)
        (_isolate_home / ".openagent" / "memory.md").write_text(
            "Préférence globale : réponses courtes.", encoding="utf-8"
        )
        content = _capture_system_prompt(tmp_path)
        assert "Préférence globale : réponses courtes." in content

    def test_custom_prompt_reaches_the_llm(self, tmp_path):
        _write_folder_config(tmp_path, {"custom_prompt": "Style maison : commentaires en anglais."})
        content = _capture_system_prompt(tmp_path)
        assert "Style maison : commentaires en anglais." in content

    def test_confirmed_learnings_reach_the_llm(self, tmp_path):
        learning = new_learning(
            "correction", "ctx",
            "Utiliser os.system", "Utiliser subprocess.run",
            project_folder=str(tmp_path),
        )
        learning.confirmed = True
        save_learning(learning, project_folder=str(tmp_path))
        content = _capture_system_prompt(tmp_path)
        assert "Utiliser subprocess.run" in content
        assert "[LEÇONS APPRISES" in content

    def test_unconfirmed_learnings_do_not_reach_the_llm(self, tmp_path):
        learning = new_learning(
            "correction", "ctx", "mauvaise-pratique", "CORRECTION-NON-CONFIRMEE",
            project_folder=str(tmp_path),
        )
        save_learning(learning, project_folder=str(tmp_path))  # confirmed=False
        content = _capture_system_prompt(tmp_path)
        assert "CORRECTION-NON-CONFIRMEE" not in content

    def test_everything_at_once_reaches_the_llm(self, tmp_path):
        (tmp_path / "OPENAGENT.md").write_text("INSTRUCTION-PROJET", encoding="utf-8")
        _write_folder_config(tmp_path, {"custom_prompt": "CUSTOM-PROMPT"})
        _write_project_memory(tmp_path, "MEM-PROJET")
        learning = new_learning("discovery", "ctx", "bad", "LEARNING-CONFIRME",
                                project_folder=str(tmp_path))
        learning.confirmed = True
        save_learning(learning, project_folder=str(tmp_path))

        content = _capture_system_prompt(tmp_path, system_prompt="PROMPT-STATIQUE")
        for expected in (
            "INSTRUCTION-PROJET", "CUSTOM-PROMPT", "MEM-PROJET",
            "LEARNING-CONFIRME", "PROMPT-STATIQUE",
        ):
            assert expected in content

    def test_still_only_one_system_message_sent(self, tmp_path):
        """Le contexte est replié dans LE prompt système, pas ajouté en messages."""
        _write_project_memory(tmp_path, "un fait")
        captured = {}

        def mock_invoke(messages, **kwargs):
            captured["messages"] = list(messages)
            return AIMessage(content="ok")

        model = MagicMock()
        model.invoke = mock_invoke
        node = make_agent_node(model=model, system_prompt="S", cwd=str(tmp_path))
        node({"messages": [
            SystemMessage(content="système parasite"),
            HumanMessage(content="q"),
        ]})

        systems = [m for m in captured["messages"] if isinstance(m, SystemMessage)]
        assert len(systems) == 1
        assert "système parasite" not in systems[0].content

    def test_unreadable_context_never_breaks_the_turn(self, tmp_path, monkeypatch):
        """Une erreur de chargement dégrade vers le prompt statique, sans crash."""
        def _boom(*a, **kw):
            raise OSError("disque en feu")

        monkeypatch.setattr(
            "openagenticskyzer.context.project_memory.load_project_memory", _boom
        )
        content = _capture_system_prompt(tmp_path, system_prompt="PROMPT-STATIQUE")
        assert "PROMPT-STATIQUE" in content
