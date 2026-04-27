"""Outil de fetch d'URL pour lire le contenu complet d'une page web."""
import html as _html
import re
import urllib.request
from typing import Any, Dict

from langchain_core.tools import tool

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
}
_MAX_CHARS = 4000


def _strip_html(raw: str) -> str:
    """Supprime les balises HTML et retourne du texte propre."""
    # Blocs script/style entiers
    raw = re.sub(r"<(script|style|nav|footer|header)[^>]*>.*?</(script|style|nav|footer|header)>",
                 " ", raw, flags=re.DOTALL | re.IGNORECASE)
    # Balises restantes
    raw = re.sub(r"<[^>]+>", " ", raw)
    # Entités HTML
    raw = _html.unescape(raw)
    # Espaces multiples / sauts de ligne
    raw = re.sub(r"[ \t]+", " ", raw)
    raw = re.sub(r"\n{3,}", "\n\n", raw)
    return raw.strip()


def _extract_title(raw: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", raw, re.IGNORECASE | re.DOTALL)
    if m:
        return _html.unescape(m.group(1).strip())
    return ""


@tool
def fetch_url(url: str, max_chars: int = _MAX_CHARS) -> Dict[str, Any]:
    """Fetch the full text content of a web page.
    Use after internet_search to read the most relevant URLs and get complete, accurate information.
    Returns: title, url, content (plain text or markdown, up to max_chars characters).
    Prefer Wikipedia, official sites, or reputable news sources."""
    try:
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if "text" not in content_type and "html" not in content_type:
                return {"error": f"Type de contenu non textuel : {content_type}", "url": url}
            raw = resp.read(500_000).decode("utf-8", errors="replace")
    except Exception as exc:
        return {"error": str(exc), "url": url}

    title = _extract_title(raw)
    text = _strip_html(raw)
    if len(text) > max_chars:
        text = text[:max_chars] + "…"

    return {"url": url, "title": title, "content": text, "chars": len(text), "provider": "direct"}
