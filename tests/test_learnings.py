# tests/test_learnings.py
"""Tests du système d'apprentissage adaptatif (learnings.jsonl, projet + global)."""
import json
import pytest
from pathlib import Path
from openagenticskyzer.context.learnings import (
    Learning, new_learning, save_learning, load_learnings, delete_learning,
    format_learnings_for_injection,
)


class TestNewLearning:
    def test_creates_learning_with_required_fields(self):
        l = new_learning("error", "contexte test", "bad approach", "good approach",
                          tags=["python"], project_folder="/tmp/proj")
        assert l.type == "error"
        assert l.mistake == "bad approach"
        assert l.correction == "good approach"
        assert "python" in l.tags
        assert l.id != ""
        assert not l.confirmed
        assert not l.contributed
        assert l.source == "auto"

    def test_truncates_long_fields(self):
        l = new_learning("correction", "ctx", "x" * 600, "y" * 600)
        assert len(l.mistake) <= 500
        assert len(l.correction) <= 500

    def test_truncates_context_summary(self):
        l = new_learning("discovery", "c" * 300, "bad", "good")
        assert len(l.context_summary) <= 200

    def test_project_hash_set_when_project_folder_given(self):
        l = new_learning("error", "ctx", "bad", "good", project_folder="/tmp/proj")
        assert l.project_hash is not None
        assert len(l.project_hash) == 8

    def test_project_hash_none_when_no_project_folder(self):
        l = new_learning("error", "ctx", "bad", "good")
        assert l.project_hash is None

    def test_tags_default_empty_list(self):
        l = new_learning("error", "ctx", "bad", "good")
        assert l.tags == []

    def test_timestamp_is_iso_format(self):
        l = new_learning("error", "ctx", "bad", "good")
        # doit être parseable comme ISO 8601
        from datetime import datetime
        datetime.fromisoformat(l.timestamp)


class TestSaveAndLoad:
    def test_save_and_load_roundtrip(self, tmp_path):
        l = new_learning("error", "test ctx", "bad", "good")
        l.confirmed = True
        save_learning(l, project_folder=str(tmp_path))
        loaded = load_learnings(project_folder=str(tmp_path), confirmed_only=True)
        assert len(loaded) == 1
        assert loaded[0].mistake == "bad"

    def test_load_confirmed_only_filters(self, tmp_path):
        l1 = new_learning("error", "ctx", "bad1", "good1")
        l1.confirmed = False
        l2 = new_learning("correction", "ctx", "bad2", "good2")
        l2.confirmed = True
        save_learning(l1, project_folder=str(tmp_path))
        save_learning(l2, project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=True)
        assert len(result) == 1
        assert result[0].correction == "good2"

    def test_load_confirmed_only_false_returns_all(self, tmp_path):
        l1 = new_learning("error", "ctx", "bad1", "good1")
        l1.confirmed = False
        l2 = new_learning("correction", "ctx", "bad2", "good2")
        l2.confirmed = True
        save_learning(l1, project_folder=str(tmp_path))
        save_learning(l2, project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=False)
        assert len(result) == 2

    def test_load_empty_when_no_file(self, tmp_path):
        result = load_learnings(project_folder=str(tmp_path))
        assert result == []

    def test_save_creates_parent_directory(self, tmp_path):
        l = new_learning("error", "ctx", "bad", "good")
        folder = str(tmp_path / "nouveau_projet")
        save_learning(l, project_folder=folder)
        path = Path(folder) / ".openagent" / "learnings.jsonl"
        assert path.exists()

    def test_save_appends_not_overwrites(self, tmp_path):
        l1 = new_learning("error", "ctx1", "bad1", "good1")
        l1.confirmed = True
        l2 = new_learning("error", "ctx2", "bad2", "good2")
        l2.confirmed = True
        save_learning(l1, project_folder=str(tmp_path))
        save_learning(l2, project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=True)
        assert len(result) == 2

    def test_delete_learning(self, tmp_path):
        l = new_learning("error", "ctx", "bad", "good")
        l.confirmed = True
        save_learning(l, project_folder=str(tmp_path))
        delete_learning(l.id, project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=False)
        assert len(result) == 0

    def test_delete_keeps_other_learnings(self, tmp_path):
        l1 = new_learning("error", "ctx1", "bad1", "good1")
        l1.confirmed = True
        l2 = new_learning("error", "ctx2", "bad2", "good2")
        l2.confirmed = True
        save_learning(l1, project_folder=str(tmp_path))
        save_learning(l2, project_folder=str(tmp_path))
        delete_learning(l1.id, project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=False)
        assert len(result) == 1
        assert result[0].id == l2.id

    def test_delete_nonexistent_id_does_not_raise(self, tmp_path):
        l = new_learning("error", "ctx", "bad", "good")
        l.confirmed = True
        save_learning(l, project_folder=str(tmp_path))
        delete_learning("nonexistent-id", project_folder=str(tmp_path))
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=False)
        assert len(result) == 1

    def test_delete_on_missing_file_does_not_raise(self, tmp_path):
        delete_learning("some-id", project_folder=str(tmp_path))
        assert load_learnings(project_folder=str(tmp_path)) == []

    def test_jsonl_lines_are_newline_terminated(self, tmp_path):
        """Chaque ligne écrite doit se terminer par un simple '\\n', sans
        traduction CRLF Windows (cohérence avec project_memory.py/crud_tools.py)."""
        l = new_learning("error", "ctx", "bad", "good")
        save_learning(l, project_folder=str(tmp_path))
        path = Path(tmp_path) / ".openagent" / "learnings.jsonl"
        raw = path.read_bytes()
        assert b"\r\n" not in raw
        assert raw.endswith(b"\n")


class TestGlobalLearnings:
    """Toute utilisation du store global doit passer par un monkeypatch de
    `_global_learnings_path` — jamais toucher le vrai ~/.openagent/ du poste
    de développement, y compris via un simple appel à load/delete sans
    project_folder (voir tasks/lessons.md pour l'historique de ce bug de
    test-isolation dans le code suggéré par le plan)."""

    def test_save_and_load_global(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "openagenticskyzer.context.learnings._global_learnings_path",
            lambda: tmp_path / "learnings.jsonl",
        )
        l = new_learning("preference", "ctx", "bad", "good")
        l.confirmed = True
        save_learning(l)
        result = load_learnings()
        assert len(result) == 1
        assert result[0].id == l.id

    def test_load_merges_project_and_global_dedupe_by_id(self, tmp_path, monkeypatch):
        global_path = tmp_path / "global" / "learnings.jsonl"
        monkeypatch.setattr(
            "openagenticskyzer.context.learnings._global_learnings_path",
            lambda: global_path,
        )
        project_dir = tmp_path / "proj"
        l_global = new_learning("preference", "ctx", "global bad", "global good")
        l_global.confirmed = True
        l_project = new_learning("error", "ctx", "project bad", "project good")
        l_project.confirmed = True
        save_learning(l_global)
        save_learning(l_project, project_folder=str(project_dir))

        result = load_learnings(project_folder=str(project_dir), confirmed_only=True)
        ids = {r.id for r in result}
        assert l_global.id in ids
        assert l_project.id in ids
        assert len(result) == 2

    def test_unconfirmed_id_collision_does_not_hide_confirmed_copy(self, tmp_path, monkeypatch):
        """Régression : si le fichier projet (lu en premier) contient une
        copie NON confirmée d'un id, et que le fichier global contient une
        copie CONFIRMÉE du même id, la copie confirmée doit quand même
        apparaître dans le résultat filtré par confirmed_only=True.

        L'ancienne implémentation marquait l'id comme "vu" dès la première
        rencontre, indépendamment du filtre confirmed_only — la copie
        non confirmée du projet aurait donc masqué la copie confirmée du
        global, faisant disparaître silencieusement un vrai learning
        confirmé. Pas encore atteignable en pratique (aucun outil n'écrit
        de collisions d'id aujourd'hui), mais le champ `contributed` laisse
        présager un futur flux de promotion projet→global qui produirait
        exactement ce scénario."""
        global_path = tmp_path / "global" / "learnings.jsonl"
        monkeypatch.setattr(
            "openagenticskyzer.context.learnings._global_learnings_path",
            lambda: global_path,
        )
        project_dir = tmp_path / "proj"

        unconfirmed = new_learning("error", "ctx", "bad project copy", "good project copy")
        unconfirmed.confirmed = False
        confirmed = new_learning("error", "ctx", "bad global copy", "good global copy")
        confirmed.confirmed = True
        confirmed.id = unconfirmed.id  # force la collision d'id entre les deux portées

        save_learning(unconfirmed, project_folder=str(project_dir))
        save_learning(confirmed)  # portée globale

        result = load_learnings(project_folder=str(project_dir), confirmed_only=True)
        assert len(result) == 1
        assert result[0].id == confirmed.id
        assert result[0].mistake == "bad global copy"

    def test_delete_removes_from_global_when_no_project_folder(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "openagenticskyzer.context.learnings._global_learnings_path",
            lambda: tmp_path / "learnings.jsonl",
        )
        l = new_learning("preference", "ctx", "bad", "good")
        l.confirmed = True
        save_learning(l)
        delete_learning(l.id)
        assert load_learnings() == []

    def test_delete_removes_from_both_project_and_global(self, tmp_path, monkeypatch):
        global_path = tmp_path / "global" / "learnings.jsonl"
        monkeypatch.setattr(
            "openagenticskyzer.context.learnings._global_learnings_path",
            lambda: global_path,
        )
        project_dir = tmp_path / "proj"
        l = new_learning("preference", "ctx", "bad", "good")
        l.confirmed = True
        # Simule le même id présent dans les deux fichiers (cas limite mais
        # doit être géré proprement sans planter).
        save_learning(l)
        save_learning(l, project_folder=str(project_dir))

        delete_learning(l.id, project_folder=str(project_dir))

        assert load_learnings(project_folder=str(project_dir), confirmed_only=False) == []

    def test_load_never_touches_real_home_without_monkeypatch(self, tmp_path, monkeypatch):
        """Vérifie explicitement l'isolation : en pointant Path.home() vers un
        dossier vide temporaire (sans monkeypatcher _global_learnings_path),
        load_learnings ne doit lever aucune exception et retourner [].

        Cette seule assertion ne suffit pas à prouver que le patch est
        réellement pris en compte — un poste de dev réel n'a presque
        certainement pas de learnings confirmés dans son vrai
        ~/.openagent/learnings.jsonl, donc [] serait retourné même SANS
        patch effectif. On complète donc par une assertion positive : un
        learning sentinelle écrit sous le home patché doit être relu, ce qui
        ne peut réussir que si _global_learnings_path() résout bien vers
        Path.home() (patché) et non vers le vrai home de la machine."""
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        result = load_learnings(project_folder=str(tmp_path / "proj"))
        assert result == []

        sentinel = new_learning("preference", "ctx", "sentinel bad", "sentinel good")
        sentinel.confirmed = True
        save_learning(sentinel)  # portée globale -> doit atterrir sous tmp_path patché

        on_disk_path = tmp_path / ".openagent" / "learnings.jsonl"
        assert on_disk_path.exists()

        result = load_learnings(project_folder=str(tmp_path / "proj"))
        assert len(result) == 1
        assert result[0].id == sentinel.id


class TestOSErrorDegradation:
    def test_load_returns_empty_list_on_read_error(self, tmp_path, monkeypatch):
        path = tmp_path / ".openagent" / "learnings.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text('{"id": "x"}\n', encoding="utf-8")

        original_read_text = Path.read_text

        def boom(self, *a, **kw):
            if self == path:
                raise PermissionError("locked")
            return original_read_text(self, *a, **kw)

        monkeypatch.setattr(Path, "read_text", boom)
        monkeypatch.setattr(
            "openagenticskyzer.context.learnings._global_learnings_path",
            lambda: tmp_path / "global_missing.jsonl",
        )
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=False)
        assert result == []

    def test_save_does_not_raise_on_write_error(self, tmp_path, monkeypatch):
        l = new_learning("error", "ctx", "bad", "good")

        def boom_mkdir(self, *a, **kw):
            raise PermissionError("locked")

        monkeypatch.setattr(Path, "mkdir", boom_mkdir)
        # Ne doit pas lever, juste échouer silencieusement.
        save_learning(l, project_folder=str(tmp_path / "proj"))

    def test_delete_does_not_raise_on_read_error(self, tmp_path, monkeypatch):
        path = tmp_path / ".openagent" / "learnings.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text('{"id": "x"}\n', encoding="utf-8")

        original_read_text = Path.read_text

        def boom(self, *a, **kw):
            if self == path:
                raise PermissionError("locked")
            return original_read_text(self, *a, **kw)

        monkeypatch.setattr(Path, "read_text", boom)
        monkeypatch.setattr(
            "openagenticskyzer.context.learnings._global_learnings_path",
            lambda: tmp_path / "global_missing.jsonl",
        )
        delete_learning("x", project_folder=str(tmp_path))  # ne doit pas lever

    def test_load_skips_malformed_json_lines(self, tmp_path):
        path = tmp_path / ".openagent" / "learnings.jsonl"
        path.parent.mkdir(parents=True)
        l = new_learning("error", "ctx", "bad", "good")
        l.confirmed = True
        valid_line = json.dumps(l.__dict__, ensure_ascii=False)
        path.write_text(valid_line + "\nnot valid json\n", encoding="utf-8")
        result = load_learnings(project_folder=str(tmp_path), confirmed_only=True)
        assert len(result) == 1
        assert result[0].id == l.id


class TestFormatForInjection:
    def test_empty_returns_empty_string(self):
        assert format_learnings_for_injection([]) == ""

    def test_formats_learnings(self):
        l = new_learning("error", "ctx", "bad approach", "good approach", tags=["git"])
        l.confirmed = True
        result = format_learnings_for_injection([l])
        assert "bad approach" in result
        assert "good approach" in result
        assert "git" in result

    def test_header_and_footer_present(self):
        l = new_learning("error", "ctx", "bad", "good")
        result = format_learnings_for_injection([l])
        assert "LEÇONS APPRISES" in result
        assert "FIN LEÇONS" in result

    def test_max_twenty_learnings(self):
        learnings = [
            new_learning("error", "ctx", f"bad{i}", f"good{i}")
            for i in range(25)
        ]
        result = format_learnings_for_injection(learnings)
        assert "bad19" in result
        assert "bad20" not in result
        assert "bad24" not in result

    def test_no_tags_omits_bracket(self):
        l = new_learning("error", "ctx", "bad", "good", tags=[])
        result = format_learnings_for_injection([l])
        # Pas de crochets vides "[]" traînants sur la ligne "À éviter"
        assert "[]" not in result
