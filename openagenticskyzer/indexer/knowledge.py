"""Persistent personal knowledge collection, separate from the code index."""
from __future__ import annotations

import hashlib
from pathlib import Path

from openagenticskyzer.indexer.embedder import embed
from openagenticskyzer.indexer.indexer import _chunk


def _knowledge_db_path() -> Path:
    return Path.home() / ".openagent" / "knowledge"


def _get_knowledge_db():
    try:
        import chromadb
    except ImportError as exc:
        raise RuntimeError("chromadb est requis pour la base de connaissances") from exc
    client = chromadb.PersistentClient(path=str(_knowledge_db_path()))
    return client.get_or_create_collection("knowledge", metadata={"hnsw:space": "cosine"})


def add_to_knowledge(source: str, text: str, tags: list[str] | None = None) -> int:
    chunks = _chunk(text)
    if not chunks:
        return 0
    collection = _get_knowledge_db()
    ids = [hashlib.md5(f"{source}:{number}".encode()).hexdigest() for number in range(len(chunks))]
    collection.upsert(ids=ids, embeddings=embed(chunks), documents=chunks,
                     metadatas=[{"source": source, "chunk": number, "tags": ",".join(tags or [])}
                                for number in range(len(chunks))])
    return len(chunks)


def search_knowledge(query: str, n: int = 5) -> list[dict]:
    collection = _get_knowledge_db()
    count = collection.count()
    if count <= 0 or n <= 0:
        return []
    results = collection.query(query_embeddings=embed([query]), n_results=min(n, count))
    return [{"source": metadata["source"], "content": document, "score": 1 - distance}
            for document, metadata, distance in zip(results.get("documents", [[]])[0],
                                                     results.get("metadatas", [[]])[0],
                                                     results.get("distances", [[]])[0])]


def list_sources() -> list[str]:
    collection = _get_knowledge_db()
    if collection.count() <= 0:
        return []
    return sorted({meta["source"] for meta in collection.get(include=["metadatas"])["metadatas"]})


def remove_source(source: str) -> int:
    collection = _get_knowledge_db()
    ids = collection.get(where={"source": source}).get("ids", [])
    if ids:
        collection.delete(ids=ids)
    return len(ids)
