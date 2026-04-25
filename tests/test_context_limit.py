# tests/test_context_limit.py
import subprocess
from unittest.mock import patch
from openagentic_ai.utils.utils import _DEFAULT_CTX_LIMITS, get_available_ollama_models

def test_ctx_limits_has_all_providers():
    expected = {"together", "groq", "mistral", "gemini", "openrouter", "ollama"}
    assert set(_DEFAULT_CTX_LIMITS.keys()) == expected

def test_ctx_limits_values_are_positive_ints():
    for provider, limit in _DEFAULT_CTX_LIMITS.items():
        assert isinstance(limit, int) and limit > 0, f"{provider} has invalid limit {limit}"

def test_get_ollama_models_parses_output():
    fake_output = (
        "NAME                    ID              SIZE    MODIFIED\n"
        "qwen2.5-coder:latest    7b5d3d28e851    4.7 GB  2 hours ago\n"
        "mistral:latest          f974a74358d6    4.1 GB  3 days ago\n"
    )
    with patch("subprocess.run") as mock_run:
        mock_run.return_value.stdout = fake_output
        mock_run.return_value.returncode = 0
        models = get_available_ollama_models()
    assert models == ["qwen2.5-coder:latest", "mistral:latest"]

def test_get_ollama_models_returns_empty_when_not_installed():
    with patch("subprocess.run", side_effect=FileNotFoundError):
        models = get_available_ollama_models()
    assert models == []

from langchain_core.messages import HumanMessage, AIMessage
from openagentic_ai.context.messages import trim_message_history

def test_trim_respects_max_tokens():
    # ~250 chars each ≈ 62 tokens each
    long_content = "x" * 250
    messages = [HumanMessage(content=long_content) for _ in range(10)]
    # Limit to ~100 tokens → should keep only 1-2 messages
    result = trim_message_history(messages, max_messages=20, max_tokens=100)
    total_chars = sum(len(m.content) for m in result)
    assert total_chars <= 400  # 100 tokens * 4 chars/token

def test_trim_none_max_tokens_uses_message_count():
    messages = [HumanMessage(content="hello") for _ in range(30)]
    result = trim_message_history(messages, max_messages=10, max_tokens=None)
    assert len(result) == 10
