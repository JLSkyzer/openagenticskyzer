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
