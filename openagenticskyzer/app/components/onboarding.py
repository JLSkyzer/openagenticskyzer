"""Premier lancement : wizard léger et non bloquant pour configurer l'application."""
from __future__ import annotations

from nicegui import ui


def _load_global_config() -> dict:
    from openagenticskyzer.app.storage import load_global_config

    return load_global_config()


def _save_global_config(config: dict) -> None:
    from openagenticskyzer.app.storage import save_global_config

    save_global_config(config)


def should_show_onboarding() -> bool:
    """Return whether the user has not completed the first-launch wizard."""
    return not bool(_load_global_config().get("onboarding_done", False))


def _next_step(step: list[int], dialog, target: int) -> int:
    """Update wizard state and refresh the dialog when a test/UI double supports it."""
    step[0] = target
    if dialog is not None and hasattr(dialog, "update"):
        dialog.update()
    return target


def _set_step(containers: list, step: list[int], target: int) -> int:
    """Show exactly one wizard container."""
    step[0] = target
    for index, container in enumerate(containers, start=1):
        container.set_visibility(index == target)
    return target


def _open_model_settings() -> None:
    from openagenticskyzer.app.components.model_modal import open_model_modal

    open_model_modal()


def _open_folder() -> None:
    from openagenticskyzer.app.components.sidebar import open_folder_prompt

    open_folder_prompt()


@ui.refreshable
def onboarding_wizard() -> None:
    """Render the four-step first-launch wizard once per page."""
    if not should_show_onboarding():
        return

    step = [1]
    with ui.dialog() as dialog:
        dialog.props("persistent")
        with ui.card().classes("w-96 p-6 gap-4"):
            containers = []
            with ui.column() as welcome:
                ui.label("👋 Bienvenue dans OpenAgentic Skyzer !").classes("text-xl font-bold")
                ui.label(
                    "Un agent IA local, puissant et privé. Ce wizard vous guide en quatre étapes."
                ).classes("text-sm text-gray-400")
                ui.button("Commencer →", on_click=lambda: _set_step(containers, step, 2)).classes(
                    "mt-4 w-full"
                )
            containers.append(welcome)

            with ui.column() as model:
                ui.label("🤖 Choisissez votre modèle").classes("text-lg font-bold")
                ui.label("Configurez le fournisseur et le modèle à utiliser.").classes("text-sm text-gray-400")
                ui.button("⚙️ Ouvrir les paramètres du modèle", on_click=_open_model_settings).classes(
                    "w-full mt-2"
                )
                with ui.row().classes("mt-4 w-full justify-between"):
                    ui.button("← Retour", on_click=lambda: _set_step(containers, step, 1)).props("flat")
                    ui.button("Suivant →", on_click=lambda: _set_step(containers, step, 3))
            containers.append(model)

            with ui.column() as folder:
                ui.label("📁 Ouvrez un projet").classes("text-lg font-bold")
                ui.label("Le dossier actif permet à l'agent de connaître votre code.").classes(
                    "text-sm text-gray-400"
                )
                ui.button("📂 Ouvrir un dossier", on_click=_open_folder).classes("w-full mt-2")
                with ui.row().classes("mt-4 w-full justify-between"):
                    ui.button("← Retour", on_click=lambda: _set_step(containers, step, 2)).props("flat")
                    ui.button("Passer", on_click=lambda: _set_step(containers, step, 4)).props("flat")
            containers.append(folder)

            with ui.column() as done:
                ui.label("🎉 C'est parti !").classes("text-xl font-bold")
                ui.label("Quelques raccourcis utiles :").classes("text-sm text-gray-400")
                with ui.column().classes("text-xs font-mono gap-1 mt-2"):
                    ui.label("Ctrl+L — Effacer la conversation")
                    ui.label("Ctrl+, — Paramètres")
                    ui.label("Ctrl+K — Palette de commandes")
                    ui.label("Ctrl+Entrée — Envoyer le message")
                ui.button("Commencer à coder 🚀", on_click=lambda: _finish(dialog)).classes("mt-4 w-full")
            containers.append(done)

            _set_step(containers, step, 1)
        dialog.open()


def _finish(dialog) -> None:
    """Persist completion and close the current dialog."""
    config = _load_global_config()
    config["onboarding_done"] = True
    _save_global_config(config)
    if dialog is not None and hasattr(dialog, "close"):
        dialog.close()

