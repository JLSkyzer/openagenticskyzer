"""Read/write per-project provider settings without touching global secrets."""
from __future__ import annotations

import os
from pathlib import Path

PROVIDERS = {
    "openrouter": ("OPENROUTER_API_KEY", "OPENROUTER_MODEL"),
    "groq": ("GROQ_API_KEY", "GROQ_MODEL"),
    "together": ("TOGETHER_API_KEY", "TOGETHER_MODEL"),
    "mistral": ("MISTRAL_API_KEY", "MISTRAL_MODEL"),
    "gemini": ("GEMINI_API_KEY", "GEMINI_MODEL"),
    "ollama": ("", "OLLAMA_MODEL"),
}

def _env_path(folder: str) -> Path:
    return Path(folder) / ".env"

def load_project_settings(folder: str | None) -> dict[str, str]:
    if not folder:
        return {"provider": "", "api_key": "", "model": "", "base_url": ""}
    values: dict[str, str] = {}
    path = _env_path(folder)
    if path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                raw = line.strip()
                if not raw or raw.startswith("#") or "=" not in raw:
                    continue
                key, value = raw.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
        except OSError:
            pass
    provider = next((name for name, (key, _) in PROVIDERS.items() if key and values.get(key) or key and os.environ.get(key)), "")
    api_key_name, model_name = PROVIDERS.get(provider, ("", ""))
    return {
        "provider": provider,
        "api_key": values.get(api_key_name, os.environ.get(api_key_name, "")) if api_key_name else "",
        "model": values.get(model_name, os.environ.get(model_name, "")) if model_name else "",
        "base_url": values.get("OPENAI_BASE_URL", ""),
    }

def save_project_settings(folder: str, settings: dict[str, str]) -> None:
    path = _env_path(folder)
    existing: dict[str, str] = {}
    if path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                raw = line.strip()
                if raw and not raw.startswith("#") and "=" in raw:
                    key, value = raw.split("=", 1); existing[key.strip()] = value.strip()
        except OSError:
            pass
    provider = settings.get("provider", "").lower()
    api_key_name, model_name = PROVIDERS.get(provider, ("", ""))
    for name, value in ((api_key_name, settings.get("api_key", "")), (model_name, settings.get("model", "")), ("OPENAI_BASE_URL", settings.get("base_url", ""))):
        if name and value:
            existing[name] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(f"{key}={value}" for key, value in existing.items()) + "\n", encoding="utf-8", newline="\n")
