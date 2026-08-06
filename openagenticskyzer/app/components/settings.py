"""Settings panel — replaces main area when opened."""
from pathlib import Path
from nicegui import ui

from openagenticskyzer.app.state import state
from openagenticskyzer.app.storage import (
    load_global_config, save_global_config,
    load_folder_config, save_folder_config,
    remove_folder_from_index, delete_folder_sessions,
    migrate_data_dir, get_data_home,
    clear_chat_history,
    DEFAULT_GLOBAL_CONFIG,
)
from openagenticskyzer.utils.utils import _DEFAULT_CTX_LIMITS


def _group():
    return ui.element("div").classes("rounded-xl overflow-hidden border border-gray-800").style("background:#111")


def _section(title: str, badge: str = ""):
    badge_html = (
        f'<span style="background:#1e1e2e;color:#8b5cf6;font-size:10px;'
        f'padding:1px 6px;border-radius:3px;font-weight:600;margin-left:6px">{badge}</span>'
        if badge else ""
    )
    ui.html(f'<div style="font-size:15px;font-weight:700;color:#e0e0e0;margin-bottom:4px">{title}{badge_html}</div>')


# ── Onglet Général ────────────────────────────────────────────────────────────

def _tab_general(cfg: dict):
    with ui.column().classes("gap-5"):
        _section("Général", "GLOBAL")
        with _group():
            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Mode agent par défaut").classes("text-xs text-gray-300 font-medium")
                    ui.label("Mode utilisé à l'ouverture de chaque dossier").classes("text-xs text-gray-600")
                ui.radio(["ask", "auto", "plan"], value=cfg.get("agent_mode", "auto")).classes("text-xs").bind_value_to(cfg, "agent_mode")

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Démarrer dans le dernier dossier").classes("text-xs text-gray-300 font-medium")
                    ui.label("Rouvre la dernière session au lancement").classes("text-xs text-gray-600")
                ui.switch(value=cfg.get("restore_last_folder", True)).bind_value_to(cfg, "restore_last_folder")

            with ui.row().classes("items-center px-4 py-3 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Animations").classes("text-xs text-gray-300 font-medium")
                    ui.label("Transitions et effets visuels").classes("text-xs text-gray-600")
                ui.switch(value=cfg.get("animations", True)).bind_value_to(cfg, "animations")

        # ── Données & Stockage ─────────────────────────────────────────────
        _section("Données & Stockage")
        with _group():
            with ui.column().classes("px-4 py-3 gap-2"):
                ui.label("Répertoire de données").classes("text-xs text-gray-300 font-medium")
                ui.label(
                    "Historiques, sessions et configuration. Déplacez-le sur un disque secondaire "
                    "pour préserver votre disque principal."
                ).classes("text-xs text-gray-600")

                current_data_home = str(get_data_home())
                with ui.row().classes("items-center gap-2 mt-1"):
                    ui.label(current_data_home).classes(
                        "text-xs text-blue-400 font-mono flex-1 truncate px-2 py-1 rounded"
                    ).style("background:#0a0a1a;border:1px solid #1e1e3a")

                def open_data_dir_dialog():
                    with ui.dialog() as dlg:
                        dlg.open()
                        with ui.card().classes("w-[540px]").style("background:#111;border:1px solid #2a2a2a;color:#e0e0e0"):
                            ui.label("Changer le répertoire de données").classes("text-sm font-bold mb-1")
                            ui.label(f"Actuel : {current_data_home}").classes("text-xs text-gray-500 font-mono mb-3")

                            path_input = ui.input(
                                placeholder="Ex: D:\\openagent_data",
                                value=current_data_home,
                            ).classes("w-full text-xs font-mono")

                            migrate_sw = ui.switch(
                                "Migrer les sessions existantes vers le nouveau dossier", value=True
                            ).classes("text-xs mt-2")

                            with ui.row().classes("gap-2 items-start p-2 rounded border border-yellow-900 my-3").style("background:#1a1200"):
                                ui.label("⚠️").classes("text-sm flex-shrink-0")
                                ui.label("Redémarrez l'app après le changement pour que tout soit pris en compte.").classes("text-xs text-yellow-600")

                            status_lbl = ui.label("").classes("text-xs text-gray-500 font-mono min-h-4")

                            def _apply():
                                new_dir = path_input.value.strip()
                                if not new_dir:
                                    ui.notify("Chemin vide.", type="warning")
                                    return
                                p = Path(new_dir)
                                try:
                                    p.mkdir(parents=True, exist_ok=True)
                                except Exception as exc:
                                    ui.notify(f"Impossible de créer : {exc}", type="negative")
                                    return

                                if migrate_sw.value:
                                    moved, errors = migrate_data_dir(new_dir)
                                    if errors:
                                        status_lbl.set_text(f"⚠️ {moved} migré(s), {len(errors)} erreur(s).")
                                    else:
                                        status_lbl.set_text(f"✅ {moved} session(s) migrée(s).")
                                else:
                                    c = load_global_config()
                                    c["data_dir"] = new_dir
                                    save_global_config(c)
                                    status_lbl.set_text(f"✅ Configuré : {new_dir}")

                                ui.notify("Redémarrez l'app pour appliquer.", type="info")

                            with ui.row().classes("gap-2 justify-end mt-2"):
                                ui.button("Appliquer", on_click=_apply).classes("bg-purple-600 text-xs text-white")
                                ui.button("Annuler", on_click=dlg.close).classes("bg-gray-800 text-xs text-gray-300")

                ui.button("📁 Changer le dossier…", on_click=open_data_dir_dialog).classes(
                    "bg-gray-900 border border-gray-700 text-xs text-gray-300 hover:border-purple-500 mt-1"
                )

        # ── HuggingFace ────────────────────────────────────────────────────────
        _section("HuggingFace")
        with _group():
            with ui.column().classes("px-4 py-3 gap-2"):
                ui.label("Token d'accès HuggingFace").classes("text-xs text-gray-300 font-medium")
                ui.label(
                    "Lève les limites de débit anonymous du CDN HuggingFace. "
                    "Aucune permission requise — le token sert uniquement à identifier votre compte. "
                    "Créez-en un sur huggingface.co → Settings → Access Tokens."
                ).classes("text-xs text-gray-600")

                with ui.row().classes("items-center gap-2 w-full mt-1"):
                    token_inp = ui.input(
                        placeholder="hf_…",
                        value=cfg.get("hf_token", ""),
                    ).props("outlined dense clearable").classes(
                        "flex-1 text-xs font-mono"
                    ).style("background:#1a1a1a")
                    token_inp.bind_value_to(cfg, "hf_token")

                    # Bouton afficher/masquer
                    _show = {"v": False}
                    def _toggle_show():
                        _show["v"] = not _show["v"]
                        token_inp.props("type=text" if _show["v"] else "type=password")
                    ui.button("👁", on_click=_toggle_show).classes(
                        "w-8 h-8 bg-gray-900 border border-gray-700 text-xs text-gray-400 rounded"
                    ).props("flat dense")

                token_inp.props("type=password")

                def _test_token():
                    tok = (cfg.get("hf_token") or "").strip()
                    if not tok:
                        ui.notify("Token vide.", type="warning")
                        return
                    import urllib.request as _ur
                    try:
                        req = _ur.Request(
                            "https://huggingface.co/api/whoami-v2",
                            headers={"Authorization": f"Bearer {tok}"},
                        )
                        import json as _json
                        with _ur.urlopen(req, timeout=8) as r:
                            info = _json.loads(r.read())
                        ui.notify(f"✅ Connecté en tant que {info.get('name', '?')}", type="positive")
                    except Exception as exc:
                        ui.notify(f"❌ Token invalide : {exc}", type="negative")

                ui.button("Tester le token", on_click=_test_token).classes(
                    "bg-gray-900 border border-gray-700 text-xs text-gray-300 hover:border-purple-500 mt-1 self-start"
                )


# ── Onglet Contexte ───────────────────────────────────────────────────────────

def _tab_context(cfg: dict):
    provider = state.current_provider or "ollama"
    ctx_max = _DEFAULT_CTX_LIMITS.get(provider, 32_000)

    with ui.column().classes("gap-5"):
        _section("Contexte & Mémoire", "GLOBAL")

        with _group():
            with ui.column().classes("px-4 py-3 border-b border-gray-900 gap-2"):
                ui.label("Limite de contexte").classes("text-xs text-gray-300 font-medium")
                ui.label(f"Max du modèle actif ({provider}) : {ctx_max:,} tokens").classes("text-xs text-gray-500")
                current_max = cfg.get("max_tokens") or ctx_max // 2
                slider = ui.slider(min=2000, max=ctx_max, value=current_max, step=1000).classes("w-full")
                slider_label = ui.label(f"{current_max:,} tokens").classes("text-xs text-purple-400")
                slider.on("update:model-value", lambda e: (
                    slider_label.set_text(f"{int(e.args):,} tokens"),
                    cfg.update({"max_tokens": int(e.args)}),
                ))
                if provider == "ollama":
                    with ui.row().classes("gap-2 items-start p-2 rounded border border-yellow-900").style("background:#1a1200"):
                        ui.label("⚠️").classes("text-sm")
                        ui.label("Ollama : le contexte réel dépend de votre VRAM/RAM.").classes("text-xs text-yellow-600")

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Tokens réservés pour la réponse").classes("text-xs text-gray-300 font-medium")
                    ui.label("Espace toujours gardé libre pour la génération").classes("text-xs text-gray-600")
                ui.number(value=cfg.get("reserved_tokens", 2048), min=512, max=8192, step=256).classes("w-24 text-xs").bind_value_to(cfg, "reserved_tokens")

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Auto-compact").classes("text-xs text-gray-300 font-medium")
                    ui.label("Compresse l'historique avant d'atteindre la limite").classes("text-xs text-gray-600")
                ui.switch(value=cfg.get("auto_compact", True)).bind_value_to(cfg, "auto_compact")

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    threshold_lbl = ui.label(f"Seuil auto-compact : {cfg.get('compact_threshold', 70)}%").classes("text-xs text-gray-300 font-medium")
                    ui.label("Déclenche la compression à ce % d'utilisation").classes("text-xs text-gray-600")
                threshold_slider = ui.slider(min=40, max=95, value=cfg.get("compact_threshold", 70), step=5).classes("w-32")
                threshold_slider.on("update:model-value", lambda e: (
                    threshold_lbl.set_text(f"Seuil auto-compact : {int(e.args)}%"),
                    cfg.update({"compact_threshold": int(e.args)}),
                ))

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Afficher la jauge de contexte").classes("text-xs text-gray-300 font-medium")
                ui.switch(value=cfg.get("show_context_bar", True)).bind_value_to(cfg, "show_context_bar")

            with ui.row().classes("items-center px-4 py-3 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Rétention des sessions").classes("text-xs text-gray-300 font-medium")
                    ui.label("Durée de conservation de l'historique").classes("text-xs text-gray-600")
                ui.select({7: "7 jours", 30: "30 jours", 90: "90 jours", 0: "Indéfiniment"},
                          value=cfg.get("session_retention_days", 30)).classes("text-xs w-32").bind_value_to(cfg, "session_retention_days")


# ── Onglet Permissions ────────────────────────────────────────────────────────

def _tab_permissions(cfg: dict):
    with ui.column().classes("gap-5"):
        _section("Permissions", "GLOBAL")
        with _group():
            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Niveau de permission").classes("text-xs text-gray-300 font-medium")
                    ui.label("Demander = bannière | Auto = tout passer | Strict = lecture seule").classes("text-xs text-gray-600")
                ui.select(
                    {"demander": "Demander", "auto": "Auto (bypass)", "strict": "Strict (lecture)"},
                    value=cfg.get("permission_mode", "demander")
                ).classes("text-xs w-40").bind_value_to(cfg, "permission_mode")

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Exécution shell (run_command)").classes("text-xs text-gray-300 font-medium")
                ui.switch(value=cfg.get("shell_ask", True)).bind_value_to(cfg, "shell_ask")

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Écriture / suppression de fichiers").classes("text-xs text-gray-300 font-medium")
                ui.switch(value=cfg.get("files_ask", False)).bind_value_to(cfg, "files_ask")

            with ui.row().classes("items-center px-4 py-3 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Recherche internet").classes("text-xs text-gray-300 font-medium")
                ui.switch(value=cfg.get("search_ask", False)).bind_value_to(cfg, "search_ask")


# ── Onglet Dossier ────────────────────────────────────────────────────────────

def _tab_folder():
    if not state.active_folder:
        ui.label("Aucun dossier actif.").classes("text-xs text-gray-600")
        return
    folder_cfg = load_folder_config(state.active_folder)
    folder_name = Path(state.active_folder).name

    with ui.column().classes("gap-5"):
        _section(f"Paramètres de {folder_name}", "DOSSIER")
        with ui.row().classes("items-center gap-2 px-3 py-2 rounded-lg border border-indigo-900").style("background:#111"):
            ui.label("📁").classes("text-sm")
            ui.label(state.active_folder).classes("text-xs text-blue-400 font-mono")

        with _group():
            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Mode agent pour ce dossier").classes("text-xs text-gray-300 font-medium")
                ui.select(["inherit", "ask", "auto", "plan"], value=folder_cfg.get("agent_mode", "inherit")).classes("text-xs w-28").bind_value_to(folder_cfg, "agent_mode")

            with ui.row().classes("items-center px-4 py-3 border-b border-gray-900 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Fichiers ignorés").classes("text-xs text-gray-300 font-medium")
                    ui.label("Patterns exclus de la lecture (style .gitignore)").classes("text-xs text-gray-600")
                ui.input(value=folder_cfg.get("ignored_patterns", "node_modules/, .env")).classes("text-xs w-56 font-mono").bind_value_to(folder_cfg, "ignored_patterns")

            with ui.row().classes("items-center px-4 py-3 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Contexte système personnalisé").classes("text-xs text-gray-300 font-medium")
                    ui.label("Instructions injectées au début de chaque session").classes("text-xs text-gray-600")

                def open_prompt_editor():
                    with ui.dialog() as d:
                        d.open()
                        with ui.card().classes("w-[600px]").style("background:#111;color:#e0e0e0"):
                            ui.label("Contexte système personnalisé").classes("text-sm font-bold mb-2")
                            area = ui.textarea(value=folder_cfg.get("custom_prompt", "")).classes("w-full h-48 font-mono text-xs")
                            with ui.row().classes("justify-end gap-2 mt-2"):
                                ui.button("Enregistrer", on_click=lambda: (
                                    folder_cfg.update({"custom_prompt": area.value}),
                                    save_folder_config(state.active_folder, folder_cfg),
                                    ui.notify("Contexte sauvegardé", type="positive"),
                                    d.close()
                                )).classes("bg-purple-600 text-xs text-white")
                                ui.button("Annuler", on_click=d.close).classes("bg-gray-800 text-xs")

                ui.button("✏️ Éditer", on_click=open_prompt_editor).classes("bg-indigo-900 text-xs text-indigo-300")

        ui.button(
            "Enregistrer les paramètres du dossier",
            on_click=lambda: (
                save_folder_config(state.active_folder, folder_cfg),
                ui.notify("Paramètres dossier sauvegardés", type="positive"),
            )
        ).classes("bg-purple-700 text-xs text-white mt-2")


# ── Onglet Danger ─────────────────────────────────────────────────────────────

def _tab_danger(cfg: dict):
    with ui.column().classes("gap-5"):
        ui.label("Zone Danger").classes("text-sm font-bold text-red-400")
        with ui.element("div").classes("rounded-xl overflow-hidden border border-red-900").style("background:#120a0a"):

            # Effacer l'historique du dossier actif
            with ui.row().classes("items-center px-4 py-3 border-b border-red-950 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Effacer l'historique du dossier actif").classes("text-xs text-red-300 font-medium")
                    ui.label("Supprime toutes les sessions JSON enregistrées pour ce dossier.").classes("text-xs text-red-900")

                def _confirm_delete():
                    if not state.active_folder:
                        ui.notify("Aucun dossier actif.", type="warning")
                        return
                    with ui.dialog() as confirm_dlg:
                        confirm_dlg.open()
                        with ui.card().style("background:#1a0a0a;border:1px solid #7f1d1d;color:#e0e0e0"):
                            ui.label("Confirmer la suppression").classes("text-sm font-bold text-red-400 mb-2")
                            ui.label(state.active_folder).classes("text-xs text-gray-400 font-mono mb-3")
                            with ui.row().classes("gap-2"):
                                def _do():
                                    n = delete_folder_sessions(state.active_folder)
                                    clear_chat_history(state.active_folder)
                                    state.messages = []
                                    state.artifact_type = ""
                                    state.artifact_content = ""
                                    state.show_artifact = False
                                    try:
                                        from openagenticskyzer.app.components.chat import chat_messages
                                        chat_messages.refresh()
                                    except Exception:
                                        pass
                                    try:
                                        from openagenticskyzer.app.components.artifact_panel import artifact_panel
                                        artifact_panel.refresh()
                                    except Exception:
                                        pass
                                    confirm_dlg.close()
                                    ui.notify(f"{n} session(s) supprimée(s).", type="positive")
                                ui.button("Supprimer", on_click=_do).classes("bg-red-900 text-red-300 text-xs")
                                ui.button("Annuler", on_click=confirm_dlg.close).classes("bg-gray-800 text-xs text-gray-300")

                ui.button("🗑 Effacer", on_click=_confirm_delete).classes("bg-red-950 text-red-400 text-xs border border-red-900")

            # Retirer ce dossier de la sidebar
            with ui.row().classes("items-center px-4 py-3 border-b border-red-950 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Retirer ce dossier de la sidebar").classes("text-xs text-red-300 font-medium")
                    ui.label("Ne supprime pas les fichiers, retire juste l'entrée de l'historique.").classes("text-xs text-red-900")

                def _remove_sidebar():
                    if not state.active_folder:
                        ui.notify("Aucun dossier actif.", type="warning")
                        return
                    folder = state.active_folder
                    remove_folder_from_index(folder)
                    state.active_folder = None
                    state.messages = []
                    state.artifact_type = ""
                    state.artifact_content = ""
                    state.show_artifact = False
                    try:
                        from openagenticskyzer.app.components.sidebar import sidebar_list
                        from openagenticskyzer.app.components.chat import chat_messages
                        from openagenticskyzer.app.components.artifact_panel import artifact_panel
                        sidebar_list.refresh()
                        chat_messages.refresh()
                        artifact_panel.refresh()
                    except Exception:
                        pass
                    ui.notify("Dossier retiré de la sidebar.", type="positive")

                ui.button("✕ Retirer", on_click=_remove_sidebar).classes("bg-red-950 text-red-400 text-xs border border-red-900")

            # Reset global
            with ui.row().classes("items-center px-4 py-3 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Réinitialiser tous les paramètres globaux").classes("text-xs text-red-300 font-medium")

                def _reset_all():
                    save_global_config(DEFAULT_GLOBAL_CONFIG.copy())
                    ui.notify("Paramètres réinitialisés.", type="positive")

                ui.button("↺ Réinitialiser", on_click=_reset_all).classes("bg-red-950 text-red-400 text-xs border border-red-900")


# ── Point d'entrée ────────────────────────────────────────────────────────────

def render_settings():
    """Opens settings as a full overlay dialog."""
    with ui.dialog().props("maximized") as dlg:
        dlg.open()
        with ui.row().classes("w-full h-full").style("gap:0;background:#0d0d0d"):
            with ui.column().classes("py-4").style("width:200px;background:#111;border-right:1px solid #1e1e1e;gap:0"):
                ui.label("Paramètres").classes("text-xs text-gray-600 uppercase tracking-widest px-4 pb-2")
                tabs = ui.tabs().classes("flex-col w-full").props("vertical")
                with tabs:
                    ui.tab("general", label="🌐 Général")
                    ui.tab("context", label="🧠 Contexte & Mémoire")
                    ui.tab("permissions", label="🔒 Permissions")
                    ui.tab("folder", label=f"📁 {Path(state.active_folder).name if state.active_folder else 'Dossier'}")
                    ui.tab("danger", label="⚠️ Danger")

            with ui.scroll_area().classes("flex-1 h-full p-8"):
                cfg = load_global_config()
                with ui.tab_panels(tabs, value="general").classes("w-full"):
                    with ui.tab_panel("general"):
                        _tab_general(cfg)
                    with ui.tab_panel("context"):
                        _tab_context(cfg)
                    with ui.tab_panel("permissions"):
                        _tab_permissions(cfg)
                    with ui.tab_panel("folder"):
                        _tab_folder()
                    with ui.tab_panel("danger"):
                        _tab_danger(cfg)

                with ui.row().classes("mt-6 gap-2"):
                    ui.button("Enregistrer", on_click=lambda: (
                        save_global_config(cfg),
                        state.__setattr__("permission_mode", cfg.get("permission_mode", "demander")),
                        ui.notify("Paramètres sauvegardés.", type="positive"),
                    )).classes("bg-purple-600 text-xs text-white")
                    ui.button("Fermer", on_click=dlg.close).classes("bg-gray-800 text-xs text-gray-300")
