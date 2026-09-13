"""Lazy local embedding model (all-MiniLM-L6-v2)."""
from __future__ import annotations

# Kept as a patchable symbol for tests; the optional package is imported lazily.
SentenceTransformer = None

_MODEL_NAME = "all-MiniLM-L6-v2"
_model = None


def get_model():
    """Return the process-wide model singleton, loading it only on first use."""
    global _model
    if _model is None:
        global SentenceTransformer
        if SentenceTransformer is None:
            try:
                from sentence_transformers import SentenceTransformer as _SentenceTransformer
            except ImportError as exc:
                raise RuntimeError(
                    "sentence-transformers est requis pour la recherche sémantique"
                ) from exc
            SentenceTransformer = _SentenceTransformer
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


def embed(texts: list[str]) -> list[list[float]]:
    """Embed text and normalize provider-specific array output to plain lists."""
    encoded = get_model().encode(texts, batch_size=32, show_progress_bar=False)
    return encoded.tolist() if hasattr(encoded, "tolist") else [list(row) for row in encoded]
