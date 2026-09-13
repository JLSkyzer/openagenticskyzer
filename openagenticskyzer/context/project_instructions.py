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


def _get_test_cmd(runner: str) -> str:
    """Return the conventional command for a scanner-detected test runner."""
    cmds = {
        "pytest": "pytest -v",
        "unittest": "python -m unittest discover",
        "jest": "npx jest",
        "vitest": "npx vitest run",
        "mocha": "npx mocha",
        "rspec": "bundle exec rspec",
    }
    return cmds.get(runner, runner)


def generate_openagent_md(analysis: dict) -> str:
    """Generate editable OPENAGENT.md content from project scan metadata."""
    lines: list[str] = []

    lines.append("# OPENAGENT.md — Instructions pour l'agent")
    lines.append("")
    lines.append("> Fichier généré automatiquement par OpenAgentic Skyzer. Modifiez selon vos besoins.")
    lines.append("")

    lines.append("## Stack")
    langs = ", ".join(analysis.get("languages") or []) or "Non détecté"
    lines.append(f"- **Langages :** {langs}")

    frameworks = ", ".join(analysis.get("frameworks") or [])
    if frameworks:
        lines.append(f"- **Frameworks :** {frameworks}")

    package_manager = analysis.get("package_manager", "")
    if package_manager:
        lines.append(f"- **Gestionnaire de paquets :** {package_manager}")

    ci_cd = analysis.get("ci_cd", "")
    if ci_cd:
        lines.append(f"- **CI/CD :** {ci_cd}")
    lines.append("")

    lines.append("## Règles")
    lines.append("- Suis le style de code existant dans le projet.")
    lines.append("- N'installe pas de nouvelles dépendances sans accord explicite.")
    lines.append("- Écris des tests pour tout nouveau code.")
    lines.append("- Commits atomiques avec messages descriptifs.")
    lines.append("")

    sensitive_files = analysis.get("sensitive_files") or []
    if sensitive_files:
        lines.append("## ⚠️ Fichiers sensibles — NE PAS MODIFIER")
        for path in sensitive_files:
            lines.append(f"- `{path}`")
        lines.append("")

    runner = analysis.get("test_runner", "")
    if runner:
        lines.append("## Tests")
        lines.append(f"- **Runner :** `{runner}`")
        lines.append(f"- **Commande :** `{_get_test_cmd(runner)}`")
        lines.append("- Exécute les tests avant chaque commit.")
        lines.append("")

    structure = analysis.get("structure_summary", "")
    if structure:
        lines.append("## Structure")
        lines.append("```")
        lines.append(structure)
        lines.append("```")
        lines.append("")

    entry_points = analysis.get("entry_points") or []
    if entry_points:
        lines.append("## Points d'entrée")
        for entry_point in entry_points:
            lines.append(f"- `{entry_point}`")
        lines.append("")

    lines.append("## Notes")
    lines.append(
        "_À compléter manuellement : architecture spécifique, conventions d'équipe, contraintes métier._"
    )

    return "\n".join(lines)
