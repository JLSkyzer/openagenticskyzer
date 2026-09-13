"""Left sidebar — folder history and open-folder button."""
import asyncio
import os
import subprocess
import threading
from pathlib import Path
from nicegui import ui, run

from openagenticskyzer.app.state import state, DownloadEntry
from openagenticskyzer.app.storage import load_folder_index, add_folder_to_index
from openagenticskyzer.tools.project_analyzer import initialize_project


def _project_init_confirmation(openagent_exists: bool, claude_exists: bool) -> str:
    """Explain the effect of the pending write without changing any files."""
    if openagent_exists:
        return "OPENAGENT.md existe déjà. Écraser vos instructions par une nouvelle analyse ?"
    message = "Créer OPENAGENT.md à partir de l'analyse de ce dossier ?"
    if claude_exists:
        message += " Ce nouveau fichier deviendra prioritaire sur CLAUDE.md."
    return message


def _auto_init_project():
    """Confirm creation or replacement for the folder selected when clicked."""
    if not state.active_folder:
        ui.notify("Ouvre un dossier d'abord.", type="warning")
        return
    try:
        root = Path(state.active_folder).resolve()
        if not root.is_dir():
            ui.notify("Dossier absent ou invalide.", type="negative")
            return
        overwrite = (root / "OPENAGENT.md").exists()
        claude_exists = (root / "CLAUDE.md").exists()
    except (OSError, ValueError) as exc:
        ui.notify(f"Impossible d'accéder au dossier : {exc}", type="negative")
        return

    with ui.dialog() as dialog, ui.card():
        ui.label(_project_init_confirmation(overwrite, claude_exists))
        ui.label(str(root)).classes("text-xs break-all")

        def confirm():
            dialog.close()
            result = initialize_project(root, overwrite=overwrite)
            ui.notify(result.message, type="positive" if result.success else "negative")

        with ui.row():
            ui.button("Confirmer", on_click=confirm)
            ui.button("Annuler", on_click=dialog.close)
    dialog.open()


def open_folder_prompt():
    """Ouvre un dialog pour sélectionner/saisir un dossier de projet à activer.

    Remontée au niveau module (au lieu d'une closure locale de
    render_sidebar) pour être réutilisable ailleurs — voir command_palette.py
    (commande « 📂 Ouvrir un dossier »). Ne capture rien d'autre que
    `activate_folder` et `ui`/`run`, tous déjà importés au niveau module ici.
    """
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


def activate_folder(folder_path: str):
    """Set the active folder in state and persist to index."""
    if not os.path.isdir(folder_path):
        ui.notify(f"Dossier introuvable : {folder_path}", type="negative")
        return
    state.active_folder = folder_path
    _index_folder_async(folder_path)
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
    # L'artifact affiché appartenait à la conversation précédente : le fermer
    # pour éviter qu'un panneau resté ouvert montre un contenu déconnecté du
    # nouvel historique chargé.
    state.artifact_type = ""
    state.artifact_content = ""
    state.show_artifact = False
    # Idem pour les branches : une branche du dossier précédent ne doit jamais
    # être confondue avec le nouvel historique chargé (voir tasks/lessons.md).
    from openagenticskyzer.app.components.chat import reset_branches
    reset_branches()
    try:
        from openagenticskyzer.app.components.input_bar import model_button
        model_button.refresh()
    except Exception:
        pass
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
    sidebar_list.refresh()
    _git_branch_widget.refresh()
    _schedule_git_status_refresh(folder_path)
    ui.notify(f"Dossier ouvert : {Path(folder_path).name}", type="positive")


def _index_folder_async(folder: str) -> None:
    """Index a folder in a daemon worker without blocking the NiceGUI loop."""
    state.index_status = "⏳ Indexation…"

    def worker() -> None:
        try:
            from openagenticskyzer.indexer.indexer import index_folder

            def progress(current, total, _filepath):
                state.index_status = f"📊 Index : {current}/{total}"

            index_folder(folder, on_progress=progress)
            if folder == state.active_folder:
                state.index_status = "✓ Index prêt"
        except (ImportError, RuntimeError):
            state.index_status = ""
        except Exception:
            state.index_status = ""

    threading.Thread(target=worker, name="openagent-index", daemon=True).start()


# Cache clé = chemin du dossier -> (branche, is_dirty). Alimenté hors event loop
# par _fetch_git_status_sync (via run.io_bound) puis lu de façon purement
# synchrone par le refreshable _git_branch_widget.
_GIT_STATUS_CACHE: dict[str, tuple[str, bool]] = {}


def _run_git(args: list[str], cwd: str) -> subprocess.CompletedProcess:
    """Exécute une commande git dans `cwd`, sans fenêtre console sur Windows.

    Appel bloquant : à n'utiliser que depuis un thread worker (run.io_bound).
    """
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=3,
        creationflags=0x08000000 if os.name == "nt" else 0,
    )


def _fetch_git_status_sync(folder: str) -> tuple[str, bool] | None:
    """Travail bloquant (branche + dirty/clean) — exécuté dans un thread worker."""
    try:
        branch_result = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], folder)
        if branch_result.returncode != 0:
            return None
        branch = branch_result.stdout.strip()
        if not branch:
            return None
        status_result = _run_git(["status", "--porcelain"], folder)
        is_dirty = bool(status_result.stdout.strip())
        return branch, is_dirty
    except Exception:
        return None


async def _refresh_git_status(folder: str):
    """Récupère le statut git hors event loop (run.io_bound), puis rafraîchit le widget."""
    if not folder:
        return
    result = await run.io_bound(_fetch_git_status_sync, folder)
    if folder != state.active_folder:
        return  # le dossier actif a changé pendant l'appel — résultat obsolète
    if result is None:
        _GIT_STATUS_CACHE.pop(folder, None)
    else:
        _GIT_STATUS_CACHE[folder] = result
    _git_branch_widget.refresh()


def _schedule_git_status_refresh(folder: str):
    """Planifie _refresh_git_status sans bloquer l'event loop NiceGUI.

    Même idiome que ui.timer(..., once=True) + asyncio.ensure_future utilisé
    dans model_modal.py (_initial_load) : sûr à appeler aussi bien depuis un
    handler de clic déjà dans la boucle asyncio que depuis la construction
    synchrone de la page (render_sidebar), où aucune boucle n'est garantie
    tourner au moment exact de l'appel.
    """
    if not folder:
        return
    ui.timer(0.01, lambda: asyncio.ensure_future(_refresh_git_status(folder)), once=True)


@ui.refreshable
def _git_branch_widget():
    """Affiche la branche git courante + statut dirty/clean du dossier actif.

    Rendu purement synchrone : lit uniquement le cache déjà peuplé par
    _refresh_git_status (jamais de subprocess bloquant sur l'event loop ici).
    """
    if not state.active_folder:
        return
    info = _GIT_STATUS_CACHE.get(state.active_folder)
    if not info:
        return
    branch, is_dirty = info
    indicator = " ●" if is_dirty else " ✓"
    color = "text-yellow-400" if is_dirty else "text-green-400"
    ui.label(f"⎇ {branch}{indicator}").classes(f"text-xs {color} px-3 py-1 font-mono")


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
        "width:230px;height:100%;flex-shrink:0;background:var(--surface,#111);"
        "border-right:1px solid var(--border,#222);display:flex;flex-direction:column;overflow:hidden"
    ):
        with ui.element("div").classes("p-2 border-b border-gray-800"):
            ui.button("📂 Ouvrir un dossier", on_click=open_folder_prompt).classes(
                "w-full bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-lg"
            )
            ui.button("⚡ Init projet", on_click=_auto_init_project).classes("text-xs w-full mt-2")

        _git_branch_widget()
        _schedule_git_status_refresh(state.active_folder)

        ui.label("Historique des dossiers").classes(
            "text-xs text-gray-600 uppercase tracking-widest px-3 pt-2 pb-1"
        )

        with ui.scroll_area().classes("flex-1"):
            sidebar_list()
            _render_knowledge_section()

        downloads_panel()


def _render_knowledge_section():
    try:
        from openagenticskyzer.indexer.knowledge import list_sources
    except ImportError:
        return
    with ui.expansion("📚 Base de connaissances", value=False).classes("w-full"):
        sources = list_sources()
        if not sources:
            ui.label("Aucun document").classes("text-xs text-gray-600 px-2")
        for source in sources:
            ui.label(source[:40]).classes("text-xs text-gray-400 px-2 truncate")
        ui.button("+ Ajouter un document", on_click=_open_knowledge_import).classes(
            "w-full text-xs text-purple-400 bg-transparent border border-purple-900 rounded mt-1 py-1"
        )


def _open_knowledge_import():
    ui.notify("Glisse un fichier .txt ou .md sur l'app pour l'ajouter.", type="info")
