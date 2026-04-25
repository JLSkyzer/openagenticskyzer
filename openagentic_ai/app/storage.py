"""Config and folder index persistence for the GUI app."""
import json
import os
from datetime import datetime
from pathlib import Path


def _openagent_home() -> Path:
    """~/.openagent/ or $OPENAGENT_HOME for tests."""
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


DEFAULT_GLOBAL_CONFIG: dict = {
    "agent_mode": "auto",
    "auto_compact": True,
    "compact_threshold": 70,
    "max_tokens": None,
    "reserved_tokens": 2048,
    "show_context_bar": True,
    "session_retention_days": 30,
    "animations": True,
    "permission_mode": "demander",
    "shell_ask": True,
    "files_ask": False,
    "search_ask": False,
}

DEFAULT_FOLDER_CONFIG: dict = {
    "agent_mode": "inherit",
    "ignored_patterns": "node_modules/, .env, dist/",
    "custom_prompt": "",
    "override_permissions": False,
}


def load_global_config() -> dict:
    path = _global_config_path()
    if not path.exists():
        return DEFAULT_GLOBAL_CONFIG.copy()
    try:
        return {**DEFAULT_GLOBAL_CONFIG, **json.loads(path.read_text())}
    except (json.JSONDecodeError, OSError):
        return DEFAULT_GLOBAL_CONFIG.copy()


def save_global_config(config: dict) -> None:
    path = _global_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2))


def load_folder_config(folder: str) -> dict:
    path = _folder_config_path(folder)
    if not path.exists():
        return DEFAULT_FOLDER_CONFIG.copy()
    try:
        return {**DEFAULT_FOLDER_CONFIG, **json.loads(path.read_text())}
    except (json.JSONDecodeError, OSError):
        return DEFAULT_FOLDER_CONFIG.copy()


def save_folder_config(folder: str, config: dict) -> None:
    path = _folder_config_path(folder)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2))


def load_folder_index() -> list[dict]:
    path = _folder_index_path()
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def add_folder_to_index(folder: str) -> None:
    index = load_folder_index()
    for entry in index:
        if entry["path"] == folder:
            entry["last_used"] = datetime.now().isoformat()
            break
    else:
        index.insert(0, {"path": folder, "last_used": datetime.now().isoformat()})
    path = _folder_index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, indent=2))
