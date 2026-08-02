# openagenticskyzer/tools/memory_tools.py
"""Outils de mémoire persistante pour l'agent."""
import re

from langchain_core.tools import tool

# Sépare le contenu de memory.md sur les marqueurs horodatés écrits par
# append_to_project_memory/append_to_global_memory (`<!-- YYYY-MM-DD HH:MM -->`).
# Chaque bloc capturé va du marqueur jusqu'au marqueur suivant (ou la fin du
# fichier) et constitue une entrée indivisible.
_ENTRY_SPLIT_RE = re.compile(r"\n\n(?=<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->)")


def _split_memory_entries(mem: str) -> list[str]:
    """Découpe la mémoire en entrées horodatées entières (voir _ENTRY_SPLIT_RE).

    Utilisé par forget_memory pour supprimer un fait sans corrompre la
    structure `<!-- timestamp -->` : un filtrage ligne par ligne (comme
    suggéré naïvement) supprimerait la ligne correspondant au mot-clé mais
    laisserait l'en-tête horodaté orphelin, ou des fragments d'un fait
    multi-lignes dont seule une ligne matchait — voir tests/test_memory_tools.py
    TestForgetMemory.test_multiline_entry_removed_as_a_whole_no_orphaned_fragments.
    """
    if not mem.strip():
        return []
    return [entry for entry in _ENTRY_SPLIT_RE.split(mem) if entry.strip()]


@tool
def save_memory(facts: str, scope: str = "project") -> str:
    """Save important facts, decisions, or preferences to persistent memory.
    scope='project' saves to current project, scope='global' saves for all projects.
    Use when user says 'remember that...', 'note that...', or after solving complex problems.
    Args: facts — text to save. scope — 'project' (default) or 'global'."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import (
        append_to_project_memory, append_to_global_memory,
    )
    if scope == "global":
        append_to_global_memory(facts)
        return "✓ Mémorisé dans la mémoire globale (~/.openagent/memory.md)"
    if not state.active_folder:
        return "Aucun dossier actif — impossible de sauvegarder la mémoire projet."
    append_to_project_memory(state.active_folder, facts)
    return f"✓ Mémorisé dans {state.active_folder}/.openagent/memory.md"


@tool
def read_memory() -> str:
    """Read the project's persistent memory (facts saved across sessions).
    Use when asked 'what do you know about this project?'."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import load_project_memory, load_global_memory
    parts = []
    global_mem = load_global_memory()
    if global_mem:
        parts.append(f"[Mémoire globale]\n{global_mem}")
    if state.active_folder:
        project_mem = load_project_memory(state.active_folder)
        if project_mem:
            parts.append(f"[Mémoire projet]\n{project_mem}")
    return "\n\n".join(parts) if parts else "La mémoire est vide."


@tool
def forget_memory(keyword: str) -> str:
    """Remove facts containing a keyword from project memory.
    Use when user says 'forget that...', 'remove from memory...'
    Args: keyword — word or phrase to search and remove."""
    from openagenticskyzer.app.state import state
    from openagenticskyzer.context.project_memory import (
        load_project_memory, save_project_memory,
    )
    if not state.active_folder:
        return "Aucun dossier actif."
    mem = load_project_memory(state.active_folder)
    entries = _split_memory_entries(mem)
    keyword_lower = keyword.lower()
    kept = [entry for entry in entries if keyword_lower not in entry.lower()]
    save_project_memory(state.active_folder, "\n\n".join(kept))
    return f"✓ Entrées contenant '{keyword}' supprimées."
