import re
import os
import logging
from typing import Any
from dotenv import load_dotenv, find_dotenv
from langchain_core.callbacks import BaseCallbackHandler

# usecwd=True ensures we search from where the user runs the command,
# not from this file's location in the installed package.
load_dotenv(find_dotenv(usecwd=True) or find_dotenv())

logger = logging.getLogger("openagent.context")

_SHOW_CONTEXT = os.environ.get("OPENCODE_SHOW_CONTEXT", "0") == "1"


class ContextLoggerCallback(BaseCallbackHandler):
    """Logs the full context sent to the LLM at each call so you can see
    exactly what tokens are being consumed.
    Set OPENCODE_SHOW_CONTEXT=1 to enable."""

    call_index = 0

    def on_llm_start(self, serialized: dict, prompts: list, **kwargs: Any) -> None:
        if not _SHOW_CONTEXT:
            return
        ContextLoggerCallback.call_index += 1
        idx = ContextLoggerCallback.call_index
        messages = kwargs.get("messages", [])
        if not messages:
            total_chars = sum(len(p) for p in prompts)
            logger.info("── LLM call #%d ── %d chars (~%d tokens) ──",
                        idx, total_chars, total_chars // 4)
            return

        total_chars = 0
        lines = [f"\n{'─'*60}", f"  LLM call #{idx}"]
        for msg_list in messages:
            for msg in msg_list:
                role = getattr(msg, "type", type(msg).__name__)
                content = getattr(msg, "content", "") or ""
                if isinstance(content, list):
                    content = " ".join(
                        c.get("text", "") if isinstance(c, dict) else str(c)
                        for c in content
                    )
                chars = len(content)
                total_chars += chars
                preview = content[:200].replace("\n", "↵")
                if len(content) > 200:
                    preview += f"... (+{chars - 200} chars)"
                lines.append(f"  [{role:10s}] {chars:6d} chars | {preview}")
        lines.append(f"  TOTAL: {total_chars} chars (~{total_chars // 4} tokens)")
        lines.append("─" * 60)
        logger.info("\n".join(lines))


def parse_mentions(text: str) -> list[str]:
    """Parser les mentions @ du user pour sélectionner les fichiers qu'il mentionne."""
    return re.findall(r"@([\w./\\-]+)", text)


def mode_router(mode: str) -> str:
    """Retourne le system prompt additionnel selon le mode ask/auto/plan choisi par le user."""
    modes = {
        "ask": "Only answer questions and explain. Do NOT modify any files or run any commands.",
        "auto": "Work autonomously: plan, edit files, and run commands as needed to complete the task.",
        "plan": "First produce a detailed step-by-step plan and wait for user approval before doing anything.",
    }
    if mode not in modes:
        raise ValueError(f"Unknown mode '{mode}'. Choose from: {list(modes.keys())}")
    return modes[mode]


# ---------------------------------------------------------------------------
# Provider detection — first matching key wins
# ---------------------------------------------------------------------------

_PROVIDERS = [
    ("TOGETHER_API_KEY",    "together"),
    ("GROQ_API_KEY",        "groq"),
    ("MISTRAL_API_KEY",     "mistral"),
    ("GEMINI_API_KEY",      "gemini"),
    ("OPENROUTER_API_KEY",  "openrouter"),
]

_DEFAULT_MODELS = {
    "together":   "Qwen/Qwen3-Coder-Next-FP8",
    "groq":       "moonshotai/kimi-k2-instruct",
    "mistral":    "codestral-latest",
    "gemini":     "gemini-2.5-pro-preview-03-25",
    "openrouter": "kwaipilot/kat-coder-pro-v2",
    "ollama":     "qwen2.5-coder",
}


def _detect_provider() -> tuple[str, str, str]:
    """Return (provider, api_key, model). Raises if no key found."""
    for env_key, provider in _PROVIDERS:
        api_key = os.environ.get(env_key, "").strip()
        if api_key:
            model_env = f"{provider.upper()}_MODEL"
            model = os.environ.get(model_env, _DEFAULT_MODELS[provider])
            logger.info("Provider: %s | Model: %s", provider, model)
            return provider, api_key, model

    # Ollama is local — no API key required, triggered by OLLAMA_MODEL
    ollama_model = os.environ.get("OLLAMA_MODEL", "").strip()
    if ollama_model:
        model = ollama_model
        logger.info("Provider: ollama | Model: %s", model)
        return "ollama", "local", model

    keys = ", ".join(k for k, _ in _PROVIDERS)
    raise EnvironmentError(
        f"No API key found. Set one of: {keys} in your .env file.\n"
        "Together:   https://api.together.xyz/settings/api-keys\n"
        "Groq:       https://console.groq.com/keys\n"
        "Mistral:    https://console.mistral.ai/api-keys\n"
        "Gemini:     https://aistudio.google.com/app/apikey\n"
        "OpenRouter: https://openrouter.ai/settings/keys\n"
        "Ollama:     set OLLAMA_MODEL=<model-name> (e.g. qwen2.5-coder) — no API key needed"
    )


def get_langfuse_handler():
    """Return a LangfuseCallbackHandler if keys are set, else None."""
    if not (os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")):
        return None
    try:
        from langfuse.langchain import CallbackHandler as LangfuseCallbackHandler
        return LangfuseCallbackHandler()
    except Exception:
        return None


_PROVIDER_EXTRAS = {
    "together":   "pip install openagenticskyzer[together]",
    "groq":       "pip install openagenticskyzer[groq]",
    "mistral":    "pip install openagenticskyzer[mistral]",
    "gemini":     "pip install openagenticskyzer[gemini]",
    "openrouter": "pip install openagenticskyzer[openrouter]",
    "ollama":     "pip install openagenticskyzer[ollama]",
}


def _missing_provider(provider: str) -> ModuleNotFoundError:
    cmd = _PROVIDER_EXTRAS.get(provider, f"pip install openagenticskyzer[{provider}]")
    return ModuleNotFoundError(
        f"\nProvider '{provider}' is not installed.\n"
        f"Run: {cmd}\n"
    )


def get_llm():
    provider, api_key, model = _detect_provider()
    callbacks = [ContextLoggerCallback()]

    llm: Any

    if provider == "together":
        try:
            from langchain_together import ChatTogether  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("together")
        # langchain_together initializes an openai.OpenAI client internally which
        # requires OPENAI_API_KEY — set it from the Together key as a workaround.
        os.environ.setdefault("OPENAI_API_KEY", api_key)
        llm = ChatTogether(**dict(  # type: ignore[arg-type]
            model=model,
            together_api_key=api_key,
            max_tokens=16_384,
            streaming=True,
            callbacks=callbacks,
        ))

    elif provider == "groq":
        try:
            from langchain_groq import ChatGroq  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("groq")
        llm = ChatGroq(**dict(  # type: ignore[arg-type]
            model=model,
            groq_api_key=api_key,
            max_tokens=8_192,
            streaming=True,
            callbacks=callbacks,
        ))

    elif provider == "mistral":
        try:
            from langchain_mistralai import ChatMistralAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("mistral")
        from pydantic import SecretStr
        llm = ChatMistralAI(  # type: ignore[call-arg]
            model_name=model,
            api_key=SecretStr(api_key),
            max_tokens=16_384,
            streaming=True,
        )
        llm.callbacks = callbacks  # type: ignore[assignment]

    elif provider == "gemini":
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("gemini")
        llm = ChatGoogleGenerativeAI(  # type: ignore[call-arg]
            model=model,
            google_api_key=api_key,
            max_output_tokens=16_384,
            streaming=True,
            callbacks=callbacks,
        )

    elif provider == "openrouter":
        try:
            from langchain_openai import ChatOpenAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("openrouter")
        site_url = os.environ.get("OPENROUTER_SITE_URL", "")
        site_name = os.environ.get("OPENROUTER_SITE_NAME", "")
        extra_headers: dict[str, str] = {}
        if site_url:
            extra_headers["HTTP-Referer"] = site_url
        if site_name:
            extra_headers["X-Title"] = site_name
        openrouter_kwargs: dict[str, Any] = dict(
            model=model,
            api_key=api_key,
            base_url="https://openrouter.ai/api/v1",
            max_completion_tokens=16_384,
            streaming=True,
            callbacks=callbacks,
        )
        if extra_headers:
            openrouter_kwargs["default_headers"] = extra_headers
        llm = ChatOpenAI(**openrouter_kwargs)  # type: ignore[arg-type]

    elif provider == "ollama":
        try:
            from langchain_ollama import ChatOllama  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("ollama")
        base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
        llm = ChatOllama(  # type: ignore[call-arg]
            model=model,
            base_url=base_url,
            streaming=True,
            callbacks=callbacks,
        )

    else:
        raise EnvironmentError(f"Unknown provider: {provider}")

    return llm
