"""Export de l'historique de conversation."""
import html as _html
import json
import re as _re
from datetime import datetime
from pathlib import Path

from openagenticskyzer.app.state import state

_CODE_FENCE_RE = _re.compile(r"(```\w*\n.*?```)", _re.DOTALL)
_CODE_FENCE_PARTS_RE = _re.compile(r"```(\w*)\n(.*?)```", _re.DOTALL)


def export_markdown() -> Path:
    lines = [f"# Conversation — {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"]
    lines.append(f"Dossier : `{state.active_folder}`\n")
    lines.append(f"Modèle : `{state.current_model}` ({state.current_provider})\n\n---\n")
    for m in state.messages:
        if m.role == "user":
            lines.append(f"\n## 👤 Utilisateur\n\n{m.content}\n")
        elif m.role == "ai":
            lines.append(f"\n## 🤖 Assistant\n\n{m.content}\n")
        elif m.role == "tool":
            tag = getattr(m, "tool_tag", None) or "tool"
            tool_name = getattr(m, "tool_name", "") or ""
            lines.append(f"\n> **[{tag.upper()}]** `{tool_name}` — {m.content}\n")
    out = _out_path("md")
    out.write_text("".join(lines), encoding="utf-8", newline="\n")
    return out


def _render_ai_content(raw: str) -> str:
    """Échappe le contenu HTML d'un message AI pour l'export HTML.

    Le contenu BRUT (non échappé) est d'abord découpé en segments code/non-code
    via le fence regex, PUIS chaque segment est échappé exactement une fois.
    Bug du plan d'origine (voir tests/test_artifacts.py et tasks/lessons.md) :
    échapper tout `m.content` une première fois puis ré-échapper le groupe de
    capture du bloc de code (déjà échappé par la 1re passe) produisait un
    double-échappement (`&lt;` -> `&amp;lt;`), affiché tel quel par le
    navigateur au lieu d'être décodé en `<`. Découper AVANT d'échapper évite
    complètement le problème : chaque segment ne traverse `_html.escape`
    qu'une seule fois.
    """
    segments = _CODE_FENCE_RE.split(raw)
    parts = []
    for seg in segments:
        fence = _CODE_FENCE_PARTS_RE.match(seg)
        if fence:
            lang = fence.group(1) or ""
            code = _html.escape(fence.group(2) or "")
            parts.append(f"<pre><code class='language-{lang}'>{code}</code></pre>")
        else:
            parts.append(_html.escape(seg))
    return "".join(parts)


def export_html() -> Path:
    css = """
    body{background:#0d0d0d;color:#e0e0e0;font-family:system-ui;max-width:900px;margin:0 auto;padding:24px}
    .user{background:#1a0a2e;border-radius:12px;padding:12px 16px;margin:8px 0;text-align:right}
    .ai{background:#111;border:1px solid #222;border-radius:12px;padding:12px 16px;margin:8px 0}
    .tool{background:#0a0a1a;border-left:2px solid #4a4a8a;padding:6px 12px;margin:4px 0;font-size:.8em}
    pre{background:#1e1e2e;border-radius:8px;padding:12px;overflow-x:auto}
    code{font-family:'JetBrains Mono',monospace;font-size:.8em}
    .role{font-size:.7em;color:#666;margin-bottom:4px}
    """
    hljs = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0"
    parts = [
        "<!DOCTYPE html><html><head><meta charset='utf-8'>",
        f"<link rel='stylesheet' href='{hljs}/styles/atom-one-dark.min.css'>",
        f"<script src='{hljs}/highlight.min.js'></script>",
        f"<style>{css}</style></head><body>",
        f"<h1 style='color:#7c3aed'>Conversation — {datetime.now().strftime('%Y-%m-%d %H:%M')}</h1>",
        f"<p style='color:#666'>Modèle : <code>{state.current_model}</code></p><hr style='border-color:#222'>",
    ]
    for m in state.messages:
        if m.role == "user":
            parts.append(f"<div class='user'><div class='role'>Utilisateur</div>{_html.escape(m.content)}</div>")
        elif m.role == "ai":
            content = _render_ai_content(m.content)
            parts.append(f"<div class='ai'><div class='role'>Assistant</div>{content}</div>")
        elif m.role == "tool":
            tag = (getattr(m, "tool_tag", None) or "tool").upper()
            tool_name = getattr(m, "tool_name", "") or ""
            parts.append(f"<div class='tool'>[{tag}] <b>{_html.escape(tool_name)}</b> — {_html.escape(m.content)}</div>")
    parts.append("<script>hljs.highlightAll();</script></body></html>")
    out = _out_path("html")
    out.write_text("".join(parts), encoding="utf-8", newline="\n")
    return out


def export_json() -> Path:
    data = [
        {
            "role": m.role,
            "content": m.content,
            "tool_name": getattr(m, "tool_name", None),
            "tool_tag": getattr(m, "tool_tag", None),
            "tool_detail": getattr(m, "tool_detail", None),
        }
        for m in state.messages
    ]
    out = _out_path("json")
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")
    return out


def _out_path(ext: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    folder = state.active_folder or str(Path.home())
    return Path(folder) / f"conversation_{ts}.{ext}"
