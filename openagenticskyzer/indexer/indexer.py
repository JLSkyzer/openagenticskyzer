"""Persistent ChromaDB index for source files."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from openagenticskyzer.indexer.embedder import embed

_CHUNK_SIZE = 800
_CHUNK_OVERLAP = 100
_EXCLUDED = {".git", "node_modules", "__pycache__", "dist", "build", ".openagent", ".venv", "venv", ".mypy_cache"}
_EXTENSIONS = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".css", ".html", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".sql"}


def _get_db(folder: str):
    try:
        import chromadb
    except ImportError as exc:
        raise RuntimeError("chromadb est requis pour l'indexation sémantique") from exc

    db_path = str(Path(folder) / ".openagent" / "index")
    client = chromadb.PersistentClient(path=db_path)
    return client.get_or_create_collection("codebase", metadata={"hnsw:space": "cosine"})


def _chunk(text: str) -> list[str]:
    if not text:
        return []
    step = _CHUNK_SIZE - _CHUNK_OVERLAP
    chunks = [text[start : start + _CHUNK_SIZE] for start in range(0, len(text), step)]
    return [chunk for chunk in chunks if chunk.strip()]


def index_folder(folder: str, on_progress=None) -> int:
    """Index supported files and return the number of indexed chunks."""
    root = Path(folder)
    if not root.is_dir():
        return 0
    collection = _get_db(str(root))
    files: list[Path] = []
    for current, dirs, names in os.walk(root, onerror=lambda _error: None):
        dirs[:] = sorted(d for d in dirs if d not in _EXCLUDED)
        for name in sorted(names):
            path = Path(current) / name
            if path.suffix.lower() in _EXTENSIONS:
                files.append(path)

    total = 0
    for index, path in enumerate(sorted(files)):
        if on_progress:
            on_progress(index, len(files), str(path))
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
            chunks = _chunk(text)
            if not chunks:
                continue
            relative = path.relative_to(root).as_posix()
            ids = [hashlib.md5(f"{relative}:{number}".encode()).hexdigest() for number in range(len(chunks))]
            collection.upsert(
                ids=ids,
                embeddings=embed(chunks),
                documents=chunks,
                metadatas=[{"file": relative, "chunk": number} for number in range(len(chunks))],
            )
            total += len(chunks)
        except (OSError, ValueError):
            continue
    return total


def search_codebase(folder: str, query: str, n: int = 5) -> list[dict]:
    """Return up to ``n`` nearest chunks, or an empty list for an empty index."""
    collection = _get_db(folder)
    count = collection.count()
    if count <= 0 or n <= 0:
        return []
    results = collection.query(query_embeddings=embed([query]), n_results=min(n, count))
    documents = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]
    return [
        {"file": metadata["file"], "content": document, "score": 1 - distance}
        for document, metadata, distance in zip(documents, metadatas, distances)
    ]

