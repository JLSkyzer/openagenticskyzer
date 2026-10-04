"""JSON-lines backend used by the Electron renderer."""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

from openagenticskyzer.app.storage import load_chat_history, load_folder_index, save_chat_history
from openagenticskyzer.desktop.project_settings import load_project_settings, save_project_settings

_stop = threading.Event()
_active: dict[str, object] = {}

def _send(message: dict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _folders() -> list[dict]:
    return [{"path": item.get("path", ""), "name": Path(item.get("path", "")).name or item.get("path", "")} for item in load_folder_index() if item.get("path")]

def _handle(request: dict) -> object:
    op = request.get("op")
    if op == "list_folders":
        return _folders()
    if op == "activate_folder":
        folder = str(request.get("folder", ""))
        if not folder or not Path(folder).is_dir():
            raise ValueError("Dossier introuvable")
        _active["folder"] = folder
        history = load_chat_history(folder)
        return {"folder": folder, "history": history}
    if op == "settings":
        return load_project_settings(request.get("folder"))
    if op == "save_settings":
        folder = request.get("folder")
        if not folder:
            raise ValueError("Aucun projet actif")
        save_project_settings(folder, dict(request.get("settings") or {}))
        return load_project_settings(folder)
    if op == "stop":
        _stop.set(); return {"stopped": True}
    if op == "send":
        folder = request.get("folder") or os.getcwd()
        text = str(request.get("text", "")).strip()
        if not text:
            raise ValueError("Message vide")
        _stop.clear()
        from openagenticskyzer.agent import build_agent
        history = load_chat_history(folder) if Path(folder).is_dir() else []
        agent = build_agent(folder_cwd=folder)
        result = agent.invoke({"messages": history + [{"role": "user", "content": text}]})
        messages = result.get("messages", [])
        content = getattr(messages[-1], "content", "") if messages else ""
        if Path(folder).is_dir():
            save_chat_history(folder, history + [{"role": "user", "content": text}, {"role": "ai", "content": content}])
        return {"content": content}
    raise ValueError(f"Opération inconnue : {op}")

def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = _handle(request)
            _send({"type": "response", "id": request.get("id"), "ok": True, "result": result})
        except Exception as exc:
            _send({"type": "response", "id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(exc)})

if __name__ == "__main__":
    main()
