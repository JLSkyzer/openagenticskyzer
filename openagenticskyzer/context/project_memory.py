# openagenticskyzer/context/project_memory.py
"""Mémoire persistante par projet (.openagent/memory.md) et globale (~/.openagent/memory.md)."""
import re
from datetime import datetime
from pathlib import Path

# Découpe le contenu de memory.md sur les marqueurs horodatés écrits par
# append_to_project_memory/append_to_global_memory ci-dessous (`<!-- YYYY-MM-DD
# HH:MM -->`, précédé de `\n\n`). Ce module est le seul propriétaire du format
# d'entrée horodatée — le pattern ne doit être défini qu'ici, jamais
# re-dérivé ailleurs (ex. tools/memory_tools.py), sous peine de désynchronisation
# silencieuse si ce format change un jour.
_ENTRY_SPLIT_RE = re.compile(r"\n\n(?=<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->)")


def _split_entries(mem: str) -> list[str]:
    """Découpe la mémoire en entrées horodatées entières (voir _ENTRY_SPLIT_RE)."""
    if not mem.strip():
        return []
    return [entry for entry in _ENTRY_SPLIT_RE.split(mem) if entry.strip()]


def remove_entries_matching(existing: str, keyword: str) -> str:
    """Retire les entrées horodatées entières contenant `keyword` (recherche
    insensible à la casse) du contenu `existing`, et retourne le contenu
    résultant (prêt à passer à save_project_memory).

    Opère au niveau de l'entrée entière plutôt que ligne par ligne : un fait
    peut s'étaler sur plusieurs lignes, et un filtrage ligne par ligne
    laisserait soit un en-tête horodaté orphelin (aucune ligne de contenu
    derrière), soit des fragments du même fait sans le contexte qui leur
    donnait sens. Voir tests/test_project_memory.py et
    tests/test_memory_tools.py pour les cas de régression couverts."""
    entries = _split_entries(existing)
    keyword_lower = keyword.lower()
    kept = [entry for entry in entries if keyword_lower not in entry.lower()]
    return "\n\n".join(kept)


def _memory_path(folder: str) -> Path:
    return Path(folder) / ".openagent" / "memory.md"


def _global_memory_path() -> Path:
    return Path.home() / ".openagent" / "memory.md"


def load_project_memory(folder: str) -> str:
    """Lit la mémoire du projet. Retourne '' si aucun fichier n'existe encore,
    ou si la lecture échoue (fichier verrouillé par un antivirus/éditeur,
    etc.) — même dégradation gracieuse que `project_instructions.py`, car ce
    contenu est réinjecté dans chaque conversation (Task 3) et ne doit jamais
    faire planter l'appelant."""
    path = _memory_path(folder)
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def save_project_memory(folder: str, content: str) -> None:
    """Écrase le contenu de la mémoire du projet (crée .openagent/ si besoin).
    Échoue silencieusement sur OSError (dossier/fichier verrouillé) plutôt que
    de propager l'exception à l'appelant."""
    path = _memory_path(folder)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content.strip(), encoding="utf-8", newline="\n")
    except OSError:
        pass


def append_to_project_memory(folder: str, new_facts: str) -> None:
    """Ajoute des faits horodatés à la mémoire existante du projet.

    Un appel avec des faits vides/blancs est un no-op délibéré : la mémoire
    est réinjectée dans chaque conversation future (voir Task 3 du plan), donc
    une entrée horodatée sans contenu ne serait que du bruit qui s'accumule.
    Les erreurs I/O sont absorbées par load_project_memory/save_project_memory.
    """
    facts = new_facts.strip()
    if not facts:
        return
    existing = load_project_memory(folder)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"\n\n<!-- {ts} -->\n{facts}"
    save_project_memory(folder, existing + entry)


def clear_project_memory(folder: str) -> None:
    """Supprime le fichier memory.md du projet (laisse .openagent/ en place,
    car d'autres fichiers — config.json, chat_history.json — peuvent y vivre).
    Échoue silencieusement sur OSError (ex. fichier verrouillé)."""
    path = _memory_path(folder)
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def load_global_memory() -> str:
    """Lit la mémoire globale (partagée entre tous les projets). Retourne ''
    si absente ou si la lecture échoue (même dégradation gracieuse que
    load_project_memory)."""
    path = _global_memory_path()
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def append_to_global_memory(facts: str) -> None:
    """Ajoute des faits horodatés à la mémoire globale (même règle de no-op
    sur faits vides, et même dégradation gracieuse sur OSError, que
    append_to_project_memory)."""
    clean = facts.strip()
    if not clean:
        return
    existing = load_global_memory()
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"\n\n<!-- {ts} -->\n{clean}"
    path = _global_memory_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text((existing + entry).strip(), encoding="utf-8", newline="\n")
    except OSError:
        pass
