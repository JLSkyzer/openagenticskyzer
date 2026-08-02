# openagenticskyzer/context/system_context.py
"""Assemblage du contexte système dynamique réinjecté à CHAQUE tour de conversation.

Point unique où sont chargés puis concaténés les blocs de contexte dynamiques
qui précèdent le prompt système statique dans l'appel au LLM :

    1. instructions projet   (OPENAGENT.md / CLAUDE.md — context/project_instructions.py)
    2. prompt personnalisé   (custom_prompt de .openagent/config.json — app/storage.py)
    3. mémoire persistante   (globale + projet — context/project_memory.py)
    4. leçons apprises       (learnings confirmés — context/learnings.py)

Pourquoi ici, et surtout pas via des `{"role": "system", ...}` poussés dans
l'historique de messages : `trim_message_history` (context/messages.py) retire
*inconditionnellement* tout `SystemMessage` de l'historique avant chaque appel
LLM (`non_system = [m for m in messages if not isinstance(m, SystemMessage)]`),
afin que `agent_node` réinjecte proprement un seul prompt système en tête. Tout
contenu injecté comme message système par un appelant (l'UI, par exemple) est
donc silencieusement supprimé avant d'atteindre le modèle — c'était le cas du
custom_prompt, de la mémoire et des learnings jusqu'à ce module.

Le seul chemin fiable est celui déjà éprouvé par `load_project_instructions` :
charger le contenu *dans* `agent_node`, depuis le `cwd` capturé à la
construction de l'agent (`build_agent` fait `cwd = os.getcwd()`, et l'UI fait
`os.chdir(state.active_folder)` juste avant chaque `build_agent`), puis le
replier dans le prompt système effectif.

Caps de taille — ces contenus sont des stores en croissance libre (`memory.md`
est append-only, alimenté entre autres par la compaction qui y réécrit son
propre résumé ; `learnings.jsonl` grossit à chaque leçon confirmée). Tant qu'ils
n'atteignaient pas le LLM, leur taille était sans conséquence ; maintenant
qu'ils sont injectés à chaque tour, chaque bloc a un plafond dur, plus un
plafond global sur l'ensemble — même convention que `_MAX_CHARS = 8000` dans
project_instructions.py.

Note : les caps vivent ici (site d'injection) et non dans les fonctions de
chargement de project_memory.py / learnings.py, car ces fonctions servent aussi
l'outil agent `read_memory`, qui doit continuer à voir la mémoire complète.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("openagentic.system_context")

# Plafonds par bloc, puis plafond global sur le préfixe assemblé.
_MAX_CUSTOM_PROMPT_CHARS = 8000
_MAX_MEMORY_CHARS = 4000      # par portée (globale, puis projet)
_MAX_LEARNINGS_CHARS = 6000
_MAX_TOTAL_CHARS = 20000


def _truncate_head(content: str, limit: int) -> str:
    """Garde le DÉBUT du contenu (convention de project_instructions.py)."""
    if len(content) <= limit:
        return content
    return content[:limit] + "\n[... tronqué]"


def _truncate_tail(content: str, limit: int) -> str:
    """Garde la FIN du contenu — utilisé pour les stores append-only horodatés
    (`memory.md`), où les entrées les plus récentes sont les plus pertinentes ;
    tronquer par le début y garderait au contraire les faits les plus vieux."""
    if len(content) <= limit:
        return content
    return "[... début tronqué]\n" + content[-limit:]


def format_memory_injection(global_mem: str, project_mem: str) -> str:
    """Formate la mémoire globale + projet en un seul bloc système (fonction
    pure, testable sans I/O). Retourne '' si les deux sont vides. Chaque portée
    est plafonnée indépendamment à `_MAX_MEMORY_CHARS` pour qu'une mémoire
    globale démesurée n'évince pas la mémoire projet (et réciproquement)."""
    parts = []
    if global_mem:
        parts.append(
            "MÉMOIRE GLOBALE (préférences utilisateur) :\n"
            + _truncate_tail(global_mem, _MAX_MEMORY_CHARS)
        )
    if project_mem:
        parts.append(
            "MÉMOIRE PROJET (contexte persistant) :\n"
            + _truncate_tail(project_mem, _MAX_MEMORY_CHARS)
        )
    if not parts:
        return ""
    return (
        "[MÉMOIRE PERSISTANTE]\n"
        + "\n\n".join(parts)
        + "\n[FIN MÉMOIRE PERSISTANTE]"
    )


def load_custom_prompt_block(cwd: str | None) -> str:
    """Lit `custom_prompt` depuis `<cwd>/.openagent/config.json`. Retourne ''
    si absent/vide/illisible — jamais d'exception propagée : ce chargement a
    lieu à chaque tour de conversation et ne doit jamais faire échouer l'appel
    LLM."""
    if not cwd:
        return ""
    try:
        from openagenticskyzer.app.storage import load_folder_config
        custom = (load_folder_config(cwd).get("custom_prompt") or "").strip()
    except Exception as exc:  # config corrompue, chemin illisible…
        logger.debug("custom_prompt non chargé (%s: %s)", type(exc).__name__, exc)
        return ""
    if not custom:
        return ""
    return (
        "[CONTEXTE PERSONNALISÉ DU DOSSIER]\n"
        + _truncate_head(custom, _MAX_CUSTOM_PROMPT_CHARS)
        + "\n[FIN CONTEXTE PERSONNALISÉ]"
    )


def load_memory_block(cwd: str | None) -> str:
    """Charge mémoire globale + mémoire projet et les formate. Retourne '' si
    rien à injecter."""
    from openagenticskyzer.context.project_memory import (
        load_global_memory, load_project_memory,
    )
    try:
        global_mem = load_global_memory()
    except Exception:
        global_mem = ""
    try:
        project_mem = load_project_memory(cwd) if cwd else ""
    except Exception:
        project_mem = ""
    return format_memory_injection(global_mem, project_mem)


def load_learnings_block(cwd: str | None) -> str:
    """Charge les learnings confirmés (projet + global) et les formate,
    plafonnés à `_MAX_LEARNINGS_CHARS`."""
    from openagenticskyzer.context.learnings import (
        format_learnings_for_injection, load_learnings,
    )
    try:
        learnings = load_learnings(project_folder=cwd, confirmed_only=True)
    except Exception:
        return ""
    block = format_learnings_for_injection(learnings)
    if not block:
        return ""
    return _truncate_head(block, _MAX_LEARNINGS_CHARS)


def build_context_prefix(cwd: str | None) -> str:
    """Assemble tous les blocs de contexte dynamiques pour `cwd`.

    Retourne '' si aucun bloc n'a de contenu (cas nominal d'un dossier vierge,
    et cas des tests qui construisent un `agent_node` sans cwd)."""
    from openagenticskyzer.context.project_instructions import load_project_instructions

    try:
        project_instructions = load_project_instructions(cwd)
    except Exception:
        project_instructions = ""

    blocks = [
        project_instructions,
        load_custom_prompt_block(cwd),
        load_memory_block(cwd),
        load_learnings_block(cwd),
    ]
    prefix = "\n\n".join(b.strip() for b in blocks if b and b.strip())
    if len(prefix) > _MAX_TOTAL_CHARS:
        prefix = prefix[:_MAX_TOTAL_CHARS] + "\n[... contexte tronqué]"
    return prefix


def build_effective_system_prompt(cwd: str | None, system_prompt: str) -> str:
    """Prompt système effectif = blocs de contexte dynamiques + prompt statique.

    Sans aucun bloc de contexte, retourne `system_prompt` inchangé (l'égalité
    stricte est vérifiée par les tests de `agent_node`)."""
    prefix = build_context_prefix(cwd)
    if not prefix:
        return system_prompt
    return f"{prefix}\n\n{system_prompt}"
