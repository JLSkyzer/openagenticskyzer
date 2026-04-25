"""Tests unitaires pour openagentic_ai.utils.utils."""

import os
import pytest

from openagentic_ai.utils.utils import mode_router, parse_mentions


# ---------------------------------------------------------------------------
# mode_router
# ---------------------------------------------------------------------------

class TestModeRouter:

    def test_ask_mode_returns_string(self):
        result = mode_router("ask")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_auto_mode_returns_string(self):
        result = mode_router("auto")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_plan_mode_returns_string(self):
        result = mode_router("plan")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_ask_mode_restricts_actions(self):
        """Le mode ask interdit les modifications de fichiers et commandes."""
        result = mode_router("ask")
        lower = result.lower()
        # Doit contenir une interdiction explicite d'agir
        assert any(word in lower for word in ["not", "do not", "only", "never"])

    def test_auto_mode_allows_autonomy(self):
        """Le mode auto autorise les modifications et commandes."""
        result = mode_router("auto")
        lower = result.lower()
        assert any(word in lower for word in ["autonomously", "edit", "command", "autonomous"])

    def test_plan_mode_requires_plan_first(self):
        """Le mode plan exige un plan avant toute action."""
        result = mode_router("plan")
        lower = result.lower()
        assert "plan" in lower

    def test_modes_are_distinct(self):
        """Chaque mode retourne un texte différent."""
        ask = mode_router("ask")
        auto = mode_router("auto")
        plan = mode_router("plan")
        assert ask != auto
        assert auto != plan
        assert ask != plan

    def test_invalid_mode_raises_value_error(self):
        with pytest.raises(ValueError, match="Unknown mode"):
            mode_router("invalid")

    def test_invalid_mode_error_lists_valid_modes(self):
        with pytest.raises(ValueError) as exc_info:
            mode_router("god_mode")
        assert "ask" in str(exc_info.value)
        assert "auto" in str(exc_info.value)
        assert "plan" in str(exc_info.value)

    def test_empty_string_raises_value_error(self):
        with pytest.raises(ValueError):
            mode_router("")

    def test_case_sensitive(self):
        """Les noms de mode sont sensibles à la casse."""
        with pytest.raises(ValueError):
            mode_router("AUTO")

    @pytest.mark.parametrize("mode", ["ask", "auto", "plan"])
    def test_all_valid_modes_do_not_raise(self, mode):
        result = mode_router(mode)
        assert result


# ---------------------------------------------------------------------------
# parse_mentions
# ---------------------------------------------------------------------------

class TestParseMentions:

    def test_single_mention(self):
        result = parse_mentions("Regarde @src/main.py s'il te plaît")
        assert result == ["src/main.py"]

    def test_multiple_mentions(self):
        result = parse_mentions("Compare @foo.py et @bar.py")
        assert "foo.py" in result
        assert "bar.py" in result
        assert len(result) == 2

    def test_no_mentions(self):
        result = parse_mentions("Pas de mention ici.")
        assert result == []

    def test_mention_at_start(self):
        result = parse_mentions("@README.md est la doc")
        assert result == ["README.md"]

    def test_mention_at_end(self):
        result = parse_mentions("Lis ce fichier @config.json")
        assert result == ["config.json"]

    def test_mention_with_nested_path(self):
        result = parse_mentions("Edite @src/utils/helpers.py")
        assert result == ["src/utils/helpers.py"]

    def test_mention_with_backslash_path(self):
        result = parse_mentions(r"Ouvre @src\utils\file.py")
        assert "src" in result[0] or len(result) >= 1

    def test_mention_with_hyphen(self):
        result = parse_mentions("Regarde @my-file.py")
        assert result == ["my-file.py"]

    def test_empty_string_returns_empty(self):
        result = parse_mentions("")
        assert result == []

    def test_email_like_not_captured(self):
        """Une adresse email ne devrait pas être capturée comme mention de fichier."""
        result = parse_mentions("Contact user@example.com pour plus d'infos")
        # example.com ne correspond pas au pattern [\w./\\-]+ → pas capturé
        assert "example.com" not in result

    def test_duplicate_mentions(self):
        """Deux occurrences du même fichier retournent deux entrées."""
        result = parse_mentions("@foo.py et encore @foo.py")
        assert result.count("foo.py") == 2


# ---------------------------------------------------------------------------
# _detect_provider (tests d'environnement patchés)
# ---------------------------------------------------------------------------

class TestDetectProvider:

    def test_raises_when_no_key_set(self, monkeypatch):
        """Lève EnvironmentError si aucune clé API n'est définie."""
        for key in ["TOGETHER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
                    "GEMINI_API_KEY", "OPENROUTER_API_KEY"]:
            monkeypatch.delenv(key, raising=False)

        from openagentic_ai.utils.utils import _detect_provider
        with pytest.raises(EnvironmentError, match="No API key found"):
            _detect_provider()

    def test_detects_groq_provider(self, monkeypatch):
        for key in ["TOGETHER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
                    "GEMINI_API_KEY", "OPENROUTER_API_KEY"]:
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv("GROQ_API_KEY", "test-groq-key")

        from openagentic_ai.utils.utils import _detect_provider
        provider, api_key, model = _detect_provider()
        assert provider == "groq"
        assert api_key == "test-groq-key"
        assert isinstance(model, str)

    def test_detects_together_first(self, monkeypatch):
        """Together doit être détecté en priorité si sa clé est présente."""
        for key in ["TOGETHER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
                    "GEMINI_API_KEY", "OPENROUTER_API_KEY"]:
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv("TOGETHER_API_KEY", "together-key")
        monkeypatch.setenv("GROQ_API_KEY", "groq-key")

        from openagentic_ai.utils.utils import _detect_provider
        provider, _, _ = _detect_provider()
        assert provider == "together"

    def test_custom_model_env_var(self, monkeypatch):
        """La variable GROQ_MODEL remplace le modèle par défaut."""
        for key in ["TOGETHER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
                    "GEMINI_API_KEY", "OPENROUTER_API_KEY"]:
            monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv("GROQ_API_KEY", "my-key")
        monkeypatch.setenv("GROQ_MODEL", "custom-model-v2")

        from openagentic_ai.utils.utils import _detect_provider
        _, _, model = _detect_provider()
        assert model == "custom-model-v2"

    def test_error_message_lists_all_providers(self, monkeypatch):
        for key in ["TOGETHER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
                    "GEMINI_API_KEY", "OPENROUTER_API_KEY"]:
            monkeypatch.delenv(key, raising=False)

        from openagentic_ai.utils.utils import _detect_provider
        with pytest.raises(EnvironmentError) as exc_info:
            _detect_provider()
        msg = str(exc_info.value)
        for key in ["TOGETHER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY"]:
            assert key in msg
