import os
from typing import Any, Dict, Literal

from langchain_core.tools import tool
from tavily import TavilyClient


@tool
def internet_search(
    query: str,
    max_results: int = 5,
    topic: Literal["general", "news", "finance"] = "general",
    include_raw_content: bool = False,
) -> Dict[str, Any]:
    """Search the internet using Tavily and return results."""
    key = os.environ.get("TAVILY_API_KEY", "")
    if not key:
        return {"error": "TAVILY_API_KEY is not set. Add it to your .env file."}
    client = TavilyClient(api_key=key)
    return client.search(
        query=query,
        max_results=max_results,
        include_raw_content=include_raw_content,
        topic=topic,
    )
