import re
import os
import logging
import subprocess
from typing import Any
from dotenv import load_dotenv, find_dotenv
from langchain_core.callbacks import BaseCallbackHandler

# usecwd=True ensures we search from where the user runs the command,
# not from this file's location in the installed package.
load_dotenv(find_dotenv(usecwd=True) or find_dotenv())

logger = logging.getLogger("openagent.context")

_SHOW_CONTEXT = os.environ.get("OPENCODE_SHOW_CONTEXT", "0") == "1"


class ContextLoggerCallback(BaseCallbackHandler):
    """Logs the full context sent to the LLM at each call so you can see
    exactly what tokens are being consumed.
    Set OPENCODE_SHOW_CONTEXT=1 to enable."""

    call_index = 0

    def on_llm_start(self, serialized: dict, prompts: list, **kwargs: Any) -> None:
        if not _SHOW_CONTEXT:
            return
        ContextLoggerCallback.call_index += 1
        idx = ContextLoggerCallback.call_index
        messages = kwargs.get("messages", [])
        if not messages:
            total_chars = sum(len(p) for p in prompts)
            logger.info("── LLM call #%d ── %d chars (~%d tokens) ──",
                        idx, total_chars, total_chars // 4)
            return

        total_chars = 0
        lines = [f"\n{'─'*60}", f"  LLM call #{idx}"]
        for msg_list in messages:
            for msg in msg_list:
                role = getattr(msg, "type", type(msg).__name__)
                content = getattr(msg, "content", "") or ""
                if isinstance(content, list):
                    content = " ".join(
                        c.get("text", "") if isinstance(c, dict) else str(c)
                        for c in content
                    )
                chars = len(content)
                total_chars += chars
                preview = content[:200].replace("\n", "↵")
                if len(content) > 200:
                    preview += f"... (+{chars - 200} chars)"
                lines.append(f"  [{role:10s}] {chars:6d} chars | {preview}")
        lines.append(f"  TOTAL: {total_chars} chars (~{total_chars // 4} tokens)")
        lines.append("─" * 60)
        logger.info("\n".join(lines))


def parse_mentions(text: str) -> list[str]:
    """Parser les mentions @ du user pour sélectionner les fichiers qu'il mentionne."""
    return re.findall(r"@([\w./\\-]+)", text)


def mode_router(mode: str) -> str:
    """Retourne le system prompt additionnel selon le mode ask/auto/plan choisi par le user."""
    modes = {
        "ask": "Only answer questions and explain. Do NOT modify any files or run any commands.",
        "auto": "Work autonomously: plan, edit files, and run commands as needed to complete the task.",
        "plan": "First produce a detailed step-by-step plan and wait for user approval before doing anything.",
    }
    if mode not in modes:
        raise ValueError(f"Unknown mode '{mode}'. Choose from: {list(modes.keys())}")
    return modes[mode]


# ---------------------------------------------------------------------------
# Provider detection — first matching key wins
# ---------------------------------------------------------------------------

_PROVIDERS = [
    ("TOGETHER_API_KEY",    "together"),
    ("GROQ_API_KEY",        "groq"),
    ("MISTRAL_API_KEY",     "mistral"),
    ("GEMINI_API_KEY",      "gemini"),
    ("OPENROUTER_API_KEY",  "openrouter"),
]

_DEFAULT_MODELS = {
    "together":   "Qwen/Qwen3-Coder-Next-FP8",
    "groq":       "moonshotai/kimi-k2-instruct",
    "mistral":    "codestral-latest",
    "gemini":     "gemini-2.5-pro-preview-03-25",
    "openrouter": "kwaipilot/kat-coder-pro-v2",
    "ollama":     "qwen2.5-coder",
    "lmstudio":   "local-model",
    "llamacpp":   "",
}

_DEFAULT_CTX_LIMITS: dict[str, int] = {
    "together":   128_000,
    "groq":       128_000,
    "mistral":    32_000,
    "gemini":     1_000_000,
    "openrouter": 128_000,
    "ollama":     32_000,
    "lmstudio":   32_000,
    "llamacpp":   32_000,
}

_LLAMACPP_PORT = 8080
_LLAMACPP_MODELS_DIR = os.path.join(os.path.expanduser("~"), ".openagenticskyzer", "models")


def get_available_ollama_models() -> list[str]:
    """Return list of locally installed Ollama models. Empty list if Ollama not found."""
    try:
        result = subprocess.run(
            ["ollama", "list"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return []
        lines = result.stdout.strip().splitlines()
        # Skip header line, parse first column (NAME)
        return [
            line.split()[0] for line in lines[1:]
            if line.strip() and len(line.split()) >= 1
        ]
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return []


def get_lmstudio_models_dir() -> "pathlib.Path":
    """Détecte le dossier de modèles LM Studio configuré par l'utilisateur.
    Stratégies dans l'ordre :
    1. SDK Python → chemin d'un modèle existant (le plus fiable)
    2. Fichiers de config Electron de LM Studio
    3. Fallback ~/.lmstudio/models/
    """
    import pathlib as _pl, json as _json, os as _os

    # 0 — Var d'environnement explicite (priorité absolue)
    explicit = _os.environ.get("LMSTUDIO_MODELS_DIR", "").strip()
    if explicit and _pl.Path(explicit).is_dir():
        return _pl.Path(explicit)

    # 1 — SDK Python : extraire le répertoire racine depuis le chemin d'un modèle
    try:
        import lmstudio as lms  # type: ignore[import]
        with lms.Client() as client:
            downloaded = client.system.list_downloaded_models()
            for m in downloaded:
                p = getattr(m, "path", None) or getattr(m, "model_path", None)
                if p:
                    # Structure : <models_dir>/<publisher>/<model>/<file>.gguf
                    candidate = _pl.Path(p).parent.parent.parent
                    if candidate.is_absolute() and candidate.is_dir():
                        return candidate
    except Exception:
        pass

    # 2 — CLI `lms ls` : extraire un chemin absolu depuis la sortie
    try:
        import subprocess as _sp, re as _re
        out = _sp.run(
            ["lms", "ls"], capture_output=True, text=True, timeout=8,
            creationflags=0x08000000 if _os.name == "nt" else 0,
        ).stdout
        # Cherche un chemin absolu Windows (ex: H:\lmstudio\...) ou POSIX (/home/...)
        paths = _re.findall(r"[A-Za-z]:[\\\/][^\s\|│├┤]+|\/[^\s\|│├┤]{5,}", out)
        for raw in paths:
            p = _pl.Path(raw.rstrip("\\/"))
            # Remonter jusqu'à trouver un répertoire existant de profondeur ≥ 1
            for candidate in [p, p.parent, p.parent.parent, p.parent.parent.parent]:
                if candidate.is_absolute() and candidate.is_dir() and candidate != candidate.parent:
                    return candidate
    except Exception:
        pass

    # 3 — Fichiers de config Electron (LM Studio stocke ses préfs ici)
    appdata = _os.environ.get("APPDATA", "")
    localappdata = _os.environ.get("LOCALAPPDATA", "")
    cfg_candidates = [
        _pl.Path(appdata) / "LM Studio" / "app-settings.json",
        _pl.Path(appdata) / "LM Studio" / "settings.json",
        _pl.Path(appdata) / "LM Studio" / "user-settings.json",
        _pl.Path(localappdata) / "LM Studio" / "app-settings.json",
        _pl.Path.home() / ".lmstudio" / "settings.json",
        _pl.Path.home() / ".lmstudio" / "config.json",
    ]
    for cfg in cfg_candidates:
        try:
            data = _json.loads(cfg.read_text(encoding="utf-8"))
            for key in ("modelsPath", "modelsDir", "models_dir", "storagePath", "modelDir", "modelsDirectory"):
                val = data.get(key) or (data.get("paths", {}) or {}).get(key)
                if val and _pl.Path(val).is_dir():
                    return _pl.Path(val)
        except Exception:
            pass

    # 3 — Fallback
    return _pl.Path.home() / ".lmstudio" / "models"


def get_available_lmstudio_models(base_url: str = "http://localhost:1234") -> list[str]:
    """Return models available in LM Studio.
    1. Loaded models via HTTP API (server running + model loaded).
    2. CLI `lms ls` — downloaded models, ne nécessite pas la GUI.
    3. SDK Python lmstudio IPC — GUI requise.
    4. Filesystem scan du dossier LM Studio détecté automatiquement.
    """
    import pathlib as _pl

    # 1 — HTTP OpenAI-compatible API (modèles actuellement chargés)
    try:
        import urllib.request, json as _json
        with urllib.request.urlopen(f"{base_url}/v1/models", timeout=3) as resp:
            data = _json.loads(resp.read().decode())
            ids = [m["id"] for m in data.get("data", [])]
            if ids:
                return ids
    except Exception:
        pass

    # 2 — CLI `lms ls` (modèles téléchargés, ne nécessite pas la GUI)
    try:
        import subprocess as _sp, re as _re
        result = _sp.run(
            ["lms", "ls"], capture_output=True, text=True, timeout=8,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        # Chaque ligne contenant un slash est probablement un model_key (ex: qwen/qwen2.5-coder-7b)
        ids = _re.findall(r"[\w.-]+/[\w.-]+(?:/[\w.-]+)*", result.stdout)
        if ids:
            return ids
    except Exception:
        pass

    # 3 — SDK Python lmstudio (modèles téléchargés via IPC — GUI requise)
    try:
        import lmstudio as lms  # type: ignore[import]
        with lms.Client() as client:
            downloaded = client.system.list_downloaded_models()
            ids = [m.model_key for m in downloaded]
            if ids:
                return ids
    except Exception:
        pass

    # 4 — Scan filesystem (dossier détecté automatiquement)
    models_dir = get_lmstudio_models_dir()
    if models_dir.exists():
        ids = [gguf.stem for gguf in models_dir.rglob("*.gguf") if not gguf.name.endswith(".tmp")]
        if ids:
            return ids

    return []


def get_system_info() -> dict:
    """Return {ram_gb, vram_gb, gpu_name} from system hardware."""
    info: dict = {"ram_gb": 0, "vram_gb": 0, "gpu_name": ""}
    # RAM via psutil ou wmic
    try:
        import psutil
        info["ram_gb"] = round(psutil.virtual_memory().total / (1024 ** 3))
    except ImportError:
        try:
            r = subprocess.run(
                ["wmic", "computersystem", "get", "TotalPhysicalMemory"],
                capture_output=True, text=True, timeout=4,
            )
            for ln in r.stdout.splitlines():
                if ln.strip().isdigit():
                    info["ram_gb"] = int(ln.strip()) // (1024 ** 3)
                    break
        except Exception:
            pass
    # VRAM NVIDIA via nvidia-smi
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total,name",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=4,
        )
        if r.returncode == 0:
            parts = r.stdout.strip().split(",", 1)
            info["vram_gb"] = round(int(parts[0].strip()) / 1024)
            info["gpu_name"] = parts[1].strip() if len(parts) > 1 else "NVIDIA GPU"
    except Exception:
        pass
    return info


def _detect_provider() -> tuple[str, str, str]:
    """Return (provider, api_key, model). Raises if no key found."""
    for env_key, provider in _PROVIDERS:
        api_key = os.environ.get(env_key, "").strip()
        if api_key:
            model_env = f"{provider.upper()}_MODEL"
            model = os.environ.get(model_env, _DEFAULT_MODELS[provider])
            logger.info("Provider: %s | Model: %s", provider, model)
            return provider, api_key, model

    # Ollama is local — no API key required, triggered by OLLAMA_MODEL
    ollama_model = os.environ.get("OLLAMA_MODEL", "").strip()
    if ollama_model:
        model = ollama_model
        logger.info("Provider: ollama | Model: %s", model)
        return "ollama", "local", model

    keys = ", ".join(k for k, _ in _PROVIDERS)
    raise EnvironmentError(
        f"No API key found. Set one of: {keys} in your .env file.\n"
        "Together:   https://api.together.xyz/settings/api-keys\n"
        "Groq:       https://console.groq.com/keys\n"
        "Mistral:    https://console.mistral.ai/api-keys\n"
        "Gemini:     https://aistudio.google.com/app/apikey\n"
        "OpenRouter: https://openrouter.ai/settings/keys\n"
        "Ollama:     set OLLAMA_MODEL=<model-name> (e.g. qwen2.5-coder) — no API key needed"
    )


def get_langfuse_handler():
    """Return a LangfuseCallbackHandler if keys are set, else None."""
    if not (os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")):
        return None
    try:
        from langfuse.langchain import CallbackHandler as LangfuseCallbackHandler
        return LangfuseCallbackHandler()
    except Exception:
        return None


_PROVIDER_EXTRAS = {
    "together":   "pip install openagenticskyzer[together]",
    "groq":       "pip install openagenticskyzer[groq]",
    "mistral":    "pip install openagenticskyzer[mistral]",
    "gemini":     "pip install openagenticskyzer[gemini]",
    "openrouter": "pip install openagenticskyzer[openrouter]",
    "ollama":     "pip install openagenticskyzer[ollama]",
    "lmstudio":   "pip install langchain-openai",
    "llamacpp":   "pip install llama-cpp-python[server] langchain-openai",
}


def _missing_provider(provider: str) -> ModuleNotFoundError:
    cmd = _PROVIDER_EXTRAS.get(provider, f"pip install openagenticskyzer[{provider}]")
    return ModuleNotFoundError(
        f"\nProvider '{provider}' is not installed.\n"
        f"Run: {cmd}\n"
    )


def get_available_llamacpp_models() -> list[str]:
    """Scan ~/.openagenticskyzer/models/ pour les fichiers GGUF téléchargés."""
    import pathlib as _pl
    models_dir = _pl.Path(_LLAMACPP_MODELS_DIR)
    if not models_dir.exists():
        return []
    return [
        str(f.relative_to(models_dir))
        for f in sorted(models_dir.rglob("*.gguf"))
        if not f.name.endswith(".tmp")
    ]


def _llamacpp_chat_format(model_name: str) -> str:
    """Détermine le format de chat selon le nom du modèle."""
    n = model_name.lower()
    if "llama-3" in n or "llama3" in n:
        return "llama-3"
    if "deepseek" in n:
        return "deepseek"
    return "chatml"  # Qwen, Mistral, Hermes, etc.


_llamacpp_proc = None


def _ensure_llamacpp_server(model_path: str) -> None:
    """Démarre le serveur llama.cpp si absent, avec GPU layers activés."""
    import urllib.request as _ur, time as _t, sys as _sys, pathlib as _pl
    global _llamacpp_proc

    base = f"http://localhost:{_LLAMACPP_PORT}"
    try:
        _ur.urlopen(f"{base}/v1/models", timeout=2)
        return  # Déjà actif
    except Exception:
        pass

    chat_fmt = _llamacpp_chat_format(_pl.Path(model_path).name)
    try:
        _llamacpp_proc = subprocess.Popen(
            [
                _sys.executable, "-m", "llama_cpp.server",
                "--model", model_path,
                "--port", str(_LLAMACPP_PORT),
                "--n_gpu_layers", "-1",       # tout sur GPU si dispo
                "--n_ctx", "8192",
                "--chat_format", chat_fmt,
                "--host", "127.0.0.1",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
    except FileNotFoundError:
        raise ModuleNotFoundError(
            "llama-cpp-python[server] non installé. "
            "Exécutez : pip install llama-cpp-python[server] langchain-openai"
        )

    # Attendre que le serveur soit prêt (max 30 s)
    for _ in range(60):
        try:
            _ur.urlopen(f"{base}/v1/models", timeout=0.5)
            return
        except Exception:
            _t.sleep(0.5)
    raise TimeoutError("Serveur llama.cpp non démarré après 30 s.")


def ensure_lmstudio_runtime() -> str:
    """Vérifie que le runtime llama.cpp est installé, l'installe si besoin.
    Retourne 'runtime_ok', 'runtime_installed', 'lms_absent' ou 'erreur: …'.
    """
    import time as _t
    try:
        result = subprocess.run(
            ["lms", "runtime", "ls"],
            capture_output=True, text=True, timeout=10,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        if result.stdout.strip():
            return "runtime_ok"
        # Aucun runtime installé → télécharger llama.cpp
        subprocess.run(
            ["lms", "runtime", "get", "llama.cpp", "-y"],
            capture_output=True, text=True, timeout=300,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        # Redémarrer le serveur pour qu'il prenne en compte le nouveau runtime
        subprocess.run(["lms", "server", "stop"], capture_output=True, timeout=10,
                       creationflags=0x08000000 if os.name == "nt" else 0)
        _t.sleep(1)
        subprocess.Popen(["lms", "server", "start"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=0x08000000 if os.name == "nt" else 0)
        _t.sleep(3)
        return "runtime_installed"
    except FileNotFoundError:
        return "lms_absent"
    except Exception as e:
        return f"erreur: {e}"


_MODEL_LAYER_COUNTS: dict[str, int] = {
    "1.5b": 28, "1b": 16,
    "3.8b": 32, "3b": 28,
    "7b": 32, "8b": 32,
    "9b": 42, "12b": 40,
    "14b": 48, "15b": 40,
    "22b": 56, "24b": 40,
    "27b": 46, "32b": 64,
    "70b": 80, "72b": 80,
}


def estimate_gpu_layers(vram_available_gb: float, model_id: str) -> int:
    """Convertit une VRAM disponible (GB) en nombre de couches GPU.

    Retourne -1 si tout le modèle rentre en VRAM (= auto/max).
    Retourne 0 si la VRAM disponible est insuffisante (CPU seul).
    """
    import re as _re
    lower = model_id.lower()

    # Nombre de couches total — cherche d'abord par taille exacte, puis défaut 7B
    total_layers = 32
    m = _re.search(r'(\d+(?:\.\d+)?)b', lower)
    params_b = float(m.group(1)) if m else 7.0
    # Tri descendant pour matcher "14b" avant "1b"
    for key in sorted(_MODEL_LAYER_COUNTS, key=lambda k: -float(k.replace("b", ""))):
        if key in lower:
            total_layers = _MODEL_LAYER_COUNTS[key]
            break

    # Taille estimée Q4_K_M ≈ 0.55 GB par milliard de paramètres
    file_gb = params_b * 0.55
    if file_gb <= 0:
        return -1

    gb_per_layer = file_gb / total_layers
    layers = int(vram_available_gb / gb_per_layer)

    return -1 if layers >= total_layers else max(0, layers)


def lmstudio_load_model(model_id: str, gpu_layers: int | None = None,
                        ctx_length: int | None = None) -> str:
    """Charge un modèle dans LM Studio. Retourne 'ok' ou un message d'erreur.

    Stratégie :
    1. SDK Python lmstudio (IPC direct, supporte contextLength)
    2. CLI lms avec unload préalable + --context-length
    """
    import time as _t
    _cf = 0x08000000 if os.name == "nt" else 0

    # ── 1. SDK Python lmstudio ───────────────────────────────────────────────
    try:
        import lmstudio as lms  # type: ignore[import]
        with lms.Client() as _client:
            # Unload d'abord si chargé (nécessaire pour changer le contexte)
            try:
                _client.llm.unload(model_id)
                _t.sleep(0.5)
            except Exception:
                pass
            # Config de chargement
            _cfg: dict = {}
            if ctx_length and ctx_length > 0:
                _cfg["contextLength"] = ctx_length
            if gpu_layers is not None and gpu_layers >= 0:
                _cfg["gpuOffload"] = {"ratio": "off" if gpu_layers == 0 else "auto"}
            if _cfg:
                _client.llm.load(model_id, _cfg)
            else:
                _client.llm.load(model_id)
        _t.sleep(1)
        return "ok"
    except Exception:
        pass  # SDK absent ou erreur → fallback CLI

    # ── 2. CLI lms (unload + reload) ─────────────────────────────────────────
    try:
        # Unload préalable pour que --context-length soit pris en compte
        if ctx_length and ctx_length > 0:
            subprocess.run(
                ["lms", "unload", model_id],
                capture_output=True, text=True, timeout=30, creationflags=_cf,
            )
            _t.sleep(1)

        cmd = ["lms", "load", model_id, "--yes"]
        if gpu_layers is not None and gpu_layers >= 0:
            cmd += ["--gpu", str(gpu_layers)]
        if ctx_length and ctx_length > 0:
            cmd += ["--context-length", str(ctx_length)]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300, creationflags=_cf,
        )
        _t.sleep(1)
        combined = (result.stderr + result.stdout).strip()
        if result.returncode != 0 or "Error:" in combined:
            return combined or "erreur"
        return "ok"
    except subprocess.TimeoutExpired:
        return "timeout: modèle trop long à charger (> 5 min)"
    except Exception as e:
        return f"erreur: {e}"


def _ensure_ollama_server(base_url: str, model: str) -> None:
    """Démarre Ollama s'il ne tourne pas et tire le modèle s'il est absent."""
    import urllib.request as _ur, time as _t

    def _reachable() -> bool:
        try:
            _ur.urlopen(f"{base_url}/api/tags", timeout=2)
            return True
        except Exception:
            return False

    if not _reachable():
        try:
            subprocess.Popen(
                ["ollama", "serve"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
            for _ in range(20):  # attend max 10 s
                _t.sleep(0.5)
                if _reachable():
                    break
        except FileNotFoundError:
            return  # ollama absent — erreur naturelle à l'appel LLM

    # Vérifie si le modèle est déjà présent localement
    try:
        import json as _json
        with _ur.urlopen(f"{base_url}/api/tags", timeout=3) as r:
            tags = _json.loads(r.read().decode())
        local_ids = [m["name"].split(":")[0] for m in tags.get("models", [])]
        model_base = model.split(":")[0]
        if model_base not in local_ids:
            subprocess.run(
                ["ollama", "pull", model],
                capture_output=True, timeout=600,
            )
    except Exception:
        pass


def _lmstudio_is_loaded(model_id: str) -> bool:
    """Vérifie via `lms ps` si le modèle est déjà chargé en mémoire."""
    try:
        result = subprocess.run(
            ["lms", "ps"], capture_output=True, text=True, timeout=8,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        return model_id.lower() in result.stdout.lower()
    except Exception:
        return False


def _ensure_lmstudio_server(base_url: str) -> None:
    """Lance le serveur LM Studio via `lms server start` s'il ne répond pas déjà."""
    import urllib.request as _ur
    try:
        _ur.urlopen(base_url.replace("/v1", "") + "/v1/models", timeout=2)
        return  # Déjà actif
    except Exception:
        pass
    try:
        subprocess.Popen(
            ["lms", "server", "start"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        import time as _t
        _t.sleep(2)
    except FileNotFoundError:
        pass  # lms CLI absent — l'utilisateur doit démarrer manuellement


def get_llm(provider: str | None = None, model: str | None = None):
    if provider and model:
        if provider in ("ollama", "lmstudio", "llamacpp"):
            api_key = "local"
        else:
            env_key = f"{provider.upper()}_API_KEY"
            api_key = os.environ.get(env_key, "").strip()
            if not api_key:
                raise EnvironmentError(
                    f"Clé API manquante pour {provider}. Définissez {env_key} dans votre .env."
                )
    else:
        provider, api_key, model = _detect_provider()
    callbacks = [ContextLoggerCallback()]

    llm: Any

    if provider == "together":
        try:
            from langchain_together import ChatTogether  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("together")
        # langchain_together initializes an openai.OpenAI client internally which
        # requires OPENAI_API_KEY — set it from the Together key as a workaround.
        os.environ.setdefault("OPENAI_API_KEY", api_key)
        llm = ChatTogether(**dict(  # type: ignore[arg-type]
            model=model,
            together_api_key=api_key,
            max_tokens=16_384,
            streaming=True,
            callbacks=callbacks,
        ))

    elif provider == "groq":
        try:
            from langchain_groq import ChatGroq  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("groq")
        llm = ChatGroq(**dict(  # type: ignore[arg-type]
            model=model,
            groq_api_key=api_key,
            max_tokens=8_192,
            streaming=True,
            callbacks=callbacks,
        ))

    elif provider == "mistral":
        try:
            from langchain_mistralai import ChatMistralAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("mistral")
        from pydantic import SecretStr
        llm = ChatMistralAI(  # type: ignore[call-arg]
            model_name=model,
            api_key=SecretStr(api_key),
            max_tokens=16_384,
            streaming=True,
        )
        llm.callbacks = callbacks  # type: ignore[assignment]

    elif provider == "gemini":
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("gemini")
        llm = ChatGoogleGenerativeAI(  # type: ignore[call-arg]
            model=model,
            google_api_key=api_key,
            max_output_tokens=16_384,
            streaming=True,
            callbacks=callbacks,
        )

    elif provider == "openrouter":
        try:
            from langchain_openai import ChatOpenAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("openrouter")
        site_url = os.environ.get("OPENROUTER_SITE_URL", "")
        site_name = os.environ.get("OPENROUTER_SITE_NAME", "")
        extra_headers: dict[str, str] = {}
        if site_url:
            extra_headers["HTTP-Referer"] = site_url
        if site_name:
            extra_headers["X-Title"] = site_name
        openrouter_kwargs: dict[str, Any] = dict(
            model=model,
            api_key=api_key,
            base_url="https://openrouter.ai/api/v1",
            max_completion_tokens=16_384,
            streaming=True,
            callbacks=callbacks,
        )
        if extra_headers:
            openrouter_kwargs["default_headers"] = extra_headers
        llm = ChatOpenAI(**openrouter_kwargs)  # type: ignore[arg-type]

    elif provider == "ollama":
        try:
            from langchain_ollama import ChatOllama  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("ollama")
        base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
        _ensure_ollama_server(base_url, model)
        llm = ChatOllama(  # type: ignore[call-arg]
            model=model,
            base_url=base_url,
            streaming=True,
            callbacks=callbacks,
        )

    elif provider == "lmstudio":
        try:
            from langchain_openai import ChatOpenAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("lmstudio")
        base_url = os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1")
        _ensure_lmstudio_server(base_url)
        ensure_lmstudio_runtime()
        if model and not _lmstudio_is_loaded(model):
            _ctx_env = os.environ.get("LMSTUDIO_CONTEXT_LENGTH", "").strip()
            _ctx_arg = int(_ctx_env) if _ctx_env and _ctx_env.isdigit() else None
            lmstudio_load_model(model, ctx_length=_ctx_arg)
        llm = ChatOpenAI(  # type: ignore[arg-type]
            model=model,
            api_key="lm-studio",
            base_url=base_url,
            max_tokens=8192,
            streaming=True,
            callbacks=callbacks,
        )

    elif provider == "llamacpp":
        try:
            from langchain_openai import ChatOpenAI  # type: ignore[import]
        except ModuleNotFoundError:
            raise _missing_provider("llamacpp")
        import pathlib as _pl
        # model contient le chemin relatif au dossier models (ex: "Qwen/.../file.gguf")
        model_path = (
            model if _pl.Path(model).is_absolute()
            else os.path.join(_LLAMACPP_MODELS_DIR, model)
        )
        _ensure_llamacpp_server(model_path)
        llm = ChatOpenAI(  # type: ignore[arg-type]
            model="local",
            api_key="llamacpp",
            base_url=f"http://localhost:{_LLAMACPP_PORT}/v1",
            max_tokens=8192,
            streaming=True,
            callbacks=callbacks,
        )

    else:
        raise EnvironmentError(f"Unknown provider: {provider}")

    return llm
