"""Tests extraction d'artifacts et export de conversation."""
import pytest


def test_extract_html_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "Voici le résultat :\n```html\n<h1>Hello</h1>\n```"
    result = _extract_artifact(text)
    assert result is not None
    kind, content = result
    assert kind == "html"
    assert "<h1>Hello</h1>" in content


def test_extract_mermaid_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "Diagramme :\n```mermaid\ngraph TD\nA --> B\n```"
    result = _extract_artifact(text)
    assert result is not None
    assert result[0] == "mermaid"


def test_no_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "Voici du code Python :\n```python\nprint('hello')\n```"
    assert _extract_artifact(text) is None


def test_extract_svg_artifact():
    from openagenticskyzer.app.components.artifact_panel import _extract_artifact
    text = "```svg\n<svg><circle r='5'/></svg>\n```"
    result = _extract_artifact(text)
    assert result[0] == "svg"


# --- Tests supplémentaires : sécurité de l'échappement du srcdoc de l'iframe HTML ---
#
# Le plan suggérait de construire l'attribut `srcdoc` comme un template literal
# JavaScript (backticks) alors que `ui.html(...)` produit du HTML brut, pas du JS
# — les backticks ne sont pas des guillemets HTML valides, et l'échappement suggéré
# (`.replace("\\", "\\\\").replace("`", "\\`")`) est de l'échappement de chaîne JS,
# qui ne protège pas contre `"` ou `<` cassant l'attribut HTML environnant. Corrigé
# via `_build_iframe_html`, qui utilise `html.escape(..., quote=True)` (échappement
# HTML réel) et un attribut `srcdoc="..."` entre guillemets doubles standards.

def test_build_iframe_html_escapes_double_quotes():
    from openagenticskyzer.app.components.artifact_panel import _build_iframe_html
    content = 'Voici un guillemet " ici'
    result = _build_iframe_html(content)
    # Le guillemet du contenu ne doit jamais apparaître brut dans le HTML produit :
    # un `"` non échappé casserait l'attribut srcdoc="..." et permettrait d'injecter
    # d'autres attributs/markup dans la page englobante.
    assert 'srcdoc="' in result
    # Extraire ce qui est entre le premier et le dernier guillemet de l'attribut
    # n'est pas trivial à faire proprement ici ; on vérifie plutôt que le guillemet
    # brut du contenu original a bien été remplacé par l'entité HTML.
    assert '&quot;' in result
    # Le contenu ne doit pas contenir de `"` littéral en dehors de ceux utilisés
    # pour délimiter les attributs du <iframe> lui-même.
    assert content not in result


def test_build_iframe_html_escapes_script_tag():
    from openagenticskyzer.app.components.artifact_panel import _build_iframe_html
    content = '<script>alert(1)</script>'
    result = _build_iframe_html(content)
    # Le tag <script> brut ne doit pas apparaître dans le HTML produit — il doit
    # être échappé en &lt;script&gt; à l'intérieur de srcdoc, pour que le navigateur
    # ne l'interprète pas comme faisant partie de la page englobante.
    assert '<script>alert(1)</script>' not in result
    assert '&lt;script&gt;' in result


def test_build_iframe_html_uses_double_quoted_attribute():
    from openagenticskyzer.app.components.artifact_panel import _build_iframe_html
    result = _build_iframe_html("<h1>Hello</h1>")
    # Doit produire un attribut srcdoc="..." valide en HTML, jamais un template
    # literal JS entre backticks (invalide en tant que valeur d'attribut HTML).
    assert 'srcdoc=`' not in result
    assert 'sandbox="allow-scripts"' in result


# --- Tests Task 3 : bibliothèque de prompts (storage.py) ---

def test_load_prompts_returns_defaults():
    from unittest.mock import patch
    from pathlib import Path
    with patch("openagenticskyzer.app.storage._openagent_home", return_value=Path("/nonexistent/path")):
        from openagenticskyzer.app.storage import load_prompts
        prompts = load_prompts()
    assert isinstance(prompts, list)
    assert len(prompts) > 0
    assert all("id" in p and "name" in p and "template" in p for p in prompts)


def test_save_and_load_prompts(tmp_path, monkeypatch):
    import openagenticskyzer.app.storage as storage
    monkeypatch.setattr(storage, "_openagent_home", lambda: tmp_path)
    from openagenticskyzer.app.storage import save_prompts, load_prompts
    custom = [{"id": "test", "name": "Test", "icon": "🔧", "template": "Hello {filename}", "description": "Test template"}]
    save_prompts(custom)
    loaded = load_prompts()
    assert loaded[0]["id"] == "test"


def test_load_prompts_falls_back_on_malformed_shape(tmp_path, monkeypatch):
    # Review follow-up (b8480ec) : un prompts.json valide-en-JSON mais dont les
    # éléments ne sont pas des dicts avec {id, name, template} plantait
    # prompt_library._filter() avec un TypeError dès l'ouverture de la picker
    # (p["name"] sur une chaîne). load_prompts() doit détecter cette forme
    # invalide et retomber sur DEFAULT_PROMPTS, sans jamais lever.
    import json
    import openagenticskyzer.app.storage as storage
    monkeypatch.setattr(storage, "_openagent_home", lambda: tmp_path)
    (tmp_path / "prompts.json").write_text(json.dumps(["not", "a", "dict"]), encoding="utf-8")
    from openagenticskyzer.app.storage import load_prompts, DEFAULT_PROMPTS
    loaded = load_prompts()
    assert loaded == DEFAULT_PROMPTS
    assert all(isinstance(p, dict) and "id" in p and "name" in p and "template" in p for p in loaded)


# --- Tests Task 4 : export de conversation (exporter.py) ---

def test_export_markdown(tmp_path, monkeypatch):
    import openagenticskyzer.app.exporter as exp
    from openagenticskyzer.app.state import state
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "current_model", "llama3")
    monkeypatch.setattr(state, "current_provider", "ollama")

    from openagenticskyzer.app.state import ChatMessage
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Bonjour"),
        ChatMessage(role="ai", content="Salut !"),
    ])

    path = exp.export_markdown()
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "Bonjour" in content
    assert "Salut" in content


def test_export_json(tmp_path, monkeypatch):
    import json
    import openagenticskyzer.app.exporter as exp
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Test"),
    ])

    path = exp.export_json()
    data = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    assert data[0]["role"] == "user"


def test_export_markdown_quotes_every_line_of_multiline_tool_content(tmp_path, monkeypatch):
    # Bug relevé en code-review (voir tasks\lessons.md) : une blockquote Markdown
    # perd sa citation dès la première ligne blanche (pas de continuation
    # paresseuse) — un contenu d'outil multi-lignes sans préfixe "> " sur chaque
    # ligne se retrouvait donc rendu hors citation après la 1re ligne blanche.
    import openagenticskyzer.app.exporter as exp
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "messages", [
        ChatMessage(
            role="tool",
            content="file1.py\nfile2.py\n\nsubdir/\n  a.py",
            tool_tag="read",
            tool_name="list_dir",
        ),
    ])

    path = exp.export_markdown()
    content = path.read_text(encoding="utf-8")
    tool_block = content.split("---\n", 1)[1]
    for line in tool_block.splitlines():
        if line.strip():
            assert line.startswith(">"), f"ligne hors blockquote : {line!r}"
    assert "subdir/" in tool_block
    assert "  a.py" in tool_block


def test_export_html_escapes_code_block_exactly_once(tmp_path, monkeypatch):
    # Bug identifié avant implémentation (voir tasks/lessons.md et tasks/todo.md) :
    # le plan construisait export_html() en échappant tout le message AI une
    # première fois avec html.escape(m.content), PUIS ré-échappait le contenu
    # (déjà échappé) du bloc de code trouvé par regex dans cette chaîne déjà
    # échappée — un `<` du code devenait `&lt;` à la 1re passe puis `&amp;lt;`
    # à la 2e, ce qui s'affiche comme le texte littéral "&lt;" dans le navigateur
    # au lieu d'un `<` décodé. Corrigé en séparant code/non-code sur le texte
    # BRUT avant toute passe d'échappement, pour que chaque segment ne soit
    # échappé qu'une seule fois.
    import openagenticskyzer.app.exporter as exp
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "messages", [
        ChatMessage(
            role="ai",
            content='before\n```python\nx = "<b>"\n```\nafter',
        ),
    ])

    path = exp.export_html()
    content = path.read_text(encoding="utf-8")
    # Le groupe de capture du fence inclut le saut de ligne final avant les
    # ``` de fermeture — d'où le \n avant </code></pre>.
    assert "<pre><code class='language-python'>x = &quot;&lt;b&gt;&quot;\n</code></pre>" in content
    assert "&amp;lt;" not in content
    assert "&amp;quot;" not in content
    assert "&amp;gt;" not in content


# --- Tests supplémentaires : édition de message / régénération (Task 5) ---
#
# `_find_last_user_index` est la seule portion de logique pure de cette
# fonctionnalité — `edit_message`/`regenerate` sont couplés à NiceGUI
# (input_el, _send_message) et ne sont pas testés unitairement, même
# limitation documentée que `_send_message` lui-même (voir l'en-tête de
# tests/test_context_bar.py pour le précédent).


def test_find_last_user_index_finds_most_recent_user_message():
    from openagenticskyzer.app.components.input_bar import _find_last_user_index
    from openagenticskyzer.app.state import ChatMessage
    messages = [
        ChatMessage(role="user", content="Message 1"),
        ChatMessage(role="ai", content="Réponse 1"),
        ChatMessage(role="user", content="Message 2"),
        ChatMessage(role="ai", content="Réponse 2"),
    ]
    assert _find_last_user_index(messages) == 2


def test_find_last_user_index_returns_negative_one_when_no_user_message():
    from openagenticskyzer.app.components.input_bar import _find_last_user_index
    from openagenticskyzer.app.state import ChatMessage
    assert _find_last_user_index([ChatMessage(role="ai", content="x")]) == -1


def test_find_last_user_index_empty_list():
    from openagenticskyzer.app.components.input_bar import _find_last_user_index
    assert _find_last_user_index([]) == -1


# --- Tests supplémentaires : palette de commandes Ctrl+K (Task 6) ---
#
# `_match_commands` est la seule portion de logique pure de cette
# fonctionnalité. `render_command_palette` et les fonctions d'action
# (`_clear_history`, `_show_memory`, `_export_conversation`, etc.) restent
# non testées unitairement car couplées à NiceGUI (mêmes limitations
# documentées que `_send_message`/`edit_message`/`regenerate` ci-dessus).
# Chaque test appelle réellement `_match_commands` — aucun ne duplique la
# logique de filtrage pour vérifier sa propre copie.

def test_match_commands_empty_query_returns_all():
    from openagenticskyzer.app.components.command_palette import _match_commands
    commands = [
        ("Alpha", "desc a", None),
        ("Beta", "desc b", None),
        ("Gamma", "desc g", None),
    ]
    result = _match_commands(commands, "")
    assert result == commands


def test_match_commands_case_insensitive_label_match():
    from openagenticskyzer.app.components.command_palette import _match_commands
    commands = [
        ("Ouvrir un dossier", "Sélectionner un projet", None),
        ("Paramètres", "Ouvrir les paramètres", None),
    ]
    result = _match_commands(commands, "OUVRIR")
    labels = [c[0] for c in result]
    assert "Ouvrir un dossier" in labels
    assert "Paramètres" in labels  # match via la description, cf. test suivant


def test_match_commands_matches_on_description_not_only_label():
    from openagenticskyzer.app.components.command_palette import _match_commands
    commands = [
        ("Paramètres", "Ouvrir les paramètres de l'application", None),
        ("Bibliothèque de prompts", "Ouvrir la bibliothèque de prompts", None),
    ]
    result = _match_commands(commands, "application")
    assert len(result) == 1
    assert result[0][0] == "Paramètres"


def test_match_commands_no_match_returns_empty_list():
    from openagenticskyzer.app.components.command_palette import _match_commands
    commands = [("Alpha", "desc a", None), ("Beta", "desc b", None)]
    result = _match_commands(commands, "zzz-inexistant")
    assert result == []


def test_match_commands_caps_at_eight_results():
    from openagenticskyzer.app.components.command_palette import _match_commands
    commands = [(f"Commande {i}", "match", None) for i in range(12)]
    result = _match_commands(commands, "")
    assert len(result) == 8


# --- Tests supplémentaires : branchement de conversation (fork) + sélecteur (Task 7) ---
#
# Le pseudocode du plan avait un bug de perte de données (voir tasks/lessons.md et
# tasks/todo.md, entrée Task 7) : `_fork_from`/`_switch_branch` remplaçaient
# `state.messages` sans jamais sauvegarder son contenu courant nulle part quand on
# était sur "main" — revenir sur "main" après un fork perdait alors silencieusement
# tout le contenu de la branche principale au-delà du point de fork. Corrigé via
# `state.main_messages` (snapshot de "main") + `_snapshot_active_branch()`, appelé
# systématiquement avant toute mutation de `state.current_branch_id`.
#
# Chaque test ci-dessous appelle réellement `_fork_from`/`_switch_branch` importées
# depuis `chat.py` — aucun ne duplique la logique en construisant sa propre copie
# de `ConversationBranch` pour vérifier son propre travail (cf. lessons.md, Task 5 :
# le test suggéré par le plan pour cette fonctionnalité-là était un no-op de ce type).
#
# `chat_messages`/`branch_selector` sont des `@ui.refreshable` — appeler `.refresh()`
# hors d'un contexte NiceGUI actif (aucun client/page ouvert, comme en test) lève un
# `AssertionError` (`core.loop is not None`, voir `nicegui/background_tasks.py`) :
# monkeypatchés en no-op pour chaque test qui exerce un chemin de code où l'un des
# deux est appelé.

def test_fork_from_creates_branch_with_correct_messages_and_switches_view(monkeypatch):
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(chat_mod.chat_messages, "refresh", lambda: None)
    monkeypatch.setattr(chat_mod.branch_selector, "refresh", lambda: None)
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Msg1"),
        ChatMessage(role="ai", content="Rép1"),
        ChatMessage(role="user", content="Msg2"),
    ])
    monkeypatch.setattr(state, "branches", [])
    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "main_messages", [])
    monkeypatch.setattr(state, "agent_running", False)

    # Forker depuis le message index 1 (Rép1) -> conserve les messages [0, 1]
    chat_mod._fork_from(1)

    assert len(state.branches) == 1
    branch = state.branches[0]
    assert len(branch.messages) == 2
    assert branch.messages[0].content == "Msg1"
    assert branch.messages[1].content == "Rép1"
    # La vue courante bascule sur la nouvelle branche
    assert state.current_branch_id == branch.branch_id
    assert len(state.messages) == 2
    # Le contenu de "main" a bien été snapshotté avant d'être remplacé
    assert len(state.main_messages) == 3


def test_switch_branch_back_to_main_restores_all_original_messages(monkeypatch):
    # Test de régression critique sur le bug de perte de données identifié avant
    # implémentation : forker depuis "main" puis revenir sur "main" doit restaurer
    # la TOTALITÉ des messages originaux de main, pas seulement ceux du fork.
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(chat_mod.chat_messages, "refresh", lambda: None)
    monkeypatch.setattr(chat_mod.branch_selector, "refresh", lambda: None)
    original = [
        ChatMessage(role="user", content="Msg1"),
        ChatMessage(role="ai", content="Rép1"),
        ChatMessage(role="user", content="Msg2"),
    ]
    monkeypatch.setattr(state, "messages", list(original))
    monkeypatch.setattr(state, "branches", [])
    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "main_messages", [])
    monkeypatch.setattr(state, "agent_running", False)

    chat_mod._fork_from(1)  # bascule sur une branche à 2 messages
    assert len(state.messages) == 2

    chat_mod._switch_branch("main")

    assert state.current_branch_id == "main"
    assert len(state.messages) == 3
    assert [m.content for m in state.messages] == ["Msg1", "Rép1", "Msg2"]


def test_fork_from_and_switch_branch_are_noop_when_agent_running(monkeypatch):
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(chat_mod.chat_messages, "refresh", lambda: None)
    monkeypatch.setattr(chat_mod.branch_selector, "refresh", lambda: None)
    monkeypatch.setattr(state, "messages", [ChatMessage(role="user", content="Msg1")])
    monkeypatch.setattr(state, "branches", [])
    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "main_messages", [])
    monkeypatch.setattr(state, "agent_running", True)

    chat_mod._fork_from(0)
    assert state.branches == []
    assert len(state.messages) == 1

    chat_mod._switch_branch("main")
    assert state.current_branch_id == "main"
    assert len(state.messages) == 1


def test_switch_branch_unknown_id_does_not_crash_or_change_current_branch(monkeypatch):
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state, ChatMessage, ConversationBranch
    monkeypatch.setattr(chat_mod.chat_messages, "refresh", lambda: None)
    monkeypatch.setattr(chat_mod.branch_selector, "refresh", lambda: None)
    monkeypatch.setattr(state, "messages", [ChatMessage(role="user", content="Msg1")])
    monkeypatch.setattr(state, "branches", [
        ConversationBranch(branch_id="abc123", label="Branche 1", messages=[], created_at="")
    ])
    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "main_messages", [])
    monkeypatch.setattr(state, "agent_running", False)

    chat_mod._switch_branch("does-not-exist")

    assert state.current_branch_id == "main"
    assert len(state.messages) == 1
    assert state.messages[0].content == "Msg1"


# --- Tests supplémentaires : fix du bug Critical trouvé en review qualité sur le
# commit 6ce1a90 (Task 7) — voir tasks/lessons.md et tasks/todo.md pour le diagnostic
# complet. Deux trous distincts corrigés ici :
#
# 1. Aucun des 4 tests ci-dessus n'exerçait la branche `else` de
#    `_snapshot_active_branch` (sauvegarde vers un `ConversationBranch` existant de
#    `state.branches`, PAS vers `state.main_messages`) — tous partaient de
#    `current_branch_id == "main"`. `test_snapshot_saves_non_main_branch_before_forking_away`
#    couvre ce chemin : fork depuis "main" vers la branche A, modification de la
#    conversation SUR la branche A, puis nouveau fork depuis A vers B — vérifie que
#    le contenu à jour de A est bien sauvegardé dans son objet `ConversationBranch`
#    avant d'en partir, pas perdu.
#
# 2. `state.branches`/`state.current_branch_id`/`state.main_messages` n'étaient
#    jamais réinitialisés aux 4 call-sites où `state.messages` est remplacé EN
#    DEHORS du flux fork/switch (`sidebar.activate_folder`, effacement d'historique
#    dans `command_palette.py`/`settings.py`, retrait de dossier dans `settings.py`)
#    — une branche du dossier/contexte précédent pouvait donc être confondue avec le
#    nouveau contenu chargé, avec un risque de mélange silencieux de conversations
#    entre dossiers différents via `_switch_branch("main")`. Corrigé par
#    `reset_branches()`, appelée aux 4 call-sites. `test_reset_branches_clears_branch_state`
#    vérifie directement le contrat de cette fonction.

def test_snapshot_saves_non_main_branch_before_forking_away(monkeypatch):
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(chat_mod.chat_messages, "refresh", lambda: None)
    monkeypatch.setattr(chat_mod.branch_selector, "refresh", lambda: None)
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Msg1"),
        ChatMessage(role="ai", content="Rép1"),
    ])
    monkeypatch.setattr(state, "branches", [])
    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "main_messages", [])
    monkeypatch.setattr(state, "agent_running", False)

    chat_mod._fork_from(1)  # crée la branche A (2 messages), bascule dessus
    branch_a_id = state.current_branch_id

    # La conversation évolue SUR la branche A (pas main) avant un nouveau fork.
    state.messages.append(ChatMessage(role="user", content="Msg2-sur-branche-A"))

    chat_mod._fork_from(2)  # fork depuis la branche A -> branche B

    branch_a = next(b for b in state.branches if b.branch_id == branch_a_id)
    # Le contenu à jour de la branche A (avec le message ajouté) doit avoir été
    # sauvegardé dans son propre objet ConversationBranch au moment de la quitter,
    # pas perdu (chemin `else` de _snapshot_active_branch, jamais exercé par les
    # tests précédents qui partaient tous de current_branch_id == "main").
    assert len(branch_a.messages) == 3
    assert branch_a.messages[-1].content == "Msg2-sur-branche-A"


def test_reset_branches_clears_branch_state(monkeypatch):
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state, ChatMessage
    monkeypatch.setattr(chat_mod.chat_messages, "refresh", lambda: None)
    monkeypatch.setattr(chat_mod.branch_selector, "refresh", lambda: None)
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Msg1"),
        ChatMessage(role="ai", content="Rép1"),
    ])
    monkeypatch.setattr(state, "branches", [])
    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "main_messages", [])
    monkeypatch.setattr(state, "agent_running", False)

    chat_mod._fork_from(1)
    assert state.branches != []
    assert state.current_branch_id != "main"

    # Simule ce que font maintenant activate_folder/_clear_history/etc. après
    # avoir remplacé state.messages par le contenu d'un autre dossier/contexte.
    chat_mod.reset_branches()

    assert state.branches == []
    assert state.current_branch_id == "main"
    assert state.main_messages == []


# ── Régression : la persistance disque ne doit jamais écraser main avec une
# branche ─────────────────────────────────────────────────────────────────
#
# Bug Critical trouvé en audit holistique (voir tasks/lessons.md, entrée du
# 2026-08-07 "branch persistence") : save_chat_history(folder, state.messages)
# était appelée sans condition dans _send_message (input_bar.py), après CHAQUE
# tour de conversation — y compris quand state.current_branch_id pointe vers
# une branche, auquel cas state.messages ne contient que le sous-ensemble de
# main jusqu'au point de fork + les nouveaux messages de la branche. Ça
# écrasait silencieusement chat_history.json avec ce contenu partiel, perdant
# définitivement tout ce qui suit le point de fork sur main.
#
# _send_message elle-même n'est pas raisonnablement testable en isolation
# (fortement couplée à NiceGUI/LLM — même constat déjà documenté dans
# tests/test_context_bar.py pour trigger_compact), donc le fix extrait la
# logique de garde dans _save_main_chat_history() (input_bar.py), appelée
# par _send_message. Les tests ci-dessous appellent cette fonction réelle,
# pas une réplique de sa logique.
def test_save_main_chat_history_persists_when_on_main(tmp_path, monkeypatch):
    from openagenticskyzer.app.components import input_bar as input_bar_mod
    from openagenticskyzer.app.state import state, ChatMessage

    calls = []
    monkeypatch.setattr(
        "openagenticskyzer.app.storage.save_chat_history",
        lambda folder, messages: calls.append((folder, messages)),
    )
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Msg1"),
        ChatMessage(role="ai", content="Rép1"),
    ])

    input_bar_mod._save_main_chat_history()

    assert len(calls) == 1
    folder, messages = calls[0]
    assert folder == str(tmp_path)
    assert messages == state.messages


def test_save_main_chat_history_is_noop_when_on_branch(tmp_path, monkeypatch):
    """Reproduit le scénario du bug : state.messages contient la vue tronquée
    d'une branche (main jusqu'au fork + nouveaux messages de la branche) —
    la sauvegarde disque doit être un no-op, pour ne jamais écraser
    chat_history.json (qui représente main) avec ce contenu partiel."""
    from openagenticskyzer.app.components import input_bar as input_bar_mod
    from openagenticskyzer.app.state import state, ChatMessage

    calls = []
    monkeypatch.setattr(
        "openagenticskyzer.app.storage.save_chat_history",
        lambda folder, messages: calls.append((folder, messages)),
    )
    monkeypatch.setattr(state, "active_folder", str(tmp_path))
    monkeypatch.setattr(state, "current_branch_id", "branch-abc123")
    # Vue partielle typique d'une branche : main tronquée au point de fork
    # (Msg1) + un nouveau tour propre à la branche (b_ai).
    monkeypatch.setattr(state, "messages", [
        ChatMessage(role="user", content="Msg1"),
        ChatMessage(role="ai", content="b_ai"),
    ])

    input_bar_mod._save_main_chat_history()

    assert calls == []


def test_active_branch_label_returns_main_marker_when_on_main(monkeypatch):
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state

    monkeypatch.setattr(state, "current_branch_id", "main")
    monkeypatch.setattr(state, "branches", [])

    assert chat_mod.active_branch_label() == "🌿 Main"


def test_active_branch_label_returns_branch_label_when_on_known_branch(monkeypatch):
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state, ConversationBranch

    branch = ConversationBranch(
        branch_id="branch-abc123",
        label="Branche 1",
        messages=[],
        created_at="2026-08-07T00:00:00",
    )
    monkeypatch.setattr(state, "branches", [branch])
    monkeypatch.setattr(state, "current_branch_id", "branch-abc123")

    assert chat_mod.active_branch_label() == "Branche 1"


def test_active_branch_label_falls_back_to_main_marker_for_unknown_branch_id(monkeypatch):
    """Garde défensive : un current_branch_id qui ne correspond à aucune
    branche connue (ne devrait normalement pas arriver) ne doit jamais lever
    d'exception ni afficher un libellé vide — retombe sur le marqueur main."""
    from openagenticskyzer.app.components import chat as chat_mod
    from openagenticskyzer.app.state import state

    monkeypatch.setattr(state, "branches", [])
    monkeypatch.setattr(state, "current_branch_id", "does-not-exist")

    assert chat_mod.active_branch_label() == "🌿 Main"
