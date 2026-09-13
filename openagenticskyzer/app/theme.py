"""CSS variables for the selectable application themes."""
from __future__ import annotations

import json
import re

_DEFAULT_ACCENT = "#3b82f6"
_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")
_THEMES = {
    "dark": {
        "--bg": "#0f172a",
        "--surface": "#1e293b",
        "--surface2": "#334155",
        "--border": "#475569",
        "--text": "#f1f5f9",
        "--text-muted": "#94a3b8",
    },
    "light": {
        "--bg": "#f8fafc",
        "--surface": "#ffffff",
        "--surface2": "#f1f5f9",
        "--border": "#cbd5e1",
        "--text": "#0f172a",
        "--text-muted": "#64748b",
    },
}


def _safe_accent(accent: str) -> str:
    return accent if isinstance(accent, str) and _HEX_COLOR.fullmatch(accent) else _DEFAULT_ACCENT


def normalize_accent(accent: str) -> str:
    """Return a validated six-digit hex accent color."""
    return _safe_accent(accent)


def get_theme_css(theme_name: str, accent: str = _DEFAULT_ACCENT) -> str:
    """Return a complete variable block, falling back safely for bad input."""
    theme = _THEMES.get(theme_name, _THEMES["dark"])
    variables = "\n".join(f"  {name}: {value};" for name, value in theme.items())
    return f":root {{\n{variables}\n  --accent: {_safe_accent(accent)};\n}}"


def _apply_theme() -> None:
    """Apply the configured theme, replacing the prior style element in-place."""
    from nicegui import ui
    from openagenticskyzer.app.storage import load_global_config

    config = load_global_config()
    css = get_theme_css(config.get("theme", "dark"), config.get("accent_color", _DEFAULT_ACCENT))
    script = (
        "(() => {"
        "let style = document.getElementById('openagent-theme');"
        "if (!style) { style = document.createElement('style'); style.id = 'openagent-theme'; document.head.appendChild(style); }"
        f"style.textContent = {json.dumps(css)};"
        "})()"
    )
    ui.run_javascript(script)
