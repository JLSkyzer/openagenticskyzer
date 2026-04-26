"""Model picker popup — Ollama auto-detect + cloud provider add."""
import subprocess
import threading
from nicegui import ui

from openagentic_ai.app.state import state
from openagentic_ai.utils.utils import get_available_ollama_models, _DEFAULT_CTX_LIMITS


def _detect_configured_models() -> list[dict]:
    """Return list of {provider, model} for configured providers."""
    import os
    results = []
    providers = [
        ("TOGETHER_API_KEY", "together", "TOGETHER_MODEL", "Qwen/Qwen3-Coder-Next-FP8"),
        ("GROQ_API_KEY", "groq", "GROQ_MODEL", "moonshotai/kimi-k2-instruct"),
        ("MISTRAL_API_KEY", "mistral", "MISTRAL_MODEL", "codestral-latest"),
        ("GEMINI_API_KEY", "gemini", "GEMINI_MODEL", "gemini-2.5-pro-preview-03-25"),
        ("OPENROUTER_API_KEY", "openrouter", "OPENROUTER_MODEL", "kwaipilot/kat-coder-pro-v2"),
    ]
    for key_env, provider, model_env, default_model in providers:
        if os.environ.get(key_env, "").strip():
            model = os.environ.get(model_env, default_model)
            results.append({"provider": provider, "model": model})
    return results


def _select_model(provider: str, model: str, dlg):
    state.current_provider = provider
    state.current_model = model
    ui.notify(f"Modèle : {model} ({provider})", type="positive")
    dlg.close()


def _pull_ollama_model(model_name: str, progress_label):
    """Run ollama pull in background and update progress_label."""
    def _pull():
        try:
            proc = subprocess.Popen(
                ["ollama", "pull", model_name],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            for line in proc.stdout:
                progress_label.set_text(line.strip()[:80])
            proc.wait()
            progress_label.set_text(f"✅ {model_name} téléchargé !")
        except FileNotFoundError:
            progress_label.set_text("❌ Ollama non trouvé. Installez ollama.com/download")
        except Exception as exc:
            progress_label.set_text(f"❌ Erreur : {exc}")

    threading.Thread(target=_pull, daemon=True).start()


def open_model_modal():
    with ui.dialog() as dlg:
        dlg.open()
        with ui.card().classes("w-[500px]").style("background:#111;border:1px solid #2a2a2a;color:#e0e0e0"):
            ui.label("Sélectionner un modèle").classes("text-sm font-bold text-gray-200 mb-3")

            # ── Cloud providers ──
            cloud_models = _detect_configured_models()
            if cloud_models:
                ui.label("Cloud (clés détectées)").classes("text-xs text-gray-500 uppercase tracking-widest mb-1")
                for entry in cloud_models:
                    prov = entry["provider"]
                    mdl = entry["model"]
                    ctx_k = _DEFAULT_CTX_LIMITS.get(prov, 0) // 1000
                    with ui.row().classes("items-center gap-2 py-1 px-2 rounded hover:bg-gray-900 cursor-pointer") \
                            .on("click", lambda p=prov, m=mdl: _select_model(p, m, dlg)):
                        ui.element("div").classes("w-2 h-2 rounded-full bg-green-400")
                        ui.label(mdl).classes("text-xs text-gray-300 flex-1")
                        ui.label(f"{prov} · {ctx_k}K ctx").classes("text-xs text-gray-600")
            else:
                ui.label("Aucun provider cloud configuré.").classes("text-xs text-gray-600 mb-1")

            ui.separator().classes("my-2 border-gray-800")

            # ── Ollama ──
            ui.label("Ollama (local)").classes("text-xs text-gray-500 uppercase tracking-widest mb-1")
            ollama_models = get_available_ollama_models()
            if ollama_models:
                for mdl in ollama_models:
                    with ui.row().classes("items-center gap-2 py-1 px-2 rounded hover:bg-gray-900 cursor-pointer") \
                            .on("click", lambda m=mdl: _select_model("ollama", m, dlg)):
                        ui.element("div").classes("w-2 h-2 rounded-full bg-purple-400")
                        ui.label(mdl).classes("text-xs text-gray-300 flex-1")
                        ui.label("ollama · 32K ctx ⚠️").classes("text-xs text-gray-600")
            else:
                ui.label("Aucun modèle Ollama installé.").classes("text-xs text-gray-600")

            with ui.expansion("📥 Télécharger un modèle Ollama").classes("w-full mt-1"):
                with ui.column().classes("gap-2 p-1"):
                    dl_input = ui.input(placeholder="ex: qwen2.5-coder:7b").classes("w-full text-xs")
                    progress = ui.label("").classes("text-xs text-gray-500 font-mono")
                    ui.button(
                        "Télécharger",
                        on_click=lambda: _pull_ollama_model(dl_input.value, progress)
                    ).classes("bg-purple-700 text-xs text-white")
                    ui.link("Parcourir ollama.com/library ↗", "https://ollama.com/library", new_tab=True).classes("text-xs text-purple-400")

            ui.separator().classes("my-2 border-gray-800")

            with ui.expansion("➕ Ajouter un modèle cloud").classes("w-full"):
                with ui.column().classes("gap-2 p-1"):
                    prov_select = ui.select(
                        ["together", "groq", "mistral", "gemini", "openrouter"],
                        label="Provider", value="groq"
                    ).classes("w-full text-xs")
                    api_input = ui.input(label="Clé API").classes("w-full text-xs")
                    model_input = ui.input(label="Modèle (optionnel)").classes("w-full text-xs")

                    def _save_provider():
                        import os
                        import pathlib
                        provider = prov_select.value
                        env_key = f"{provider.upper()}_API_KEY"
                        env_model = f"{provider.upper()}_MODEL"
                        env_path = (
                            f"{state.active_folder}/.env"
                            if state.active_folder
                            else str(pathlib.Path.home() / ".env")
                        )
                        with open(env_path, "a", encoding="utf-8") as f:
                            f.write(f"\n{env_key}={api_input.value}\n")
                            if model_input.value:
                                f.write(f"{env_model}={model_input.value}\n")
                        os.environ[env_key] = api_input.value
                        if model_input.value:
                            os.environ[env_model] = model_input.value
                        ui.notify(f"{provider} configuré !", type="positive")
                        dlg.close()

                    ui.button("Enregistrer", on_click=_save_provider).classes("bg-purple-700 text-xs text-white")

            with ui.row().classes("justify-end mt-2"):
                ui.button("Fermer", on_click=dlg.close).classes("bg-gray-800 text-xs text-gray-300")
