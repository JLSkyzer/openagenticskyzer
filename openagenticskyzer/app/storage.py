"""Config and folder index persistence for the GUI app."""
import json
import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path


# ── Chemins ───────────────────────────────────────────────────────────────────

def _openagent_home() -> Path:
    """~/.openagent/ ou $OPENAGENT_HOME (tests)."""
    custom = os.environ.get("OPENAGENT_HOME")
    if custom:
        return Path(custom)
    return Path.home() / ".openagent"


def _global_config_path() -> Path:
    return _openagent_home() / "config.json"


def _folder_index_path() -> Path:
    return _openagent_home() / "folders.json"


def _folder_config_path(folder: str) -> Path:
    return Path(folder) / ".openagent" / "config.json"


def get_data_home() -> Path:
    """Répertoire de données configuré par l'utilisateur (défaut : ~/.openagent/)."""
    cfg_path = _global_config_path()
    if cfg_path.exists():
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            data_dir = data.get("data_dir", "").strip()
            if data_dir:
                p = Path(data_dir)
                if p.is_dir():
                    return p
        except Exception:
            pass
    return _openagent_home()


# ── Valeurs par défaut ────────────────────────────────────────────────────────

DEFAULT_GLOBAL_CONFIG: dict = {
    "agent_mode": "auto",
    "auto_compact": True,
    "compact_threshold": 70,
    "max_tokens": None,
    "reserved_tokens": 2048,
    "show_context_bar": True,
    "session_retention_days": 30,
    "animations": True,
    "restore_last_folder": True,
    "permission_mode": "demander",
    "shell_ask": True,
    "files_ask": False,
    "search_ask": False,
    "data_dir": "",  # vide = ~/.openagent/
}

DEFAULT_FOLDER_CONFIG: dict = {
    "agent_mode": "inherit",
    "ignored_patterns": "node_modules/, .env, dist/",
    "custom_prompt": "",
    "override_permissions": False,
}


# ── Config globale ────────────────────────────────────────────────────────────

def load_global_config() -> dict:
    path = _global_config_path()
    if not path.exists():
        return DEFAULT_GLOBAL_CONFIG.copy()
    try:
        return {**DEFAULT_GLOBAL_CONFIG, **json.loads(path.read_text(encoding="utf-8"))}
    except (json.JSONDecodeError, OSError):
        return DEFAULT_GLOBAL_CONFIG.copy()


def save_global_config(config: dict) -> None:
    path = _global_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")


# ── Config dossier ────────────────────────────────────────────────────────────

def load_folder_config(folder: str) -> dict:
    path = _folder_config_path(folder)
    if not path.exists():
        return DEFAULT_FOLDER_CONFIG.copy()
    try:
        return {**DEFAULT_FOLDER_CONFIG, **json.loads(path.read_text(encoding="utf-8"))}
    except (json.JSONDecodeError, OSError):
        return DEFAULT_FOLDER_CONFIG.copy()


def save_folder_config(folder: str, config: dict) -> None:
    path = _folder_config_path(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2), encoding="utf-8")


# ── Calcul du contexte ────────────────────────────────────────────────────────

def compute_context_pct(messages: list, provider: str | None = None) -> tuple[int, float]:
    """Retourne (context_tokens, context_pct) à partir de l'historique et de la config."""
    from openagenticskyzer.utils.utils import _DEFAULT_CTX_LIMITS
    cfg = load_global_config()
    max_ctx = _DEFAULT_CTX_LIMITS.get(provider or "ollama", 32_000)
    configured_max = cfg.get("max_tokens") or max_ctx
    reserved = int(cfg.get("reserved_tokens", 2048))
    max_tokens = max(1, configured_max - reserved)
    total_chars = sum(len(m.content) for m in messages if m.role in ("user", "ai"))
    tokens = total_chars // 4
    pct = min(100.0, tokens / max_tokens * 100)
    return tokens, pct


# ── Historique chat par dossier ───────────────────────────────────────────────

def _chat_history_path(folder: str) -> Path:
    return Path(folder) / ".openagent" / "chat_history.json"


def save_chat_history(folder: str, messages: list) -> None:
    if not folder:
        return
    path = _chat_history_path(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = [
        {
            "role": m.role,
            "content": m.content,
            "tool_name": m.tool_name,
            "tool_tag": m.tool_tag,
            "tool_detail": m.tool_detail,
            "tool_diff": m.tool_diff,
        }
        for m in messages
    ]
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_chat_history(folder: str) -> list[dict]:
    path = _chat_history_path(folder)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def clear_chat_history(folder: str) -> None:
    path = _chat_history_path(folder)
    try:
        if path.exists():
            path.unlink()
    except Exception:
        pass


# ── Index des dossiers ────────────────────────────────────────────────────────

def load_folder_index() -> list[dict]:
    path = _folder_index_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return []
        return data
    except (json.JSONDecodeError, OSError):
        return []


def add_folder_to_index(folder: str) -> None:
    index = load_folder_index()
    for entry in index:
        if entry.get("path") == folder:
            entry["last_used"] = datetime.now().isoformat()
            break
    else:
        index.insert(0, {"path": folder, "last_used": datetime.now().isoformat()})
    path = _folder_index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, indent=2), encoding="utf-8")


def remove_folder_from_index(folder: str) -> None:
    """Retire un dossier de l'index sidebar."""
    index = [e for e in load_folder_index() if e.get("path") != folder]
    path = _folder_index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, indent=2), encoding="utf-8")


# ── Gestion des sessions ──────────────────────────────────────────────────────

def _sessions_dir() -> Path:
    """Répertoire des sessions — suit data_home."""
    d = get_data_home() / "sessions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def delete_folder_sessions(folder_cwd: str) -> int:
    """Supprime tous les JSON de sessions dont le cwd correspond au dossier. Retourne le nombre supprimé."""
    folder_norm = str(Path(folder_cwd)).rstrip("/\\")
    deleted = 0
    for path in _sessions_dir().glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            cwd_norm = str(Path(data.get("cwd", ""))).rstrip("/\\")
            if cwd_norm == folder_norm:
                path.unlink()
                deleted += 1
        except Exception:
            pass
    return deleted


def cleanup_old_sessions(retention_days: int) -> int:
    """Supprime les sessions plus vieilles que retention_days. 0 = indéfiniment (no-op)."""
    if retention_days <= 0:
        return 0
    cutoff = datetime.now() - timedelta(days=retention_days)
    deleted = 0
    for path in _sessions_dir().glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            updated_str = data.get("updated_at", "")
            if updated_str and datetime.fromisoformat(updated_str) < cutoff:
                path.unlink()
                deleted += 1
        except Exception:
            pass
    return deleted


# ── Migration du répertoire de données ───────────────────────────────────────

def migrate_data_dir(new_dir: str) -> tuple[int, list[str]]:
    """
    Déplace les fichiers de sessions vers new_dir/sessions/.
    Met à jour le config avec le nouveau data_dir.
    Retourne (nb_fichiers_déplacés, liste_erreurs).
    """
    new_path = Path(new_dir)
    new_sessions = new_path / "sessions"
    new_sessions.mkdir(parents=True, exist_ok=True)

    moved, errors = 0, []
    for src in _sessions_dir().glob("*.json"):
        dst = new_sessions / src.name
        try:
            shutil.move(str(src), str(dst))
            moved += 1
        except Exception as exc:
            errors.append(f"{src.name}: {exc}")

    # Persiste le nouveau chemin dans la config
    cfg = load_global_config()
    cfg["data_dir"] = str(new_path)
    save_global_config(cfg)

    # Met à jour le module persistence en live
    try:
        from openagenticskyzer.context.persistence import set_data_dir
        set_data_dir(str(new_path))
    except Exception:
        pass

    return moved, errors
