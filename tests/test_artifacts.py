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
