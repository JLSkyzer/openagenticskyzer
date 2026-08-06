"""Panneau de preview d'artifact (HTML, SVG, Mermaid)."""
import html as _html
import re as _re

from nicegui import ui

from openagenticskyzer.app.state import state

_ARTIFACT_RE = _re.compile(
    r"```(html|svg|mermaid|markdown)\n(.*?)```",
    _re.DOTALL | _re.IGNORECASE,
)


def _extract_artifact(text: str) -> tuple[str, str] | None:
    """Retourne (type, content) ou None."""
    m = _ARTIFACT_RE.search(text)
    if m:
        return m.group(1).lower(), m.group(2).strip()
    return None


def _build_iframe_html(content: str) -> str:
    """Construit le tag <iframe srcdoc="..."> pour prévisualiser un artifact
    HTML. Fonction pure — extraite de `artifact_panel()` pour être testable
    sans harnais NiceGUI (voir `tests/test_artifacts.py`).

    Le contenu est échappé avec `html.escape(..., quote=True)`, l'échappement
    HTML standard, pas un échappement de chaîne JavaScript : `ui.html(...)`
    rend du HTML brut, pas du JS, donc un template literal entre backticks
    (`srcdoc=\\`...\\``) n'est pas une syntaxe d'attribut HTML valide, et
    échapper seulement `\\` et `` ` `` ne protège en rien contre un `"` ou un
    `<` du contenu généré par l'IA qui casserait l'attribut ou serait
    interprété comme du markup par la page englobante. `html.escape` neutralise
    `"`, `<`, `>` et `&`, qui redeviennent leur caractère d'origine une fois
    décodés par le navigateur au moment où il parse le document `srcdoc` dans
    l'iframe (c'est le fonctionnement standard de `srcdoc`, pas un contournement).
    """
    escaped = _html.escape(content, quote=True)
    return (
        '<iframe '
        'style="width:100%;height:500px;border:none;background:white;border-radius:8px" '
        f'srcdoc="{escaped}" '
        'sandbox="allow-scripts allow-same-origin">'
        '</iframe>'
    )


@ui.refreshable
def artifact_panel():
    if not state.show_artifact or not state.artifact_content:
        return
    with ui.column().classes("h-full border-l border-gray-800 bg-gray-950").style("width:400px;flex-shrink:0"):
        with ui.row().classes("items-center px-3 py-2 border-b border-gray-800 gap-2"):
            ui.label(f"Preview — {state.artifact_type.upper()}").classes("text-xs text-gray-400 flex-1")
            ui.button("✕", on_click=_close_artifact).classes(
                "w-6 h-6 bg-transparent text-gray-500 hover:text-white text-xs"
            )
        with ui.scroll_area().classes("flex-1 w-full"):
            if state.artifact_type == "html":
                ui.html(_build_iframe_html(state.artifact_content))
            elif state.artifact_type == "svg":
                ui.html(f'<div style="padding:16px">{state.artifact_content}</div>')
            elif state.artifact_type == "mermaid":
                ui.html(f"""
                <div class="mermaid" style="padding:16px;background:#1e1e2e;border-radius:8px">
                {state.artifact_content}
                </div>
                """)
                ui.run_javascript("mermaid.init(undefined, document.querySelectorAll('.mermaid:not([data-processed])'))")
            elif state.artifact_type == "markdown":
                ui.markdown(state.artifact_content)


def _close_artifact():
    state.artifact_type = ""
    state.artifact_content = ""
    state.show_artifact = False
    artifact_panel.refresh()
