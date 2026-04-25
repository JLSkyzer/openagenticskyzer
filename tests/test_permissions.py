# tests/test_permissions.py
import sys
from unittest.mock import MagicMock, patch
from openagentic_ai.permissions import PermissionManager, make_permission_tool_node

def test_auto_mode_always_allows():
    mgr = PermissionManager(mode="auto")
    assert mgr.check("run_command", {"command": "rm -rf /"}) is True

def test_strict_mode_blocks_restricted_tools():
    mgr = PermissionManager(mode="strict")
    assert mgr.check("run_command", {}) is False
    assert mgr.check("delete_file", {}) is False
    assert mgr.check("edit_file", {}) is False

def test_strict_mode_allows_read_tools():
    mgr = PermissionManager(mode="strict")
    assert mgr.check("read_file", {}) is True
    assert mgr.check("view_file", {}) is True
    assert mgr.check("glob_files", {}) is True

def test_always_allow_skips_prompt():
    mgr = PermissionManager(mode="demander")
    mgr._always_allow.add("run_command")
    mgr._cli_callback = MagicMock()
    result = mgr.check("run_command", {"command": "ls"})
    assert result is True
    mgr._cli_callback.assert_not_called()

def test_cli_demander_allows_on_y(monkeypatch):
    mgr = PermissionManager(mode="demander", is_cli=True)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    with patch("builtins.input", return_value="y"):
        result = mgr.check("run_command", {"command": "ls"})
    assert result is True

def test_cli_demander_denies_on_n(monkeypatch):
    mgr = PermissionManager(mode="demander", is_cli=True)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    with patch("builtins.input", return_value="n"):
        result = mgr.check("run_command", {"command": "rm file"})
    assert result is False

def test_cli_non_tty_auto_allows(monkeypatch):
    mgr = PermissionManager(mode="demander", is_cli=True)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    result = mgr.check("run_command", {"command": "ls"})
    assert result is True

def test_make_permission_tool_node_returns_callable():
    from unittest.mock import MagicMock
    from langchain_core.tools import tool

    @tool
    def dummy_tool(x: str) -> str:
        """A dummy tool."""
        return f"done: {x}"

    mgr = PermissionManager(mode="auto")
    node = make_permission_tool_node([dummy_tool], mgr)
    assert callable(node)
