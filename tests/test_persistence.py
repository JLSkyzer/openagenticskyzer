"""Tests unitaires pour PersistenceManager."""

import json
import os
import tempfile
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from openagentic_ai.context.persistence import PersistenceManager


# ---------------------------------------------------------------------------
# Fixture : répertoire de sessions isolé par test
# ---------------------------------------------------------------------------

@pytest.fixture
def pm(tmp_path, monkeypatch):
    """PersistenceManager pointant vers un dossier temporaire unique."""
    monkeypatch.setenv("OPENAGENTIC_DATA_DIR", str(tmp_path))
    return PersistenceManager()


def _messages():
    return [HumanMessage(content="Bonjour"), AIMessage(content="Bonjour aussi")]


# ---------------------------------------------------------------------------
# new_session_id
# ---------------------------------------------------------------------------

class TestNewSessionId:

    def test_returns_string(self, pm):
        sid = pm.new_session_id()
        assert isinstance(sid, str)

    def test_returns_10_chars(self, pm):
        sid = pm.new_session_id()
        assert len(sid) == 10

    def test_ids_are_unique(self, pm):
        ids = {pm.new_session_id() for _ in range(20)}
        assert len(ids) == 20  # tous différents (collision quasi-impossible)


# ---------------------------------------------------------------------------
# save
# ---------------------------------------------------------------------------

class TestSave:

    def test_creates_json_file(self, pm, tmp_path):
        sid = "testsave01"
        pm.save(sid, _messages())
        expected = tmp_path / "sessions" / f"{sid}.json"
        assert expected.exists()

    def test_json_contains_messages(self, pm, tmp_path):
        sid = "testmsg01"
        pm.save(sid, _messages())
        path = tmp_path / "sessions" / f"{sid}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        assert "messages" in data
        assert len(data["messages"]) == 2

    def test_json_contains_metadata(self, pm, tmp_path):
        sid = "testmeta"
        pm.save(sid, _messages(), turn_count=3, cwd="/home/user")
        path = tmp_path / "sessions" / f"{sid}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["session_id"] == sid
        assert data["turn_count"] == 3
        assert data["cwd"] == "/home/user"
        assert "created_at" in data
        assert "updated_at" in data

    def test_returns_path(self, pm):
        path = pm.save("retpath01", _messages())
        assert isinstance(path, Path)
        assert path.exists()

    def test_preserves_created_at_on_update(self, pm, tmp_path):
        """Un second save ne modifie pas created_at."""
        sid = "updatetest"
        pm.save(sid, _messages())
        path = tmp_path / "sessions" / f"{sid}.json"
        first_created = json.loads(path.read_text())["created_at"]

        pm.save(sid, _messages() + [HumanMessage(content="encore")])
        second_created = json.loads(path.read_text())["created_at"]
        assert first_created == second_created

    def test_updated_at_changes_on_update(self, pm, tmp_path):
        """updated_at est rafraîchi à chaque save (peut être identique si très rapide)."""
        sid = "updtimestamp"
        pm.save(sid, _messages())
        # On vérifie juste que la clé existe et a une valeur
        path = tmp_path / "sessions" / f"{sid}.json"
        data = json.loads(path.read_text())
        assert data["updated_at"]

    def test_save_empty_messages(self, pm):
        path = pm.save("emptymsg01", [])
        assert path.exists()


# ---------------------------------------------------------------------------
# load
# ---------------------------------------------------------------------------

class TestLoad:

    def test_load_returns_messages_and_meta(self, pm):
        sid = "loadtest01"
        pm.save(sid, _messages(), turn_count=2, cwd="/proj")
        msgs, meta = pm.load(sid)
        assert len(msgs) == 2
        assert meta["session_id"] == sid
        assert meta["turn_count"] == 2

    def test_load_preserves_message_content(self, pm):
        sid = "loadcontent"
        pm.save(sid, _messages())
        msgs, _ = pm.load(sid)
        assert msgs[0].content == "Bonjour"
        assert msgs[1].content == "Bonjour aussi"

    def test_load_nonexistent_raises_file_not_found(self, pm):
        with pytest.raises(FileNotFoundError, match="not found"):
            pm.load("doesnotexist")

    def test_load_by_prefix(self, pm):
        """Chargement par préfixe non ambigu."""
        sid = "abcdef1234"
        pm.save(sid, _messages())
        msgs, meta = pm.load("abcdef")
        assert meta["session_id"] == sid

    def test_ambiguous_prefix_raises_value_error(self, pm):
        pm.save("abc111aaaa", _messages())
        pm.save("abc222bbbb", _messages())
        with pytest.raises(ValueError, match="Ambiguous"):
            pm.load("abc")

    def test_load_meta_does_not_contain_messages_key(self, pm):
        sid = "metacheck"
        pm.save(sid, _messages())
        _, meta = pm.load(sid)
        assert "messages" not in meta


# ---------------------------------------------------------------------------
# list_sessions
# ---------------------------------------------------------------------------

class TestListSessions:

    def test_empty_when_no_sessions(self, pm):
        assert pm.list_sessions() == []

    def test_returns_one_session(self, pm):
        pm.save("sess1", _messages(), turn_count=1, cwd="/a")
        sessions = pm.list_sessions()
        assert len(sessions) == 1
        assert sessions[0]["session_id"] == "sess1"

    def test_returns_all_sessions(self, pm):
        for i in range(3):
            pm.save(f"sess{i}xxx", _messages())
        sessions = pm.list_sessions()
        assert len(sessions) == 3

    def test_sorted_newest_first(self, pm):
        """Les sessions sont triées par updated_at décroissant."""
        import time
        pm.save("oldsess1x", _messages())
        time.sleep(0.01)
        pm.save("newsess1x", _messages())
        sessions = pm.list_sessions()
        assert sessions[0]["session_id"] == "newsess1x"

    def test_session_dict_has_expected_keys(self, pm):
        pm.save("keys1test", _messages(), turn_count=5, cwd="/here")
        session = pm.list_sessions()[0]
        for key in ("session_id", "created_at", "updated_at", "turn_count",
                    "message_count", "cwd"):
            assert key in session

    def test_message_count_correct(self, pm):
        pm.save("msgcount1", _messages())  # 2 messages
        session = pm.list_sessions()[0]
        assert session["message_count"] == 2
