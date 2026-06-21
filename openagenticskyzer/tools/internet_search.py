import os
from typing import Any, Dict, Literal

from langchain_core.tools import tool


def _search_duckduckgo(query: str, max_results: int, topic: str) -> Dict[str, Any]:
    import time
    try:
        from ddgs import DDGS
    except ImportError:
        try:
            from duckduckgo_search import DDGS  # type: ignore[no-redef]
        except ImportError:
            return {"error": "ddgs not installed. Run: pip install ddgs"}

    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            with DDGS() as ddgs:
                if topic == "news":
                    raw = list(ddgs.news(query, max_results=max_results))
                    results = [
                        {"title": r.get("title"), "url": r.get("url"), "content": r.get("body", "")}
                        for r in raw
                    ]
                else:
                    raw = list(ddgs.text(query, max_results=max_results))
                    results = [
                        {"title": r.get("title"), "url": r.get("href"), "content": r.get("body", "")}
                        for r in raw
                    ]
            return {"results": results, "provider": "duckduckgo"}
        except Exception as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    return {"error": f"DuckDuckGo search failed: {last_exc}"}


def _search_tavily(query: str, max_results: int, topic: str, include_raw: bool, key: str) -> Dict[str, Any]:
    try:
        from tavily import TavilyClient
    except ImportError:
        return {"error": "tavily-python not installed."}
    client = TavilyClient(api_key=key)
    return client.search(
        query=query,
        max_results=max_results,
        include_raw_content=include_raw,
        topic=topic,
    )


@tool
def internet_search(
    query: str,
    max_results: int = 5,
    topic: Literal["general", "news", "finance"] = "general",
    include_raw_content: bool = False,
) -> Dict[str, Any]:
    """Search the internet and return results.
    Uses Tavily if TAVILY_API_KEY is set, otherwise DuckDuckGo (free, no key needed).
    Use topic='news' for recent news results."""
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if key:
        return _search_tavily(query, max_results, topic, include_raw_content, key)
    return _search_duckduckgo(query, max_results, topic)
