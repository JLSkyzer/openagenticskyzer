"""Chargement des instructions projet depuis OPENAGENT.md ou CLAUDE.md (Phase 14)."""
from __future__ import annotations
from pathlib import Path

_MAX_CHARS = 8000
_CANDIDATES = ("OPENAGENT.md", "CLAUDE.md")


def load_project_instructions(cwd: str | None) -> str:
    """Lit OPENAGENT.md (ou CLAUDE.md en fallback) depuis cwd.

    Retourne une chaîne vide si aucun fichier trouvé ou cwd invalide.
    Le contenu est limité à 8000 chars pour préserver le contexte.
    """
    if not cwd:
        return ""
    cwd_path = Path(cwd)
    if not cwd_path.is_dir():
        return ""

    for name in _CANDIDATES:
        candidate = cwd_path / name
        if candidate.is_file():
            try:
                content = candidate.read_text(encoding="utf-8").strip()
            except OSError:
                return ""
            if not content:
                return ""
            if len(content) > _MAX_CHARS:
                content = content[:_MAX_CHARS] + "\n[... tronqué]"
            return (
                f"[INSTRUCTIONS PROJET — {name}]\n"
                f"{content}\n"
                "[FIN INSTRUCTIONS PROJET]\n"
            )

    return ""
