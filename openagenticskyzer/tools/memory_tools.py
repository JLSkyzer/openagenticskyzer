# openagenticskyzer/tools/memory_tools.py
"""Outils de mémoire persistante pour l'agent."""
from langchain_core.tools import tool


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
        load_project_memory, save_project_memory, remove_entries_matching,
    )
    if not state.active_folder:
        return "Aucun dossier actif."
    mem = load_project_memory(state.active_folder)
    updated = remove_entries_matching(mem, keyword)
    save_project_memory(state.active_folder, updated)
    return f"✓ Entrées contenant '{keyword}' supprimées."
