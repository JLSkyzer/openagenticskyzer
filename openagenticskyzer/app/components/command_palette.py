"""Palette de commandes (Ctrl+K) — recherche + exécution rapide d'actions.

Note sur la commande "🔍 Rechercher" du plan original : aucune fonctionnalité
de recherche dans les conversations n'existe nulle part dans le codebase
(vérifié par grep exhaustif avant implémentation). Improviser un moteur de
recherche serait hors scope de cette tâche (palette de commandes, pas moteur
de recherche). Convention déjà établie dans ce projet (voir tasks/lessons.md) :
ne pas exposer une entrée dont l'action serait `None` et ne ferait rien
silencieusement au clic — l'entrée est donc simplement omise de `_COMMANDS`.

Tous les imports cross-module des fonctions d'action sont différés (à
l'intérieur des fonctions), jamais au niveau module, pour éviter les cycles
d'import (ce module est importé par main.py, et certaines actions importent
depuis main.py).
"""
from nicegui import ui


# ── Actions ──────────────────────────────────────────────────────────────────

def _open_folder():
    from openagenticskyzer.app.components.sidebar import open_folder_prompt
    open_folder_prompt()


def _switch_model():
    from openagenticskyzer.app.components.model_modal import open_model_modal
    open_model_modal()


def _clear_history():
    from openagenticskyzer.app.state import state

    if not state.active_folder:
        ui.notify("Aucun dossier actif.", type="warning")
        return

    with ui.dialog() as confirm_dlg, ui.card().style(
        "background:#1a0a0a;border:1px solid #7f1d1d;color:#e0e0e0"
    ):
        confirm_dlg.open()
        ui.label("Confirmer l'effacement").classes("text-sm font-bold text-red-400 mb-2")
        ui.label(f"Tous les messages de « {state.active_folder} » seront effacés.").classes(
            "text-xs text-gray-400 mb-3"
        )

        def _do():
            from openagenticskyzer.app.storage import clear_chat_history
            clear_chat_history(state.active_folder)
            state.messages = []
            state.artifact_type = ""
            state.artifact_content = ""
            state.show_artifact = False
            from openagenticskyzer.app.components.chat import reset_branches
            reset_branches()
            try:
                from openagenticskyzer.app.components.chat import chat_messages, branch_selector
                chat_messages.refresh()
                branch_selector.refresh()
            except Exception:
                pass
            try:
                from openagenticskyzer.app.components.artifact_panel import artifact_panel
                artifact_panel.refresh()
            except Exception:
                pass
            confirm_dlg.close()
            ui.notify("Historique effacé.", type="positive")

        with ui.row().classes("gap-2"):
            ui.button("Effacer", on_click=_do).classes("bg-red-900 text-red-300 text-xs")
            ui.button("Annuler", on_click=confirm_dlg.close).classes("bg-gray-800 text-xs text-gray-300")


def _open_settings():
    from openagenticskyzer.app.components.settings import render_settings
    render_settings()


def _show_memory():
    from openagenticskyzer.app.state import state

    if not state.active_folder:
        ui.notify("Aucun dossier actif.", type="warning")
        return

    from openagenticskyzer.context.project_memory import load_project_memory
    content = load_project_memory(state.active_folder) or "Aucune mémoire enregistrée pour ce projet."

    with ui.dialog() as dlg, ui.card().classes("w-[600px] max-h-[80vh] overflow-y-auto").style(
        "background:#111;border:1px solid #2a2a2a;color:#e0e0e0"
    ):
        dlg.open()
        ui.label("🧠 Mémoire projet").classes("text-sm font-bold mb-2")
        ui.markdown(content)
        ui.button("Fermer", on_click=dlg.close).classes("bg-gray-800 text-xs text-gray-300 mt-2")


def _open_prompts():
    from openagenticskyzer.app.components.input_bar import _input_refs
    fn = _input_refs.get("open_prompt_picker")
    if fn:
        fn()


def _export_conversation():
    with ui.dialog() as dlg, ui.card().style(
        "background:#111;border:1px solid #2a2a2a;color:#e0e0e0"
    ):
        dlg.open()
        ui.label("Exporter la conversation").classes("text-sm font-bold mb-2")
        # Import différé : convention de ce fichier (voir docstring en tête de
        # module) pour tous les imports cross-module d'actions.
        from openagenticskyzer.app.components.chat import active_branch_label
        ui.label(f"Depuis : {active_branch_label()}").classes("text-xs text-gray-500 mb-2")

        def _pick(fmt: str):
            dlg.close()
            # Import différé obligatoire : main.py importe ce module
            # (render_command_palette), un import module-level ici créerait
            # un cycle.
            from openagenticskyzer.app.main import _do_export
            _do_export(fmt)

        with ui.column().classes("gap-2"):
            ui.button("Markdown (.md)", on_click=lambda: _pick("md")).classes("bg-gray-800 text-xs w-full")
            ui.button("HTML (.html)", on_click=lambda: _pick("html")).classes("bg-gray-800 text-xs w-full")
            ui.button("JSON (.json)", on_click=lambda: _pick("json")).classes("bg-gray-800 text-xs w-full")


def _trigger_compact_action():
    import asyncio
    from openagenticskyzer.app.components.context_bar import trigger_compact
    asyncio.ensure_future(trigger_compact())


# ── Commandes ────────────────────────────────────────────────────────────────
# (label, description, fonction)
_COMMANDS: list[tuple] = [
    ("📂 Ouvrir un dossier", "Sélectionner un nouveau dossier de projet", _open_folder),
    ("🔄 Changer de modèle", "Ouvrir le sélecteur de modèle", _switch_model),
    ("🗑️ Vider l'historique", "Effacer tous les messages du dossier actif", _clear_history),
    ("⚙️ Paramètres", "Ouvrir les paramètres de l'application", _open_settings),
    ("🧠 Voir la mémoire projet", "Afficher la mémoire persistante de ce projet", _show_memory),
    ("📋 Bibliothèque de prompts", "Ouvrir la bibliothèque de prompts", _open_prompts),
    ("⬇ Exporter la conversation", "Exporter la conversation (.md/.html/.json)", _export_conversation),
    ("⚡ Compacter le contexte", "Résumer la conversation pour libérer du contexte", _trigger_compact_action),
]


def _match_commands(commands: list[tuple], query: str) -> list[tuple]:
    """Filtre `commands` (label, desc, fn) sur `query` (insensible à la casse, sous-chaîne
    de label OU desc), plafonné à 8 résultats. Logique pure, testée unitairement —
    voir tests/test_artifacts.py."""
    q = (query or "").lower()
    return [c for c in commands if q in c[0].lower() or q in c[1].lower()][:8]


def render_command_palette():
    """Dialog de palette de commandes, ouvert via Ctrl+K.

    `render_command_palette`/les fonctions d'action ci-dessus restent non
    testées unitairement car couplées à NiceGUI (même limitation documentée
    que pour `_send_message`/`edit_message`/`regenerate` — voir
    tests/test_artifacts.py). Seule `_match_commands` est pure et testée.
    """
    with ui.dialog() as dlg, ui.card().classes("w-[480px]").style(
        "background:#111;border:1px solid #2a2a2a;color:#e0e0e0"
    ):
        search_input = ui.input(placeholder="Rechercher une commande…").classes("w-full text-xs").props("autofocus")
        results_col = ui.column().classes("w-full gap-0 mt-2")

        def _run(fn):
            dlg.close()
            fn()

        def _filter(query: str):
            results_col.clear()
            matches = _match_commands(_COMMANDS, query)
            with results_col:
                if not matches:
                    ui.label("Aucune commande trouvée.").classes("text-xs text-gray-600 px-2 py-2")
                for label, desc, fn in matches:
                    with ui.row().classes(
                        "w-full items-center px-2 py-2 hover:bg-gray-800 rounded cursor-pointer gap-2"
                    ).on("click", lambda fn=fn: _run(fn)):
                        with ui.column().classes("gap-0"):
                            ui.label(label).classes("text-xs text-gray-200")
                            ui.label(desc).classes("text-xs text-gray-600")

        search_input.on_value_change(lambda e: _filter(e.value or ""))

        _filter("")

    def _on_key(e):
        if e.action.keydown and e.key == "k" and e.modifiers.ctrl:
            # set_value("") ne déclenche pas on_value_change si la valeur est
            # déjà vide (pas de changement effectif) — on force donc
            # explicitement le réaffichage de toutes les commandes ici plutôt
            # que de compter sur l'event handler.
            search_input.set_value("")
            _filter("")
            dlg.open()

    # ignore=[] : par défaut ui.keyboard() n'écoute pas les touches tapées
    # pendant que le focus est sur un input/select/button/textarea — or le
    # champ de saisie principal du chat est un ui.textarea (input_bar.py),
    # donc sans ce paramètre Ctrl+K ne fonctionnerait jamais pendant l'usage
    # normal de l'app.
    ui.keyboard(on_key=_on_key, ignore=[])
