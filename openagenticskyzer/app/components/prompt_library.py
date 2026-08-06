"""Popup bibliothèque de prompts — ouvert avec le bouton ✦ ou en tapant /."""
from nicegui import ui
from openagenticskyzer.app.state import state
from openagenticskyzer.app.storage import load_prompts


def render_prompt_picker(input_el):
    """Bouton ✦ qui ouvre la picker. input_el = textarea de l'input bar.

    Retourne (button, open_picker) : `open_picker` est `dlg.open` (méthode liée
    du dialog créé ici), à utiliser par l'appelant (ex. `input_bar.py` sur la
    détection de `/`) pour ouvrir la picker depuis l'extérieur de cette fonction
    — le dialog `dlg` lui-même reste une variable locale à cette closure, il n'y
    a donc pas d'autre moyen de le déclencher depuis un autre module.
    """

    def _apply(template: str):
        dlg.close()
        folder_name = (state.active_folder or "").replace("\\", "/").split("/")[-1] or "projet"
        filled = template.replace("{filename}", folder_name)
        input_el.set_value(filled)
        input_el.run_method("focus")

    def _filter(query: str, items_col):
        items_col.clear()
        q = (query or "").lower()
        prompts = [p for p in load_prompts() if q in p["name"].lower() or q in p.get("description", "").lower()]
        with items_col:
            for p in prompts:
                with ui.row().classes(
                    "w-full items-center px-2 py-1 hover:bg-gray-800 rounded cursor-pointer gap-2"
                ).on("click", lambda tmpl=p["template"]: _apply(tmpl)):
                    ui.label(p.get("icon", "📝")).classes("text-base")
                    with ui.column().classes("flex-1"):
                        ui.label(p["name"]).classes("text-xs text-gray-200 font-medium")
                        ui.label(p.get("description", "")).classes("text-xs text-gray-500")

    with ui.dialog() as dlg:
        dlg.props("persistent")
        with ui.card().classes("bg-gray-900 border border-gray-700 w-96"):
            search_el = ui.input(placeholder="Filtrer…").classes("w-full mb-2")
            items_col = ui.column().classes("w-full gap-1 max-h-80 overflow-y-auto")
            search_el.on("update:model-value", lambda e: _filter(e.args, items_col))
            _filter("", items_col)

    button = ui.button("✦", on_click=dlg.open).classes(
        "w-8 h-10 bg-gray-900 border border-gray-800 text-purple-400 "
        "hover:text-purple-300 rounded-lg flex-shrink-0 text-sm"
    )
    return button, dlg.open
