"""Left sidebar — folder history and open-folder button."""
import os
import subprocess
from pathlib import Path
from nicegui import ui, run

from openagenticskyzer.app.state import state, DownloadEntry
from openagenticskyzer.app.storage import load_folder_index, add_folder_to_index


def activate_folder(folder_path: str):
    """Set the active folder in state and persist to index."""
    if not os.path.isdir(folder_path):
        ui.notify(f"Dossier introuvable : {folder_path}", type="negative")
        return
    state.active_folder = folder_path
    state.context_pct = 0.0
    add_folder_to_index(folder_path)
    # Restaure le modèle associé à ce dossier
    from openagenticskyzer.app.storage import load_folder_config, load_chat_history, compute_context_pct
    folder_cfg = load_folder_config(folder_path)
    # Restaure l'historique chat du dossier
    from openagenticskyzer.app.state import ChatMessage
    history_data = load_chat_history(folder_path)
    state.messages = [ChatMessage(**entry) for entry in history_data]
    state.current_model = folder_cfg.get("current_model") or None
    state.current_provider = folder_cfg.get("current_provider") or None
    # Recalcule la jauge de contexte depuis l'historique chargé
    state.context_tokens, state.context_pct = compute_context_pct(state.messages, state.current_provider)
    try:
        from openagenticskyzer.app.components.input_bar import model_button
        model_button.refresh()
    except Exception:
        pass
    try:
        from openagenticskyzer.app.components.chat import chat_messages
        chat_messages.refresh()
    except Exception:
        pass
    sidebar_list.refresh()
    _git_branch_widget.refresh()
    ui.notify(f"Dossier ouvert : {Path(folder_path).name}", type="positive")


@ui.refreshable
def _git_branch_widget():
    """Affiche la branche git courante + statut dirty/clean du dossier actif."""
    if not state.active_folder:
        return
    try:
        creationflags = 0x08000000 if os.name == "nt" else 0
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=state.active_folder,
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=creationflags,
        )
        if branch_result.returncode != 0:
            return
        branch = branch_result.stdout.strip()
        if not branch:
            return
        status_result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=state.active_folder,
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=creationflags,
        )
        is_dirty = bool(status_result.stdout.strip())
        indicator = " ●" if is_dirty else " ✓"
        color = "text-yellow-400" if is_dirty else "text-green-400"
        ui.label(f"⎇ {branch}{indicator}").classes(f"text-xs {color} px-3 py-1 font-mono")
    except Exception:
        pass


@ui.refreshable
def downloads_panel():
    active = [d for d in state.downloads if not d.done and not d.error]
    done = [d for d in state.downloads if d.done]
    errors = [d for d in state.downloads if d.error]
    if not state.downloads:
        return
    with ui.element("div").style(
        "border-top:1px solid #222;padding:6px 8px;flex-shrink:0;background:#0d0d0d"
    ):
        ui.label("Téléchargements").classes("text-xs text-gray-600 uppercase tracking-widest mb-1")
        for dl in active:
            with ui.row().classes("items-center gap-1 py-0.5"):
                ui.spinner(size="xs").classes("text-purple-400")
                with ui.column().classes("flex-1 gap-0 min-w-0"):
                    ui.label(dl.name).classes("text-xs text-gray-300 truncate")
                    ui.label(dl.progress).classes("text-xs text-gray-600 truncate font-mono")
        for dl in done:
            with ui.row().classes("items-center gap-1 py-0.5"):
                ui.label("✅").classes("text-xs")
                ui.label(dl.name).classes("text-xs text-gray-500 truncate flex-1")
                ui.button("×", on_click=lambda d=dl: (state.downloads.remove(d), downloads_panel.refresh())).classes(
                    "text-xs text-gray-700 w-4 h-4 p-0"
                ).props("flat dense")
        for dl in errors:
            with ui.row().classes("items-center gap-1 py-0.5"):
                ui.label("❌").classes("text-xs")
                ui.label(dl.name).classes("text-xs text-red-500 truncate flex-1")
                ui.button("×", on_click=lambda d=dl: (state.downloads.remove(d), downloads_panel.refresh())).classes(
                    "text-xs text-gray-700 w-4 h-4 p-0"
                ).props("flat dense")


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
    with ui.element("div").style(
        "width:230px;height:100%;flex-shrink:0;background:#111;"
        "border-right:1px solid #222;display:flex;flex-direction:column;overflow:hidden"
    ):
        with ui.element("div").classes("p-2 border-b border-gray-800"):
            def open_folder_prompt():
                with ui.dialog() as dlg, ui.card().classes("bg-gray-900 text-white"):
                    ui.label("Ouvrir un dossier").classes("text-sm font-bold mb-2")
                    path_input = ui.input(placeholder="D:\\chemin\\vers\\projet").classes("w-full")

                    async def _pick_folder():
                        def _tkpick():
                            import tkinter as tk
                            from tkinter import filedialog
                            root = tk.Tk()
                            root.withdraw()
                            root.attributes("-topmost", True)
                            folder = filedialog.askdirectory(title="Sélectionner un dossier")
                            root.destroy()
                            return folder or ""
                        picked = await run.io_bound(_tkpick)
                        if picked:
                            path_input.set_value(picked)

                    with ui.row().classes("items-center gap-2 mt-1"):
                        ui.button("📁 Parcourir…", on_click=_pick_folder).classes(
                            "bg-gray-800 border border-gray-700 text-xs text-gray-300 hover:border-purple-500"
                        )
                    with ui.row().classes("mt-2"):
                        ui.button("Ouvrir", on_click=lambda: (
                            activate_folder(path_input.value), dlg.close()
                        )).classes("bg-purple-600")
                        ui.button("Annuler", on_click=dlg.close).classes("bg-gray-700")
                dlg.open()

            ui.button("📂 Ouvrir un dossier", on_click=open_folder_prompt).classes(
                "w-full bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg"
            )

        _git_branch_widget()

        ui.label("Historique des dossiers").classes(
            "text-xs text-gray-600 uppercase tracking-widest px-3 pt-2 pb-1"
        )

        with ui.scroll_area().classes("flex-1"):
            sidebar_list()

        downloads_panel()
