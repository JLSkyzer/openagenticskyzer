# openagenticskyzer/context/project_memory.py
"""Mémoire persistante par projet (.openagent/memory.md) et globale (~/.openagent/memory.md)."""
from datetime import datetime
from pathlib import Path


def _memory_path(folder: str) -> Path:
    return Path(folder) / ".openagent" / "memory.md"


def _global_memory_path() -> Path:
    return Path.home() / ".openagent" / "memory.md"


def load_project_memory(folder: str) -> str:
    """Lit la mémoire du projet. Retourne '' si aucun fichier n'existe encore."""
    path = _memory_path(folder)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def save_project_memory(folder: str, content: str) -> None:
    """Écrase le contenu de la mémoire du projet (crée .openagent/ si besoin)."""
    path = _memory_path(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.strip(), encoding="utf-8")


def append_to_project_memory(folder: str, new_facts: str) -> None:
    """Ajoute des faits horodatés à la mémoire existante du projet.

    Un appel avec des faits vides/blancs est un no-op délibéré : la mémoire
    est réinjectée dans chaque conversation future (voir Task 3 du plan), donc
    une entrée horodatée sans contenu ne serait que du bruit qui s'accumule.
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
    car d'autres fichiers — config.json, chat_history.json — peuvent y vivre)."""
    path = _memory_path(folder)
    if path.exists():
        path.unlink()


def load_global_memory() -> str:
    """Lit la mémoire globale (partagée entre tous les projets)."""
    path = _global_memory_path()
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def append_to_global_memory(facts: str) -> None:
    """Ajoute des faits horodatés à la mémoire globale (même règle de no-op
    sur faits vides que append_to_project_memory)."""
    clean = facts.strip()
    if not clean:
        return
    existing = load_global_memory()
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    entry = f"\n\n<!-- {ts} -->\n{clean}"
    path = _global_memory_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text((existing + entry).strip(), encoding="utf-8")
