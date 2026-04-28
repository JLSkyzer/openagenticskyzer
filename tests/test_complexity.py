"""Tests du détecteur de complexité — pur Python, aucun mock LLM nécessaire."""
import pytest
from openagenticskyzer.graph.complexity import analyze_complexity, ComplexityAnalysis


class TestAnalyzeComplexity:

    def test_short_greeting_is_simple(self):
        result = analyze_complexity("ok")
        assert result.mode == "simple"
        assert result.score < 15

    def test_merci_is_simple(self):
        result = analyze_complexity("merci !")
        assert result.mode == "simple"

    def test_architecture_question_is_critical(self):
        result = analyze_complexity("Comment devrais-je architecturer mon projet pour le rendre scalable ?")
        assert result.mode == "critical"
        assert result.task_type == "architecture"

    def test_refactor_is_critical(self):
        result = analyze_complexity("Refactore toute cette classe pour utiliser les design patterns appropriés")
        assert result.mode == "critical"

    def test_debug_question_is_complex_or_critical(self):
        result = analyze_complexity("Pourquoi ça crash avec cette exception: KeyError 'user_id' ?")
        assert result.mode in ("complex", "critical")
        assert result.task_type == "debug"

    def test_implement_function_is_complex_or_critical(self):
        result = analyze_complexity("Implémente une fonction de tri récursif en Python")
        assert result.mode in ("complex", "critical")
        assert result.task_type == "code"

    def test_math_question_detected(self):
        result = analyze_complexity("Calcule la complexité algorithmique O() de ce code")
        assert result.task_type == "math"

    def test_research_question_detected(self):
        result = analyze_complexity("Quelle est la différence entre REST et GraphQL ?")
        assert result.task_type == "research"

    def test_long_message_increases_score(self):
        short = analyze_complexity("fix bug")
        long = analyze_complexity("fix bug " * 20)
        assert long.score > short.score

    def test_history_increases_score(self):
        without_history = analyze_complexity("explique ce code", history_len=0)
        with_history = analyze_complexity("explique ce code", history_len=50)
        assert with_history.score > without_history.score

    def test_returns_complexity_analysis_dataclass(self):
        result = analyze_complexity("hello")
        assert isinstance(result, ComplexityAnalysis)
        assert result.mode in ("simple", "standard", "complex", "critical")
        assert isinstance(result.score, int)
        assert 0 <= result.score <= 100

    def test_code_block_increases_score(self):
        without_code = analyze_complexity("que fait cette fonction ?")
        with_code = analyze_complexity("que fait cette fonction ?\n```python\ndef foo(): pass\n```")
        assert with_code.score >= without_code.score

    def test_empty_message_returns_simple(self):
        result = analyze_complexity("")
        assert result.mode == "simple"
        assert result.score == 0

    def test_whitespace_only_returns_simple(self):
        result = analyze_complexity("   \n\t")
        assert result.mode == "simple"

    def test_none_raises_type_error(self):
        with pytest.raises(TypeError):
            analyze_complexity(None)
