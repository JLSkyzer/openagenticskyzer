"""LangChain tools for semantic and personal-knowledge search."""
from __future__ import annotations

from langchain_core.tools import tool


@tool
def semantic_search(query: str, n: int = 5) -> str:
    """Search the active codebase semantically for conceptual matches."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.indexer.indexer import search_codebase
    if not state.active_folder:
        return "No active folder. Open a folder first."
    try:
        results = search_codebase(state.active_folder, query, n)
    except Exception as exc:
        return f"Index not ready: {exc}. Index the project first."
    if not results:
        return "No results found. The index may not be built yet."
    return "\n\n---\n\n".join(f"[{item['file']}] (score: {item['score']:.2f})\n{item['content']}" for item in results)


@tool
def knowledge_search(query: str, n: int = 5) -> str:
    """Search documents explicitly added to the personal knowledge base."""
    from openagenticskyzer.indexer.knowledge import search_knowledge
    try:
        results = search_knowledge(query, n)
    except Exception as exc:
        return f"Erreur base de connaissances : {exc}"
    if not results:
        return "La base de connaissances est vide ou aucun résultat pertinent."
    return "\n\n---\n\n".join(f"[Source: {item['source']}] (score: {item['score']:.2f})\n{item['content']}" for item in results)
