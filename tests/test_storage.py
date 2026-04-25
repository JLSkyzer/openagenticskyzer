# tests/test_storage.py
import json
import tempfile
from pathlib import Path
import pytest
from openagentic_ai.app.storage import (
    load_global_config, save_global_config,
    load_folder_config, save_folder_config,
    add_folder_to_index, load_folder_index,
    DEFAULT_GLOBAL_CONFIG, DEFAULT_FOLDER_CONFIG,
)

@pytest.fixture
def tmp_home(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAGENT_HOME", str(tmp_path))
    return tmp_path

def test_global_config_defaults(tmp_home):
    config = load_global_config()
    assert config["agent_mode"] == "auto"
    assert config["auto_compact"] is True
    assert config["permission_mode"] == "demander"

def test_global_config_roundtrip(tmp_home):
    save_global_config({"agent_mode": "plan", "auto_compact": False, "permission_mode": "auto",
                        "compact_threshold": 70, "max_tokens": None, "reserved_tokens": 2048,
                        "show_context_bar": True, "session_retention_days": 30, "animations": True})
    config = load_global_config()
    assert config["agent_mode"] == "plan"
    assert config["auto_compact"] is False

def test_folder_config_defaults(tmp_home, tmp_path):
    folder = tmp_path / "my_project"
    folder.mkdir()
    config = load_folder_config(str(folder))
    assert config["agent_mode"] == "inherit"

def test_folder_config_roundtrip(tmp_home, tmp_path):
    folder = tmp_path / "my_project"
    folder.mkdir()
    data = {"agent_mode": "ask", "ignored_patterns": "dist/", "custom_prompt": "", "override_permissions": False}
    save_folder_config(str(folder), data)
    config = load_folder_config(str(folder))
    assert config["agent_mode"] == "ask"

def test_folder_index(tmp_home, tmp_path):
    folder = str(tmp_path / "proj")
    add_folder_to_index(folder)
    index = load_folder_index()
    assert any(f["path"] == folder for f in index)

def test_folder_index_no_duplicates(tmp_home, tmp_path):
    folder = str(tmp_path / "proj")
    add_folder_to_index(folder)
    add_folder_to_index(folder)
    index = load_folder_index()
    assert sum(1 for f in index if f["path"] == folder) == 1
