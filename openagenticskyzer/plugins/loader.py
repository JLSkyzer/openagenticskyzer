"""Load user Python plugins from global and project tool directories."""
from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path


def _plugin_dirs(folder: str | None) -> list[Path]:
    candidates = [Path.home() / ".openagent" / "tools"]
    if folder:
        project = Path(folder)
        candidates.extend([project / "tools", project / ".openagent" / "tools"])
    return [path for path in candidates if path.is_dir()]


def load_plugins(folder: str | None = None) -> tuple[list, list[str]]:
    """Return valid plugin tools and isolated load errors."""
    tools: list = []
    errors: list[str] = []
    seen: set[Path] = set()
    for plugin_dir in _plugin_dirs(folder):
        try:
            files = sorted(plugin_dir.glob("*.py"))
        except OSError as exc:
            errors.append(f"{plugin_dir}: {exc}")
            continue
        for py_file in files:
            resolved = py_file.resolve()
            if resolved in seen or py_file.name == "__init__.py":
                continue
            seen.add(resolved)
            module_name = "openagent_plugin_" + hashlib.sha256(str(resolved).encode()).hexdigest()[:16]
            try:
                spec = importlib.util.spec_from_file_location(module_name, py_file)
                if spec is None or spec.loader is None:
                    raise ImportError("module spec unavailable")
                module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
                get_tools = getattr(module, "get_tools", None)
                if not callable(get_tools):
                    raise ValueError("pas de fonction get_tools()")
                loaded = get_tools()
                if not isinstance(loaded, (list, tuple)):
                    raise TypeError("get_tools() doit retourner une liste")
                if any(not getattr(tool, "name", None) or not callable(getattr(tool, "invoke", None)) for tool in loaded):
                    raise TypeError("get_tools() contient un outil invalide")
                tools.extend(loaded)
                on_load = getattr(module, "on_load", None)
                if callable(on_load):
                    on_load(folder)
            except Exception as exc:
                errors.append(f"{py_file.name}: {exc}")
    return tools, errors

