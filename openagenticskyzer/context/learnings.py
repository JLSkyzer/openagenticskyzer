# openagenticskyzer/context/learnings.py
"""Apprentissage adaptatif — stockage JSONL et injection des learnings
(erreurs corrigées, préférences, bonnes pratiques découvertes) par projet
(.openagent/learnings.jsonl) et globalement (~/.openagent/learnings.jsonl).

Miroir des conventions établies dans context/project_memory.py (même risque :
lu à chaque tour de conversation via injection, écrit sur disque) :
- le chemin global est une fonction (`_global_learnings_path`), jamais une
  constante de module, pour que les tests puissent la monkeypatcher et ne
  jamais toucher le vrai ~/.openagent/ du poste de développement ;
- dégradation gracieuse sur OSError en lecture (retour vide) et en écriture
  (échec silencieux) ;
- `newline="\n"` explicite sur toutes les écritures texte.
"""
import hashlib
import json
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

LEARNING_TYPES = {
    "error":       "Erreur d'outil ou d'exécution récupérée",
    "correction":  "Correction fournie par l'utilisateur",
    "discovery":   "Bonne pratique découverte",
    "preference":  "Préférence de style ou comportement",
}


@dataclass
class Learning:
    id: str
    type: str
    context_summary: str
    mistake: str
    correction: str
    tags: list
    project_hash: str | None
    timestamp: str
    confirmed: bool
    contributed: bool
    source: str


def _learnings_path(project_folder: str | None) -> Path:
    if project_folder:
        return Path(project_folder) / ".openagent" / "learnings.jsonl"
    return _global_learnings_path()


def _global_learnings_path() -> Path:
    return Path.home() / ".openagent" / "learnings.jsonl"


def new_learning(type_: str, context_summary: str, mistake: str, correction: str,
                  tags: list | None = None, project_folder: str | None = None,
                  source: str = "auto") -> Learning:
    """Construit un nouveau `Learning` non confirmé (confirmed=False), prêt à
    être passé à `save_learning`. Les champs texte sont tronqués pour éviter
    qu'une entrée démesurée ne pollue l'injection future dans le prompt
    système (voir `format_learnings_for_injection`)."""
    project_hash = (
        hashlib.sha1(project_folder.encode()).hexdigest()[:8]
        if project_folder else None
    )
    return Learning(
        id=str(uuid.uuid4())[:8],
        type=type_,
        context_summary=context_summary[:200],
        mistake=mistake[:500],
        correction=correction[:500],
        tags=tags or [],
        project_hash=project_hash,
        timestamp=datetime.now(timezone.utc).isoformat(),
        confirmed=False,
        contributed=False,
        source=source,
    )


def save_learning(learning: Learning, project_folder: str | None = None) -> None:
    """Ajoute `learning` en une ligne JSON au fichier .jsonl du projet (si
    `project_folder` fourni) ou global. Échoue silencieusement sur OSError
    (dossier/fichier verrouillé) plutôt que de propager l'exception."""
    path = _learnings_path(project_folder)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(asdict(learning), ensure_ascii=False) + "\n")
    except OSError:
        pass


def _read_learnings_file(path: Path) -> list[Learning]:
    """Lit un fichier .jsonl et retourne les `Learning` valides qu'il
    contient. Retourne [] si le fichier est absent ou si la lecture échoue
    (OSError) ; ignore silencieusement les lignes JSON malformées ou dont les
    champs ne correspondent pas au dataclass `Learning`."""
    if not path.exists():
        return []
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return []
    result = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            result.append(Learning(**json.loads(line)))
        except Exception:
            continue
    return result


def load_learnings(project_folder: str | None = None,
                    confirmed_only: bool = True) -> list[Learning]:
    """Charge les learnings du projet ET du store global, fusionnés et
    dédupliqués par id (le premier fichier lu — projet, puis global — gagne
    en cas de collision d'id). Filtre sur `confirmed` si `confirmed_only`."""
    paths = []
    if project_folder:
        paths.append(_learnings_path(project_folder))
    global_path = _global_learnings_path()
    if global_path not in paths:
        paths.append(global_path)

    result: list[Learning] = []
    seen_ids: set[str] = set()
    for path in paths:
        for learning in _read_learnings_file(path):
            if learning.id in seen_ids:
                continue
            seen_ids.add(learning.id)
            if not confirmed_only or learning.confirmed:
                result.append(learning)
    return result


def delete_learning(learning_id: str, project_folder: str | None = None) -> None:
    """Retire la ligne correspondant à `learning_id` de tous les fichiers
    concernés (projet et/ou global — dédupliqués pour éviter de relire/
    réécrire deux fois le même fichier quand `project_folder` est None).
    Échoue silencieusement sur OSError, fichier par fichier."""
    paths: list[Path] = []
    if project_folder:
        paths.append(_learnings_path(project_folder))
    global_path = _global_learnings_path()
    if global_path not in paths:
        paths.append(global_path)

    for path in paths:
        if not path.exists():
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            continue
        kept_lines = []
        changed = False
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                if json.loads(line).get("id") == learning_id:
                    changed = True
                    continue
            except Exception:
                pass
            kept_lines.append(line)
        if not changed:
            continue
        try:
            content = "".join(l + "\n" for l in kept_lines)
            path.write_text(content, encoding="utf-8", newline="\n")
        except OSError:
            pass


def format_learnings_for_injection(learnings: list[Learning]) -> str:
    """Formate les learnings confirmés pour injection dans le system prompt.
    Retourne '' pour une liste vide (no-op côté appelant, cf.
    `_format_memory_injection` dans input_bar.py pour le même contrat)."""
    if not learnings:
        return ""
    lines = ["[LEÇONS APPRISES — à appliquer systématiquement]"]
    for learning in learnings[:20]:  # max 20 pour ne pas saturer le contexte
        tag_str = f" [{', '.join(learning.tags)}]" if learning.tags else ""
        lines.append(f"• À éviter : {learning.mistake}{tag_str}")
        lines.append(f"  Faire plutôt : {learning.correction}")
    lines.append("[FIN LEÇONS]")
    return "\n".join(lines)
