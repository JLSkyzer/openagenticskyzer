"""Settings panel — replaces main area when opened."""
from pathlib import Path
from nicegui import ui

from openagentic_ai.app.state import state
from openagentic_ai.app.storage import (
    load_global_config, save_global_config,
    load_folder_config, save_folder_config,
    DEFAULT_GLOBAL_CONFIG,
)
from openagentic_ai.utils.utils import _DEFAULT_CTX_LIMITS


def _group():
    return ui.element("div").classes("rounded-xl overflow-hidden border border-gray-800").style("background:#111")


def _section(title: str, badge: str = ""):
    badge_html = (
        f'<span style="background:#1e1e2e;color:#8b5cf6;font-size:10px;'
        f'padding:1px 6px;border-radius:3px;font-weight:600;margin-left:6px">{badge}</span>'
        if badge else ""
    )
    ui.html(f'<div style="font-size:15px;font-weight:700;color:#e0e0e0;margin-bottom:4px">{title}{badge_html}</div>')


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
                ui.switch(value=cfg.get("animations", True)).bind_value_to(cfg, "animations")
            with ui.row().classes("items-center px-4 py-3 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Animations").classes("text-xs text-gray-300 font-medium")
                    ui.label("Transitions et effets visuels").classes("text-xs text-gray-600")
                ui.switch(value=cfg.get("animations", True)).bind_value_to(cfg, "animations")


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
                        ui.label("Ollama : le contexte réel dépend de votre VRAM/RAM. Vérifiez avec ollama ps").classes("text-xs text-yellow-600")

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
                    ui.label(f"Seuil auto-compact : {cfg.get('compact_threshold', 70)}%").classes("text-xs text-gray-300 font-medium")
                    ui.label("Déclenche la compression à ce % d'utilisation").classes("text-xs text-gray-600")
                ui.slider(min=40, max=95, value=cfg.get("compact_threshold", 70), step=5).classes("w-32").bind_value_to(cfg, "compact_threshold")

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


def _tab_danger(cfg: dict):
    with ui.column().classes("gap-5"):
        ui.label("Zone Danger").classes("text-sm font-bold text-red-400")
        with ui.element("div").classes("rounded-xl overflow-hidden border border-red-900").style("background:#120a0a"):
            with ui.row().classes("items-center px-4 py-3 border-b border-red-950 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Effacer l'historique du dossier actif").classes("text-xs text-red-300 font-medium")
                    ui.label("Supprime toutes les sessions JSON du dossier.").classes("text-xs text-red-900")
                ui.button("🗑 Effacer", on_click=lambda: ui.notify("À implémenter : supprimer les sessions du dossier.", type="warning")).classes("bg-red-950 text-red-400 text-xs border border-red-900")

            with ui.row().classes("items-center px-4 py-3 border-b border-red-950 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Retirer ce dossier de la sidebar").classes("text-xs text-red-300 font-medium")
                ui.button("✕ Retirer", on_click=lambda: ui.notify("À implémenter : retirer de l'index.", type="warning")).classes("bg-red-950 text-red-400 text-xs border border-red-900")

            with ui.row().classes("items-center px-4 py-3 gap-3"):
                with ui.column().classes("flex-1"):
                    ui.label("Réinitialiser tous les paramètres globaux").classes("text-xs text-red-300 font-medium")

                def reset_all():
                    save_global_config(DEFAULT_GLOBAL_CONFIG.copy())
                    ui.notify("Paramètres réinitialisés.", type="positive")

                ui.button("↺ Réinitialiser", on_click=reset_all).classes("bg-red-950 text-red-400 text-xs border border-red-900")


def render_settings():
    """Called from a button — opens settings as a full overlay dialog."""
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
