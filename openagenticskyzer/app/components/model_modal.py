"""Model picker popup — Ollama auto-detect + cloud provider add."""
import asyncio
import os
import pathlib
import re
import subprocess
import threading
from nicegui import ui, run

from openagenticskyzer.app.state import state, DownloadEntry
from openagenticskyzer.utils.utils import (
    get_available_ollama_models, get_available_lmstudio_models,
    get_available_llamacpp_models, get_lmstudio_models_dir,
    ensure_lmstudio_runtime, lmstudio_load_model,
    get_system_info, _DEFAULT_CTX_LIMITS, _LLAMACPP_MODELS_DIR,
)

# ── Catalogue complet ──────────────────────────────────────────────────────────
# tags: "tendances" | "récent" | "code" | "tool-use" | "général"
_FULL_CATALOG = [
    # ── Petits (< 4B) ────────────────────────────────────────────────────────
    {"name": "Llama-3.2-1B-Instruct", "lms_id": "meta-llama/llama-3.2-1b-instruct",
     "hf_id": "lmstudio-community/Llama-3.2-1B-Instruct-GGUF",
     "params": "1B", "ram_min": 2, "vram_min": 1, "tool_stars": 1, "cat": "général",
     "tags": ["récent"], "desc": "Ultra-léger, test & prototypage"},
    {"name": "Qwen2.5-1.5B-Instruct", "lms_id": "qwen/qwen2.5-1.5b-instruct",
     "hf_id": "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
     "params": "1.5B", "ram_min": 2, "vram_min": 1, "tool_stars": 2, "cat": "général",
     "tags": [], "desc": "Petit modèle Qwen, rapide"},
    {"name": "Llama-3.2-3B-Instruct", "lms_id": "meta-llama/llama-3.2-3b-instruct",
     "hf_id": "lmstudio-community/Llama-3.2-3B-Instruct-GGUF",
     "params": "3B", "ram_min": 3, "vram_min": 2, "tool_stars": 2, "cat": "général",
     "tags": ["tendances", "récent"], "desc": "Petit Llama 3.2, très rapide"},
    {"name": "Phi-3.5-mini-instruct", "lms_id": "microsoft/phi-3.5-mini-instruct",
     "hf_id": "bartowski/Phi-3.5-mini-instruct-GGUF",
     "params": "3.8B", "ram_min": 4, "vram_min": 3, "tool_stars": 3, "cat": "général",
     "tags": ["tendances"], "desc": "Microsoft compact, excellent rapport qualité/taille"},
    {"name": "Qwen2.5-3B-Instruct", "lms_id": "qwen/qwen2.5-3b-instruct",
     "hf_id": "Qwen/Qwen2.5-3B-Instruct-GGUF",
     "params": "3B", "ram_min": 3, "vram_min": 2, "tool_stars": 2, "cat": "général",
     "tags": [], "desc": "Qwen 3B, efficace pour tâches légères"},
    # ── 7-9B ─────────────────────────────────────────────────────────────────
    {"name": "Hermes-3-Llama-3.1-8B", "lms_id": "nous-research/hermes-3-llama-3.1-8b",
     "hf_id": "NousResearch/Hermes-3-Llama-3.1-8B-GGUF",
     "params": "8B", "ram_min": 8, "vram_min": 6, "tool_stars": 5, "cat": "tool-use",
     "tags": ["tendances"], "desc": "Spécialisé function calling — meilleur small tool-use"},
    {"name": "Llama-3.1-8B-Instruct", "lms_id": "meta-llama/meta-llama-3.1-8b-instruct",
     "hf_id": "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
     "params": "8B", "ram_min": 8, "vram_min": 6, "tool_stars": 4, "cat": "général",
     "tags": [], "desc": "Bon modèle général, tool use natif solide"},
    {"name": "Mistral-7B-Instruct-v0.3", "lms_id": "mistralai/mistral-7b-instruct-v0.3",
     "hf_id": "lmstudio-community/Mistral-7B-Instruct-v0.3-GGUF",
     "params": "7B", "ram_min": 8, "vram_min": 6, "tool_stars": 4, "cat": "tool-use",
     "tags": [], "desc": "Mistral classique, excellent tool use natif"},
    {"name": "Qwen2.5-Coder-7B-Instruct", "lms_id": "qwen/qwen2.5-coder-7b-instruct",
     "hf_id": "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
     "params": "7B", "ram_min": 8, "vram_min": 6, "tool_stars": 3, "cat": "code",
     "tags": [], "desc": "Modèle code léger, tool use acceptable"},
    {"name": "DeepSeek-R1-Distill-Llama-8B", "lms_id": "deepseek-ai/deepseek-r1-distill-llama-8b",
     "hf_id": "lmstudio-community/DeepSeek-R1-Distill-Llama-8B-GGUF",
     "params": "8B", "ram_min": 8, "vram_min": 6, "tool_stars": 4, "cat": "général",
     "tags": ["tendances", "récent"], "desc": "Raisonnement DeepSeek R1 distillé dans Llama 8B"},
    {"name": "Gemma-2-9B-it", "lms_id": "google/gemma-2-9b-it",
     "hf_id": "bartowski/gemma-2-9b-it-GGUF",
     "params": "9B", "ram_min": 8, "vram_min": 6, "tool_stars": 3, "cat": "général",
     "tags": ["tendances"], "desc": "Gemma 2 Google, très performant pour sa taille"},
    {"name": "StarCoder2-7B", "lms_id": "bigcode/starcoder2-7b",
     "hf_id": "bartowski/starcoder2-7b-GGUF",
     "params": "7B", "ram_min": 8, "vram_min": 6, "tool_stars": 3, "cat": "code",
     "tags": [], "desc": "BigCode, entraîné sur +600 langages de programmation"},
    # ── 12-14B ───────────────────────────────────────────────────────────────
    {"name": "Phi-4", "lms_id": "microsoft/phi-4",
     "hf_id": "bartowski/phi-4-GGUF",
     "params": "14B", "ram_min": 12, "vram_min": 10, "tool_stars": 4, "cat": "général",
     "tags": ["tendances", "récent"], "desc": "Phi-4 Microsoft, très capable pour sa taille"},
    {"name": "Mistral-Nemo-Instruct-2407", "lms_id": "mistralai/mistral-nemo-instruct-2407",
     "hf_id": "lmstudio-community/Mistral-Nemo-Instruct-2407-GGUF",
     "params": "12B", "ram_min": 10, "vram_min": 8, "tool_stars": 4, "cat": "général",
     "tags": [], "desc": "128K contexte, très bon tool use"},
    {"name": "Qwen2.5-Coder-14B-Instruct", "lms_id": "qwen/qwen2.5-coder-14b-instruct",
     "hf_id": "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF",
     "params": "14B", "ram_min": 12, "vram_min": 10, "tool_stars": 4, "cat": "code",
     "tags": [], "desc": "Excellent équilibre code + tool use"},
    {"name": "DeepSeek-Coder-V2-Lite-Instruct", "lms_id": "deepseek-ai/deepseek-coder-v2-lite-instruct",
     "hf_id": "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF",
     "params": "14B", "ram_min": 10, "vram_min": 8, "tool_stars": 4, "cat": "code",
     "tags": ["tendances"], "desc": "Très rapide pour sa taille, excellent en code"},
    {"name": "DeepSeek-R1-Distill-Qwen-14B", "lms_id": "deepseek-ai/deepseek-r1-distill-qwen-14b",
     "hf_id": "lmstudio-community/DeepSeek-R1-Distill-Qwen-14B-GGUF",
     "params": "14B", "ram_min": 12, "vram_min": 10, "tool_stars": 4, "cat": "général",
     "tags": ["tendances", "récent"], "desc": "Raisonnement R1 distillé dans Qwen 14B"},
    {"name": "StarCoder2-15B", "lms_id": "bigcode/starcoder2-15b",
     "hf_id": "bartowski/starcoder2-15b-GGUF",
     "params": "15B", "ram_min": 12, "vram_min": 10, "tool_stars": 4, "cat": "code",
     "tags": [], "desc": "BigCode 15B, état de l'art open-source code"},
    # ── 22-32B ───────────────────────────────────────────────────────────────
    {"name": "Codestral-22B-v0.1", "lms_id": "mistralai/codestral-22b-v0.1",
     "hf_id": "bartowski/Codestral-22B-v0.1-GGUF",
     "params": "22B", "ram_min": 16, "vram_min": 14, "tool_stars": 4, "cat": "code",
     "tags": ["tendances"], "desc": "Modèle code Mistral, état de l'art en 22B"},
    {"name": "Qwen2.5-Coder-32B-Instruct", "lms_id": "qwen/qwen2.5-coder-32b-instruct",
     "hf_id": "Qwen/Qwen2.5-Coder-32B-Instruct-GGUF",
     "params": "32B", "ram_min": 24, "vram_min": 20, "tool_stars": 5, "cat": "code",
     "tags": ["tendances"], "desc": "Meilleur modèle code local, tool use parfait ★"},
    {"name": "DeepSeek-R1-Distill-Qwen-32B", "lms_id": "deepseek-ai/deepseek-r1-distill-qwen-32b",
     "hf_id": "lmstudio-community/DeepSeek-R1-Distill-Qwen-32B-GGUF",
     "params": "32B", "ram_min": 24, "vram_min": 20, "tool_stars": 5, "cat": "général",
     "tags": ["tendances", "récent"], "desc": "R1 dans Qwen 32B, proche GPT-4o"},
    {"name": "Gemma-2-27B-it", "lms_id": "google/gemma-2-27b-it",
     "hf_id": "bartowski/gemma-2-27b-it-GGUF",
     "params": "27B", "ram_min": 20, "vram_min": 16, "tool_stars": 4, "cat": "général",
     "tags": ["tendances"], "desc": "Gemma 2 27B Google, très performant"},
    # ── 70B+ ─────────────────────────────────────────────────────────────────
    {"name": "Llama-3.3-70B-Instruct", "lms_id": "meta-llama/llama-3.3-70b-instruct",
     "hf_id": "lmstudio-community/Llama-3.3-70B-Instruct-GGUF",
     "params": "70B", "ram_min": 48, "vram_min": 40, "tool_stars": 5, "cat": "général",
     "tags": ["tendances"], "desc": "Équivalent GPT-4o en local, tool use parfait"},
    {"name": "Qwen2.5-72B-Instruct", "lms_id": "qwen/qwen2.5-72b-instruct",
     "hf_id": "Qwen/Qwen2.5-72B-Instruct-GGUF",
     "params": "72B", "ram_min": 48, "vram_min": 40, "tool_stars": 5, "cat": "général",
     "tags": [], "desc": "Top modèle général local ★ recommandé"},
]
# Déduplique par hf_id
_seen: set = set()
_FULL_CATALOG = [m for m in _FULL_CATALOG if not (m["hf_id"] in _seen or _seen.add(m["hf_id"]))]


def _detect_configured_models() -> list[dict]:
    """Return list of {provider, model} for configured providers."""
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
    if state.active_folder:
        from openagenticskyzer.app.storage import load_folder_config, save_folder_config
        folder_cfg = load_folder_config(state.active_folder)
        folder_cfg["current_model"] = model
        folder_cfg["current_provider"] = provider
        save_folder_config(state.active_folder, folder_cfg)
    try:
        from openagenticskyzer.app.components.input_bar import model_button
        model_button.refresh()
    except Exception:
        pass
    ui.notify(f"Modèle : {model} ({provider})", type="positive")
    dlg.close()


def _pull_ollama_model(model_name: str, progress_label):
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


def _start_persistent_download(dl_id: str, name: str, hf_id: str,
                                dest_dir_fn, provider: str = "lmstudio") -> None:
    """Téléchargement parallèle (4 threads Range) persistant dans state.downloads."""
    for d in state.downloads:
        if d.dl_id == dl_id and not d.done and not d.error:
            ui.notify("Déjà en cours de téléchargement", type="warning")
            return

    entry = DownloadEntry(dl_id=dl_id, name=name, provider=provider)
    state.downloads.append(entry)

    def _run():
        import urllib.request as _ur
        import json as _json
        import concurrent.futures as _futures

        tmp_parts: list[pathlib.Path] = []
        try:
            entry.progress = "Recherche du fichier GGUF…"
            with _ur.urlopen(f"https://huggingface.co/api/models/{hf_id}", timeout=15) as r:
                siblings = _json.loads(r.read()).get("siblings", [])

            def _score(n: str) -> int:
                u = n.upper()
                if "Q4_K_M" in u: return 0
                if "Q5_K_M" in u: return 1
                if "Q4_K_S" in u: return 2
                return 10

            gguf_siblings = sorted(
                [s for s in siblings if s.get("rfilename", "").lower().endswith(".gguf")],
                key=lambda s: _score(s["rfilename"]),
            )
            if not gguf_siblings:
                entry.progress = "❌ Aucun fichier GGUF trouvé."
                entry.error = True
                return

            best = gguf_siblings[0]
            filename = best["rfilename"]
            # La taille est déjà dans la réponse API — pas de HEAD nécessaire
            _api_size = int(best.get("size", 0))
            dest_dir = pathlib.Path(dest_dir_fn()) / hf_id
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest_path = dest_dir / pathlib.Path(filename).name

            if dest_path.exists():
                entry.progress = f"✅ {dest_path.name} déjà présent !"
                entry.done = True
                return

            # ── Pré-résolution : taille totale + support Range + token ──────────
            url = f"https://huggingface.co/{hf_id}/resolve/main/{filename}"
            _hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
            if not _hf_token:
                from openagenticskyzer.app.storage import load_global_config as _lcfg
                _hf_token = (_lcfg().get("hf_token") or "").strip() or None
            if _hf_token:
                os.environ["HF_TOKEN"] = _hf_token
                os.environ["HUGGING_FACE_HUB_TOKEN"] = _hf_token
            _auth_hdr: dict = {"Authorization": f"Bearer {_hf_token}"} if _hf_token else {}
            # Taille déjà connue via l'API — HuggingFace CDN supporte toujours Range
            _size = _api_size
            _ranges = _size > 0
            if not _size:
                # Fallback HEAD uniquement si l'API n'a pas renvoyé la taille
                try:
                    entry.progress = "Connexion…"
                    with _ur.urlopen(
                        _ur.Request(url, headers=_auth_hdr, method="HEAD"), timeout=15
                    ) as _r:
                        _size = int(_r.headers.get("Content-Length", 0))
                        _ranges = _r.headers.get("Accept-Ranges", "") == "bytes"
                except Exception:
                    pass

            BUF = 2_097_152  # 2 MB

            # ── Stratégie selon la taille ─────────────────────────────────────
            # Gros fichier (>500 MB) + Range supporté → 16 connexions parallèles
            # (sature mieux la bande passante sur les CDN avec throttling/connexion
            # qu'une seule connexion hf_transfer)
            if _size > 500 * 1_048_576 and _ranges:
                # Écriture directe à l'offset : pré-alloue le fichier final,
                # chaque thread ouvre son propre handle et seek() à sa position.
                # Aucun assemblage post-téléchargement.
                N = 16
                chunk_size = (_size + N - 1) // N
                downloaded_parts = [0] * N
                tmp_dl = dest_path.with_suffix(".downloading")
                try:
                    with open(tmp_dl, "wb") as _f:
                        _f.truncate(_size)  # pré-allocation O(1) sur NTFS/ext4

                    def _download_part(i: int):
                        start = i * chunk_size
                        end = min(start + chunk_size - 1, _size - 1)
                        req = _ur.Request(
                            url, headers={**_auth_hdr, "Range": f"bytes={start}-{end}"}
                        )
                        pos = start
                        with _ur.urlopen(req, timeout=600) as r:
                            with open(tmp_dl, "r+b") as f:
                                f.seek(pos)
                                while True:
                                    buf = r.read(BUF)
                                    if not buf:
                                        break
                                    f.write(buf)
                                    pos += len(buf)
                                    downloaded_parts[i] += len(buf)
                                    total_dl = sum(downloaded_parts)
                                    pct = min(100, total_dl * 100 // _size)
                                    entry.progress = (
                                        f"⬇ {total_dl // 1_048_576}/{_size // 1_048_576}MB {pct}%"
                                    )

                    with _futures.ThreadPoolExecutor(max_workers=N) as ex:
                        futs = [ex.submit(_download_part, i) for i in range(N)]
                        for fut in _futures.as_completed(futs):
                            fut.result()

                    tmp_dl.rename(dest_path)
                except Exception:
                    try:
                        if tmp_dl.exists():
                            tmp_dl.unlink()
                    except Exception:
                        pass
                    raise

            else:
                # ── hf_transfer (Rust) pour petits fichiers / Range indisponible ─
                try:
                    import os as _os
                    import threading as _th
                    import time as _time
                    _os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
                    from huggingface_hub import hf_hub_download as _hf_dl

                    _stop = _th.Event()

                    def _poll_hft():
                        while not _stop.is_set():
                            try:
                                best = max(
                                    (p for p in dest_dir.iterdir() if p.is_file()),
                                    key=lambda p: p.stat().st_size,
                                    default=None,
                                )
                                if best:
                                    sz = best.stat().st_size
                                    if _size:
                                        pct = min(99, sz * 100 // _size)
                                        entry.progress = (
                                            f"⬇ {sz // 1_048_576}/{_size // 1_048_576}MB {pct}%"
                                        )
                                    else:
                                        entry.progress = f"⬇ {sz // 1_048_576}MB"
                            except Exception:
                                pass
                            _time.sleep(0.8)

                    _pt = _th.Thread(target=_poll_hft, daemon=True)
                    _pt.start()
                    try:
                        tmp_hf = _hf_dl(
                            repo_id=hf_id,
                            filename=filename,
                            repo_type="model",
                            local_dir=str(dest_dir),
                            local_dir_use_symlinks=False,
                            token=_hf_token or None,
                        )
                    finally:
                        _stop.set()
                        _pt.join(timeout=2)

                    if pathlib.Path(tmp_hf) != dest_path:
                        pathlib.Path(tmp_hf).rename(dest_path)
                except Exception:
                    # Fallback flux unique
                    entry.progress = f"Connexion… {filename}"
                    tmp = dest_path.with_suffix(".tmp")
                    with _ur.urlopen(
                        _ur.Request(url, headers=_auth_hdr), timeout=600
                    ) as resp:
                        _size = int(resp.headers.get("Content-Length", 0))
                        dl = 0
                        with open(tmp, "wb") as f:
                            while True:
                                buf = resp.read(BUF)
                                if not buf:
                                    break
                                f.write(buf)
                                dl += len(buf)
                                if _size:
                                    pct = min(100, dl * 100 // _size)
                                    entry.progress = (
                                        f"⬇ {dl // 1_048_576}/{_size // 1_048_576}MB {pct}%"
                                    )
                    tmp.rename(dest_path)

            entry.progress = f"✅ {dest_path.name} prêt !"
            entry.done = True

            if provider == "lmstudio":
                try:
                    subprocess.run(
                        ["lms", "server", "stop"], capture_output=True, timeout=10,
                        creationflags=0x08000000 if os.name == "nt" else 0,
                    )
                    import time as _t; _t.sleep(1)
                    subprocess.Popen(
                        ["lms", "server", "start"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        creationflags=0x08000000 if os.name == "nt" else 0,
                    )
                except Exception:
                    pass

        except Exception as exc:
            entry.progress = f"❌ {exc}"
            entry.error = True
            for part in tmp_parts:
                try:
                    if part.exists():
                        part.unlink()
                except Exception:
                    pass

    threading.Thread(target=_run, daemon=True).start()


def _is_catalog_installed(hf_id: str, name: str, installed: set[str]) -> bool:
    """Détermine si un modèle du catalogue HF est déjà installé localement."""
    hf_lower = hf_id.lower().replace("-gguf", "").replace("_gguf", "")
    name_lower = name.lower()
    for inst in installed:
        inst_lower = inst.lower()
        if hf_lower in inst_lower or name_lower in inst_lower:
            return True
    return False


def _do_uninstall_lmstudio(model_id: str) -> str:
    """Désinstalle un modèle LM Studio (lms unload + suppression fichier)."""
    import subprocess as _sp

    # 1. Décharger si chargé
    try:
        _sp.run(
            ["lms", "unload", model_id],
            capture_output=True, timeout=15,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
    except Exception:
        pass

    # 2. Essai via lms remove
    try:
        r = _sp.run(
            ["lms", "remove", model_id],
            capture_output=True, text=True, timeout=30,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if r.returncode == 0:
            return "✅ Supprimé"
    except Exception:
        pass

    # 3. Fallback filesystem : cherche le .gguf correspondant
    try:
        models_dir = get_lmstudio_models_dir()
        name_lower = model_id.lower().replace("-gguf", "")
        for gguf in models_dir.rglob("*.gguf"):
            rel = str(gguf.relative_to(models_dir)).lower()
            if name_lower in rel or rel.replace("-gguf", "") in name_lower:
                gguf.unlink()
                # Supprime dossiers vides
                for parent in [gguf.parent, gguf.parent.parent]:
                    try:
                        parent.rmdir()
                    except Exception:
                        break
                return f"✅ {gguf.name} supprimé"
        return f"❌ Fichier non trouvé pour : {model_id}"
    except Exception as exc:
        return f"❌ {exc}"


def open_lms_catalog_popup():
    """Popup catalogue LM Studio — données live depuis HuggingFace."""
    from openagenticskyzer.app.hf_catalog import HFModel, fetch_catalog

    _FILTERS = ["Tous", "Tendances", "Récent", "Code", "Tool Use", "Pour vos specs"]
    _st: dict = {"filter": "Tous", "search": "", "models": [], "sinfo": None, "installed": set()}
    _fbtns: dict = {}

    CAT_COLOR = {
        "code": "text-blue-400",
        "général": "text-green-400",
        "tool-use": "text-purple-400",
    }

    with ui.dialog() as cat_dlg:
        cat_dlg.open()
        with ui.card().style(
            "width:740px;max-width:96vw;background:#111;border:1px solid #2a2a2a;"
            "color:#e0e0e0;max-height:88vh;display:flex;flex-direction:column;padding:16px"
        ):
            # ── Header ──
            with ui.row().classes("items-center w-full mb-2"):
                ui.label("🔍 Catalogue LM Studio").classes("text-sm font-bold text-gray-200 flex-1")
                ui.button("✕", on_click=cat_dlg.close).classes(
                    "text-xs text-gray-500 w-7 h-7 bg-gray-900 border border-gray-800 rounded"
                ).props("flat dense")

            # ── Recherche ──
            search_input = ui.input(placeholder="Rechercher un modèle…").classes("w-full text-xs mb-1").props(
                "outlined dense clearable"
            ).style("background:#1a1a1a")

            # ── Filtres ──
            with ui.row().classes("gap-1 mb-1 flex-wrap"):
                for flt in _FILTERS:
                    btn = ui.button(flt).classes(
                        "text-xs px-2 py-0.5 rounded border "
                        + ("bg-purple-700 text-white border-purple-600"
                           if flt == "Tous" else "bg-gray-900 text-gray-400 border-gray-700")
                    ).props("dense")
                    _fbtns[flt] = btn

            status_lbl = ui.label("⏳ Connexion à HuggingFace…").classes("text-xs text-gray-500 mb-1")
            cat_box = ui.column().classes("w-full gap-0 flex-1 overflow-y-auto").style("max-height:62vh")

            # ── Rendu sync (opère sur _st["models"] déjà chargés) ──
            def _render():
                cat_box.clear()
                models: list[HFModel] = list(_st["models"])
                search = _st["search"]
                filt = _st["filter"]
                sinfo = _st["sinfo"]

                if search:
                    # Découpe en mots-clés (espaces, tirets, underscores)
                    # → OR : un seul mot suffit à faire matcher le modèle
                    _kws = [w for w in re.split(r'[\s\-_]+', search.lower()) if len(w) >= 2]
                    if _kws:
                        def _match(m, kws=_kws):
                            hay = f"{m.name} {m.hf_id} {m.cat} {m.params} {m.desc}".lower()
                            return any(kw in hay for kw in kws)
                        models = [m for m in models if _match(m)]
                elif filt == "Tendances":
                    models = [m for m in models if "tendances" in m.tags]
                elif filt == "Récent":
                    models = sorted(
                        [m for m in models if "récent" in m.tags],
                        key=lambda m: m.last_modified, reverse=True,
                    )
                elif filt == "Code":
                    models = [m for m in models if m.cat == "code"]
                elif filt == "Tool Use":
                    models = sorted(
                        [m for m in models if m.tool_stars >= 4],
                        key=lambda m: -m.tool_stars,
                    )
                elif filt == "Pour vos specs":
                    if sinfo is None:
                        with cat_box:
                            ui.label("⏳ Analyse du matériel en cours…").classes(
                                "text-xs text-gray-600 p-4"
                            )
                        return
                    ram, vram = sinfo.get("ram_gb", 0), sinfo.get("vram_gb", 0)
                    models = [m for m in models if m.score_for_specs(ram, vram) > 0]
                    models = sorted(models, key=lambda m: -m.score_for_specs(ram, vram))

                # Masquer les modèles déjà installés localement
                installed = _st.get("installed", set())
                if installed:
                    models = [m for m in models
                              if not _is_catalog_installed(m.hf_id, m.name, installed)]

                if not models:
                    with cat_box:
                        msg = ("Tous les modèles de cette catégorie sont déjà installés."
                               if installed else "Aucun modèle correspondant.")
                        ui.label(msg).classes("text-xs text-gray-600 p-4")
                    return

                with cat_box:
                    for m in models[:80]:
                        dl_entry = next((d for d in state.downloads if d.dl_id == m.hf_id), None)
                        is_dling = dl_entry and not dl_entry.done and not dl_entry.error
                        is_done = dl_entry and dl_entry.done

                        stars_str = "★" * m.tool_stars + "☆" * (5 - m.tool_stars)
                        cc = CAT_COLOR.get(m.cat, "text-gray-400")
                        tag_text = "  ".join(f"[{t}]" for t in m.tags)

                        # Score de recommandation affiché dès que les specs sont connues
                        score_badge = ""
                        if sinfo:
                            sc = m.score_for_specs(sinfo["ram_gb"], sinfo["vram_gb"])
                            score_badge = f"  {sc:.0f}/100"

                        with ui.row().classes(
                            "items-center gap-2 py-2 px-2 w-full hover:bg-gray-900 rounded cursor-default"
                        ).style("border-bottom:1px solid #1a1a1a"):
                            with ui.column().classes("flex-1 gap-0 min-w-0"):
                                with ui.row().classes("items-baseline gap-2 flex-wrap"):
                                    ui.label(m.name).classes("text-xs text-gray-200 font-semibold")
                                    ui.label(m.params).classes("text-xs text-gray-500")
                                    if tag_text or score_badge:
                                        ui.label(tag_text + score_badge).classes(
                                            "text-xs text-purple-400"
                                        )
                                ui.label(
                                    f"{m.cat} · {stars_str} · {m.desc}"
                                ).classes(f"text-xs {cc} truncate")

                            if is_done:
                                ui.label("✅").classes("text-xs flex-shrink-0")
                            elif is_dling:
                                _prog = dl_entry.progress
                                _pm = re.search(r'(\d+)/(\d+)MB\s*(\d+)%', _prog)
                                if _pm:
                                    _ptxt = f"⬇ {_pm.group(3)}% · {_pm.group(1)}/{_pm.group(2)}MB"
                                else:
                                    _ptxt = _prog[:22]
                                with ui.row().classes("items-center gap-1 flex-shrink-0"):
                                    ui.spinner(size="xs").classes("text-purple-400")
                                    ui.label(_ptxt).classes(
                                        "text-xs text-purple-400 font-mono"
                                    )
                            else:
                                def _do_dl(hf_id=m.hf_id, nm=m.name):
                                    _start_persistent_download(
                                        dl_id=hf_id, name=nm, hf_id=hf_id,
                                        dest_dir_fn=get_lmstudio_models_dir,
                                        provider="lmstudio",
                                    )
                                    ui.notify(f"⬇ {nm} — progression visible ci-dessous et dans la barre latérale", type="positive")
                                    _render()  # affiche le spinner sur la ligne du modèle

                                ui.button("↓ Installer", on_click=_do_dl).classes(
                                    "text-xs bg-purple-700 hover:bg-purple-600 text-white "
                                    "px-2 h-7 rounded flex-shrink-0"
                                ).props("dense")

            # ── Chargement initial async (catalogue + specs matérielles en parallèle) ──
            async def _initial_load():
                models, sinfo, installed = await asyncio.gather(
                    run.io_bound(fetch_catalog),
                    run.io_bound(get_system_info),
                    run.io_bound(get_available_lmstudio_models),
                )
                _st["models"] = models
                _st["sinfo"] = sinfo
                _st["installed"] = set(installed)
                ram = sinfo.get("ram_gb", 0)
                vram = sinfo.get("vram_gb", 0)
                gpu = sinfo.get("gpu_name") or "Aucun GPU NVIDIA"
                hidden = sum(1 for m in models if _is_catalog_installed(m.hf_id, m.name, _st["installed"]))
                suffix = f" · {hidden} déjà installé(s) masqué(s)" if hidden else ""
                status_lbl.set_text(
                    f"{len(models)} modèles · {ram} GB RAM · {vram} GB VRAM ({gpu}){suffix}"
                )
                _render()

            async def _load_sinfo():
                sinfo = await run.io_bound(get_system_info)
                _st["sinfo"] = sinfo
                ram, vram = sinfo.get("ram_gb", 0), sinfo.get("vram_gb", 0)
                gpu = sinfo.get("gpu_name") or "Aucun GPU NVIDIA"
                status_lbl.set_text(
                    f"{len(_st['models'])} modèles · {ram} GB RAM · {vram} GB VRAM ({gpu})"
                )
                _render()

            # ── Filtres ──
            def _set_filter(flt: str):
                _st["filter"] = flt
                _st["search"] = ""
                search_input.set_value("")
                for f, b in _fbtns.items():
                    if f == flt:
                        b.classes(
                            add="bg-purple-700 text-white border-purple-600",
                            remove="bg-gray-900 text-gray-400 border-gray-700",
                        )
                    else:
                        b.classes(
                            add="bg-gray-900 text-gray-400 border-gray-700",
                            remove="bg-purple-700 text-white border-purple-600",
                        )
                if flt == "Pour vos specs" and _st["sinfo"] is None:
                    asyncio.ensure_future(_load_sinfo())
                else:
                    _render()

            for flt in _FILTERS:
                _fbtns[flt].on("click", lambda f=flt: _set_filter(f))

            def _on_search(e=None):
                val = (e.value if e is not None and hasattr(e, "value") else search_input.value) or ""
                _st["search"] = val
                for f, b in _fbtns.items():
                    if f == "Tous":
                        b.classes(add="bg-purple-700 text-white border-purple-600",
                                  remove="bg-gray-900 text-gray-400 border-gray-700")
                    else:
                        b.classes(add="bg-gray-900 text-gray-400 border-gray-700",
                                  remove="bg-purple-700 text-white border-purple-600")
                _render()

            search_input.on_value_change(_on_search)
            search_input.on("clear", lambda _: _on_search())

            # Timer : met à jour la progression des téléchargements dans la popup
            def _refresh_dl():
                if any(not d.done and not d.error for d in state.downloads):
                    _render()

            ui.timer(1.5, _refresh_dl)

            # Lance le fetch + specs au prochain tick (évite de bloquer le rendu du dialog)
            ui.timer(0.05, lambda: asyncio.ensure_future(_initial_load()), once=True)


def _install_llamacpp_model(hf_id: str, progress_label) -> None:
    """Télécharge le GGUF Q4_K_M depuis HuggingFace dans ~/.openagenticskyzer/models/."""
    def _run():
        import urllib.request as _ur, json as _json
        tmp = None
        try:
            progress_label.set_text("Recherche du fichier GGUF…")
            with _ur.urlopen(f"https://huggingface.co/api/models/{hf_id}", timeout=15) as r:
                siblings = _json.loads(r.read()).get("siblings", [])

            def _score(name):
                n = name.upper()
                if "Q4_K_M" in n: return 0
                if "Q5_K_M" in n: return 1
                if "Q4_K_S" in n: return 2
                return 10

            ggufs = sorted(
                [s["rfilename"] for s in siblings if s["rfilename"].lower().endswith(".gguf")],
                key=_score,
            )
            if not ggufs:
                progress_label.set_text("❌ Aucun fichier GGUF trouvé.")
                return
            filename = ggufs[0]

            dest_dir = pathlib.Path(_LLAMACPP_MODELS_DIR) / hf_id
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest_path = dest_dir / pathlib.Path(filename).name

            if dest_path.exists():
                progress_label.set_text(f"✅ {dest_path.name} déjà présent !")
                return

            url = f"https://huggingface.co/{hf_id}/resolve/main/{filename}"
            progress_label.set_text(f"Connexion… {filename}")
            tmp = dest_path.with_suffix(".tmp")

            with _ur.urlopen(url, timeout=60) as resp:
                total = int(resp.headers.get("Content-Length", 0))
                downloaded = 0
                with open(tmp, "wb") as f:
                    while True:
                        chunk = resp.read(262_144)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total:
                            pct = min(100, downloaded * 100 // total)
                            progress_label.set_text(
                                f"⬇ {downloaded/1_048_576:.0f} / {total/1_048_576:.0f} MB ({pct}%)"
                            )

            tmp.rename(dest_path)
            rel = str(dest_path.relative_to(pathlib.Path(_LLAMACPP_MODELS_DIR)))
            progress_label.set_text(f"✅ Installé ! Cliquez sur Détecter pour l'utiliser. ({rel})")

        except Exception as exc:
            if tmp and tmp.exists():
                tmp.unlink(missing_ok=True)
            progress_label.set_text(f"❌ {exc}")

    threading.Thread(target=_run, daemon=True).start()


def open_model_modal():
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv(str(pathlib.Path.home() / ".env"), override=False)
    if state.active_folder:
        _load_dotenv(os.path.join(state.active_folder, ".env"), override=True)

    with ui.dialog() as dlg:
        dlg.open()
        with ui.card().classes("w-[520px]").style(
            "background:#111;border:1px solid #2a2a2a;color:#e0e0e0;"
            "max-height:85vh;overflow-y:auto"
        ):
            ui.label("Sélectionner un modèle").classes("text-sm font-bold text-gray-200 mb-2")

            # ── Modèle actuel ──────────────────────────────────────────────────
            if state.current_model:
                with ui.row().classes(
                    "items-center gap-2 px-3 py-2 rounded-lg w-full mb-3"
                ).style("background:#1a0f2e;border:1px solid #4c1d95"):
                    ui.label("✓").classes("text-purple-400 text-xs font-bold flex-shrink-0")
                    with ui.column().classes("flex-1 gap-0 min-w-0"):
                        ui.label("Modèle actif").classes("text-xs text-purple-500 leading-none mb-0.5")
                        ui.label(state.current_model).classes(
                            "text-xs text-purple-200 font-mono font-semibold truncate"
                        )
            else:
                with ui.row().classes(
                    "items-center gap-2 px-3 py-2 rounded-lg w-full mb-3"
                ).style("background:#1a1a1a;border:1px solid #2a2a2a"):
                    ui.label("⚠").classes("text-yellow-500 text-xs flex-shrink-0")
                    ui.label("Aucun modèle sélectionné").classes("text-xs text-gray-500")

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
            ollama_status = ui.label(
                "Cliquez sur Détecter pour lister les modèles."
            ).classes("text-xs text-gray-600")
            ollama_container = ui.column().classes("w-full gap-0")

            async def _detect_ollama():
                ollama_status.set_text("Détection en cours…")
                models = await run.io_bound(get_available_ollama_models)
                ollama_status.set_text("")
                ollama_container.clear()
                if not models:
                    ollama_status.set_text("Aucun modèle détecté (Ollama doit être en cours d'exécution).")
                    return
                with ollama_container:
                    for mdl in models:
                        with ui.row().classes(
                            "items-center gap-2 py-1 px-2 rounded hover:bg-gray-900 cursor-pointer"
                        ).on("click", lambda m=mdl: _select_model("ollama", m, dlg)):
                            ui.element("div").classes("w-2 h-2 rounded-full bg-purple-400")
                            ui.label(mdl).classes("text-xs text-gray-300 flex-1")
                            ui.label("ollama · 32K ctx").classes("text-xs text-gray-600")

            ui.button("🔍 Détecter les modèles Ollama", on_click=_detect_ollama).classes(
                "text-xs bg-gray-800 text-gray-400 border border-gray-700 px-2 py-1 rounded"
            )

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

            # ── LM Studio ──
            ui.label("LM Studio (local)").classes("text-xs text-gray-500 uppercase tracking-widest mb-1")
            lms_status = ui.label(
                "Cliquez sur Détecter — LM Studio doit être lancé avec un modèle chargé."
            ).classes("text-xs text-gray-600")
            lms_installed = ui.column().classes("w-full gap-0")
            lms_load_status = ui.label("").classes("text-xs text-cyan-400 font-mono mt-1")

            async def _lmstudio_select(model_id: str):
                lms_load_status.set_text("⏳ Vérification du runtime llama.cpp…")
                rt = await run.io_bound(ensure_lmstudio_runtime)
                if rt == "runtime_installed":
                    lms_load_status.set_text("✅ Runtime installé — chargement du modèle…")
                elif rt == "lms_absent":
                    lms_load_status.set_text("❌ lms CLI introuvable")
                    return
                elif rt.startswith("erreur"):
                    lms_load_status.set_text(f"❌ {rt}")
                    return
                else:
                    lms_load_status.set_text(f"⏳ Chargement de {model_id}…")
                status = await run.io_bound(lmstudio_load_model, model_id)
                if status != "ok":
                    lms_load_status.set_text(f"❌ lms load : {status}")
                    return
                lms_load_status.set_text(f"✅ {model_id} chargé")
                _select_model("lmstudio", model_id, dlg)

            async def _detect_lmstudio():
                lms_status.set_text("Détection en cours…")
                models = await run.io_bound(get_available_lmstudio_models)
                lms_installed.clear()
                if not models:
                    lms_status.set_text("Aucun modèle détecté — vérifiez que lms est installé.")
                    return
                lms_status.set_text(f"{len(models)} modèle(s) disponible(s)")
                with lms_installed:
                    for mdl in models:
                        with ui.row().classes(
                            "items-center gap-2 py-1 px-2 rounded hover:bg-gray-900 cursor-pointer"
                        ).on("click", lambda m=mdl: _lmstudio_select(m)):
                            ui.element("div").classes("w-2 h-2 rounded-full bg-cyan-400")
                            ui.label(mdl).classes("text-xs text-gray-300 flex-1")
                            ui.label("lmstudio · 32K ctx").classes("text-xs text-gray-600")

            with ui.row().classes("items-center gap-2 mt-1 flex-wrap"):
                ui.button("🔍 Détecter LM Studio", on_click=_detect_lmstudio).classes(
                    "text-xs bg-gray-800 text-gray-400 border border-gray-700 px-2 py-1 rounded"
                )
                ui.button("📦 Parcourir le catalogue", on_click=open_lms_catalog_popup).classes(
                    "text-xs bg-purple-900 text-purple-300 border border-purple-700 px-2 py-1 rounded"
                )

            with ui.expansion("⚙️ Configuration LM Studio").classes("w-full mt-1"):
                with ui.column().classes("gap-2 p-1"):
                    _default_url = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1")
                    lms_url_input = ui.input(
                        label="URL du serveur LM Studio", value=_default_url
                    ).classes("w-full text-xs")

                    _default_dir = os.environ.get("LMSTUDIO_MODELS_DIR", "")
                    lms_dir_input = ui.input(
                        label="Dossier des modèles (ex: H:\\lmstudio)",
                        value=_default_dir,
                        placeholder="H:\\lmstudio ou /home/user/.lmstudio/models",
                    ).classes("w-full text-xs")
                    ui.label(
                        "Laissez vide pour la détection automatique. "
                        "Saisissez le chemin exact si l'auto-détection se trompe."
                    ).classes("text-xs text-gray-600")

                    def _save_lms_config():
                        new_url = lms_url_input.value.strip().rstrip("/")
                        new_dir = lms_dir_input.value.strip()
                        env_path = (
                            f"{state.active_folder}/.env"
                            if state.active_folder
                            else str(pathlib.Path.home() / ".env")
                        )
                        lines = []
                        if new_url:
                            final_url = new_url if new_url.endswith("/v1") else new_url + "/v1"
                            os.environ["LMSTUDIO_BASE_URL"] = final_url
                            lines.append(f"LMSTUDIO_BASE_URL={final_url}")
                        if new_dir and pathlib.Path(new_dir).is_dir():
                            os.environ["LMSTUDIO_MODELS_DIR"] = new_dir
                            lines.append(f"LMSTUDIO_MODELS_DIR={new_dir}")
                        elif new_dir:
                            ui.notify(f"Chemin introuvable : {new_dir}", type="negative")
                            return
                        if lines:
                            with open(env_path, "a", encoding="utf-8") as f:
                                f.write("\n" + "\n".join(lines) + "\n")
                        ui.notify("Configuration LM Studio sauvegardée", type="positive")

                    ui.button("💾 Sauvegarder", on_click=_save_lms_config).classes(
                        "text-xs bg-gray-800 text-gray-400 border border-gray-700 px-2 py-1 rounded"
                    )

            with ui.expansion("🗄 Gérer les modèles LM Studio").classes("w-full mt-1"):
                with ui.column().classes("gap-1 p-1 w-full"):
                    manage_status = ui.label(
                        "Cliquez sur Charger pour lister les modèles installés."
                    ).classes("text-xs text-gray-600")
                    manage_container = ui.column().classes("w-full gap-1 mt-1")

                    async def _load_manage():
                        manage_status.set_text("Chargement…")
                        models = await run.io_bound(get_available_lmstudio_models)
                        manage_container.clear()
                        if not models:
                            manage_status.set_text("Aucun modèle installé détecté.")
                            return
                        manage_status.set_text(f"{len(models)} modèle(s) installé(s)")
                        with manage_container:
                            for m in models:
                                uninstall_lbl = ui.label("").classes(
                                    "text-xs text-gray-500 font-mono mt-0.5"
                                )
                                async def _uninstall(model_id=m, lbl=uninstall_lbl):
                                    lbl.set_text("🗑 Suppression…")
                                    result = await run.io_bound(_do_uninstall_lmstudio, model_id)
                                    lbl.set_text(result)
                                    if "✅" in result:
                                        await run.io_bound(lambda: None)  # yield
                                        await _load_manage()

                                with ui.row().classes(
                                    "items-center gap-2 py-1 px-2 rounded bg-gray-900 w-full"
                                ):
                                    ui.label(m).classes(
                                        "text-xs text-gray-300 flex-1 font-mono truncate"
                                    )
                                    ui.button("🗑", on_click=_uninstall).classes(
                                        "text-xs bg-red-950 text-red-400 border border-red-900 "
                                        "w-7 h-7 flex-shrink-0"
                                    ).props("flat dense")
                                uninstall_lbl

                    ui.button("🔄 Charger les modèles installés", on_click=_load_manage).classes(
                        "text-xs bg-gray-800 text-gray-400 border border-gray-700 px-2 py-1 rounded"
                    )

            ui.separator().classes("my-2 border-gray-800")

            # ── llama.cpp ──
            ui.label("llama.cpp (local)").classes("text-xs text-gray-500 uppercase tracking-widest mb-1")
            lcp_status = ui.label(
                "Cliquez sur Détecter pour lister les modèles téléchargés."
            ).classes("text-xs text-gray-600")
            lcp_container = ui.column().classes("w-full gap-0")

            async def _detect_llamacpp():
                lcp_status.set_text("Détection en cours…")
                models = await run.io_bound(get_available_llamacpp_models)
                lcp_container.clear()
                if not models:
                    lcp_status.set_text(f"Aucun modèle détecté dans {_LLAMACPP_MODELS_DIR}")
                    return
                lcp_status.set_text(f"{len(models)} modèle(s) disponible(s)")
                with lcp_container:
                    for mdl in models:
                        with ui.row().classes(
                            "items-center gap-2 py-1 px-2 rounded hover:bg-gray-900 cursor-pointer"
                        ).on("click", lambda m=mdl: _select_model("llamacpp", m, dlg)):
                            ui.element("div").classes("w-2 h-2 rounded-full bg-yellow-400")
                            ui.label(mdl).classes("text-xs text-gray-300 flex-1 font-mono truncate")
                            ui.label("llama.cpp · GPU").classes("text-xs text-gray-600")

            ui.button("🔍 Détecter llama.cpp", on_click=_detect_llamacpp).classes(
                "text-xs bg-gray-800 text-gray-400 border border-gray-700 px-2 py-1 rounded"
            )

            with ui.expansion("📦 Télécharger un modèle llama.cpp").classes("w-full mt-1"):
                with ui.column().classes("gap-1 p-1 w-full"):
                    lcp_sys_lbl = ui.label("Cliquez sur Analyser pour afficher les recommandations.").classes(
                        "text-xs text-gray-600"
                    )
                    lcp_progress = ui.label("").classes("text-xs text-gray-500 font-mono mt-1")
                    lcp_catalog = ui.column().classes("w-full gap-1 mt-1")

                    async def _show_lcp_catalog():
                        lcp_sys_lbl.set_text("Analyse du matériel…")
                        sinfo = await run.io_bound(get_system_info)
                        ram, vram, gpu = sinfo["ram_gb"], sinfo["vram_gb"], sinfo["gpu_name"] or "Aucun GPU"
                        lcp_sys_lbl.set_text(f"Système : {ram} GB RAM · {vram} GB VRAM ({gpu})")
                        lcp_catalog.clear()
                        with lcp_catalog:
                            for m in _FULL_CATALOG:
                                can_gpu = vram >= m["vram_min"]
                                can_cpu = ram >= m["ram_min"]
                                if can_gpu:
                                    badge, bcls = "GPU ✓", "bg-green-900 text-green-400"
                                elif can_cpu:
                                    badge, bcls = "CPU lent", "bg-yellow-900 text-yellow-400"
                                else:
                                    badge, bcls = "⚠ insuff.", "bg-gray-800 text-gray-600"
                                stars = "★" * m["tool_stars"] + "☆" * (5 - m["tool_stars"])
                                with ui.row().classes("items-center gap-1 py-1 w-full"):
                                    with ui.column().classes("flex-1 gap-0 min-w-0"):
                                        ui.label(m["name"]).classes("text-xs text-gray-200 font-mono")
                                        ui.label(f"Tool use {stars} · {m['desc']}").classes(
                                            "text-xs text-gray-600 truncate"
                                        )
                                    ui.label(badge).classes(f"text-xs px-1 rounded flex-shrink-0 {bcls}")
                                    ui.button(
                                        "↓",
                                        on_click=lambda hf=m["hf_id"]: _install_llamacpp_model(hf, lcp_progress),
                                    ).classes("text-xs bg-gray-700 text-gray-300 w-6 h-6 flex-shrink-0").props("flat dense")
                            ui.label(
                                f"Modèles stockés dans {_LLAMACPP_MODELS_DIR}. "
                                "Le serveur llama.cpp se lance automatiquement à la première utilisation."
                            ).classes("text-xs text-gray-700 italic mt-1")

                    ui.button("🖥 Analyser mon matériel", on_click=_show_lcp_catalog).classes(
                        "text-xs bg-gray-800 text-gray-400 border border-gray-700 px-2 py-1 rounded"
                    )

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
