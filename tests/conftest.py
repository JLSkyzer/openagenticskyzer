# tests/conftest.py
"""Isolation globale du HOME pour toute la suite de tests.

Plusieurs modules `context/*.py` ont une portée globale ancrée sur
`Path.home()` (`project_memory._global_memory_path`,
`learnings._global_learnings_path`), et ils sont désormais lus à CHAQUE tour de
conversation via `context/system_context.py` — donc par tout test qui construit
un `agent_node` ou un graphe, même sans toucher explicitement à la mémoire.

Sans cette isolation, ces tests liraient le vrai `~/.openagent/` du poste :
verts sur une machine vierge, rouges dès que l'utilisateur a réellement utilisé
l'app (un `memory.md` non vide s'ajouterait au prompt système et casserait les
assertions d'égalité stricte). C'est exactement la classe de bug relevée deux
fois dans tasks/lessons.md (chemins globaux `Path.home()` non isolés) — traitée
ici une fois pour toutes plutôt que fichier par fichier.

Les tests qui veulent piloter le contenu du home global le monkeypatchent
eux-mêmes vers leur propre `tmp_path` : leur `setattr` s'applique après
celui-ci et gagne.
"""
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_home(monkeypatch, tmp_path_factory):
    """Pointe `Path.home()` vers un répertoire temporaire vide, par test."""
    fake_home = tmp_path_factory.mktemp("home")
    monkeypatch.setattr(Path, "home", lambda: fake_home)
    return fake_home
