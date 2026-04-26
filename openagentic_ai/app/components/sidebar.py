"""Left sidebar — folder history and open-folder button."""
import os
from pathlib import Path
from nicegui import ui

from openagentic_ai.app.state import state
from openagentic_ai.app.storage import load_folder_index, add_folder_to_index


def activate_folder(folder_path: str):
    """Set the active folder in state and persist to index."""
    if not os.path.isdir(folder_path):
        ui.notify(f"Dossier introuvable : {folder_path}", type="negative")
        return
    state.active_folder = folder_path
    state.messages = []
    state.context_pct = 0.0
    add_folder_to_index(folder_path)
    sidebar_list.refresh()
    ui.notify(f"Dossier ouvert : {Path(folder_path).name}", type="positive")


@ui.refreshable
def sidebar_list():
    index = load_folder_index()
    if not index:
        ui.label("Aucune session").classes("text-xs text-gray-600 px-3 py-2")
        return

    for entry in index:
        folder_path = entry.get("path", "")
        name = Path(folder_path).name
        last_used = entry.get("last_used", "")[:10]
        is_active = folder_path == state.active_folder

        border = "border-l-2 border-purple-500 bg-indigo-950" if is_active else "border-l-2 border-transparent"
        label_color = "text-purple-300" if is_active else "text-gray-400"

        with ui.element("div").classes(f"px-3 py-2 cursor-pointer hover:bg-gray-900 {border}") \
                .on("click", lambda p=folder_path: activate_folder(p)):
            ui.label(name).classes(f"text-xs font-semibold truncate {label_color}")
            ui.label(f"{folder_path[:30]}… · {last_used}").classes("text-xs text-gray-600 mt-0.5 truncate")


def render_sidebar():
    with ui.column().classes("h-full").style(
        "width:230px;background:#111;border-right:1px solid #222;flex-shrink:0;gap:0"
    ):
        with ui.element("div").classes("p-2 border-b border-gray-800"):
            def open_folder_prompt():
                with ui.dialog() as dlg, ui.card().classes("bg-gray-900 text-white"):
                    ui.label("Ouvrir un dossier").classes("text-sm font-bold mb-2")
                    path_input = ui.input(placeholder="D:\\chemin\\vers\\projet").classes("w-full")
                    with ui.row():
                        ui.button("Ouvrir", on_click=lambda: (
                            activate_folder(path_input.value), dlg.close()
                        )).classes("bg-purple-600")
                        ui.button("Annuler", on_click=dlg.close).classes("bg-gray-700")
                dlg.open()

            ui.button("📂 Ouvrir un dossier", on_click=open_folder_prompt).classes(
                "w-full bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg"
            )

        ui.label("Historique des dossiers").classes(
            "text-xs text-gray-600 uppercase tracking-widest px-3 pt-2 pb-1"
        )

        with ui.scroll_area().classes("flex-1"):
            sidebar_list()
