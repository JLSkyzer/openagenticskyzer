"""Downloads dialog — accessible depuis la top bar, indépendant de la modale modèle."""
from nicegui import ui
from openagenticskyzer.app.state import state


def open_downloads_dialog():
    with ui.dialog().props("persistent") as dlg:
        dlg.open()
        with ui.card().style(
            "width:520px;max-width:96vw;background:#111;border:1px solid #2a2a2a;"
            "color:#e0e0e0;max-height:80vh;display:flex;flex-direction:column;padding:16px"
        ):
            with ui.row().classes("items-center w-full mb-3"):
                ui.label("📥 Téléchargements").classes("text-sm font-bold text-gray-200 flex-1")
                ui.button("✕", on_click=dlg.close).classes(
                    "text-xs text-gray-500 w-7 h-7 bg-gray-900 border border-gray-800 rounded"
                ).props("flat dense")

            cnt_lbl = ui.label("").classes("text-xs text-gray-600 mb-2")
            dl_box = ui.column().classes("w-full gap-2 flex-1 overflow-y-auto").style("max-height:55vh")
            actions_row = ui.row().classes("justify-end mt-2 w-full")

            # Snapshot structurel pour détecter les changements (ajout, done, error)
            _snapshot: list = []

            def _current_snapshot():
                return [(d.dl_id, d.done, d.error) for d in state.downloads]

            def _rebuild():
                dl_box.clear()
                actions_row.clear()
                _snapshot.clear()
                _snapshot.extend(_current_snapshot())

                active = sum(1 for d in state.downloads if not d.done and not d.error)
                done = sum(1 for d in state.downloads if d.done)
                errors = sum(1 for d in state.downloads if d.error)

                if not state.downloads:
                    cnt_lbl.set_text("Aucun téléchargement.")
                    with dl_box:
                        ui.label("Lancez un téléchargement depuis le catalogue LM Studio.").classes(
                            "text-xs text-gray-700 py-6 text-center w-full"
                        )
                    return

                parts = []
                if active:
                    parts.append(f"{active} en cours")
                if done:
                    parts.append(f"{done} terminé(s)")
                if errors:
                    parts.append(f"{errors} erreur(s)")
                cnt_lbl.set_text(" · ".join(parts))

                with dl_box:
                    for dl in state.downloads:
                        if dl.error:
                            icon, icon_cls = "❌", ""
                            bg = "bg-red-950"
                        elif dl.done:
                            icon, icon_cls = "✅", ""
                            bg = "bg-gray-900"
                        else:
                            icon, icon_cls = "", "text-purple-400"
                            bg = "bg-gray-900"

                        with ui.row().classes(f"items-center gap-3 py-2 px-3 rounded {bg} w-full"):
                            if icon_cls:
                                ui.spinner(size="sm").classes(icon_cls + " flex-shrink-0")
                            else:
                                ui.label(icon).classes("text-sm flex-shrink-0")

                            with ui.column().classes("flex-1 gap-0 min-w-0"):
                                ui.label(dl.name).classes("text-xs text-gray-200 font-semibold truncate")
                                # bind_text_from : NiceGUI observe dl.progress et met à jour le label
                                # automatiquement — fonctionne même depuis un thread background
                                ui.label("").bind_text_from(dl, "progress").classes(
                                    "text-xs text-gray-500 font-mono truncate"
                                )
                                ui.label(dl.provider).classes("text-xs text-gray-700")

                            if dl.done or dl.error:
                                def _rm(d=dl):
                                    if d in state.downloads:
                                        state.downloads.remove(d)
                                    _rebuild()
                                ui.button("×", on_click=_rm).classes(
                                    "text-xs text-gray-600 w-6 h-6"
                                ).props("flat dense")

                finished = [d for d in state.downloads if d.done or d.error]
                if finished:
                    with actions_row:
                        def _clear_done():
                            for d in finished:
                                if d in state.downloads:
                                    state.downloads.remove(d)
                            _rebuild()
                        ui.button("🗑 Effacer terminés", on_click=_clear_done).classes(
                            "text-xs bg-gray-800 text-gray-400 border border-gray-700 px-2 py-1 rounded"
                        )

            _rebuild()

            def _tick():
                # Reconstruction uniquement si structure change (nouveau dl, done, error)
                if _current_snapshot() != _snapshot:
                    _rebuild()

            ui.timer(1.0, _tick)


def make_downloads_top_btn():
    """Crée le bouton 📥 statique (non-refreshable) — retourne le label interne pour mise à jour."""
    with ui.button(on_click=open_downloads_dialog).classes(
        "h-7 px-2 bg-gray-900 border border-gray-800 text-gray-500 text-xs rounded"
    ):
        lbl = ui.label("📥").classes("text-xs leading-none")
    return lbl
