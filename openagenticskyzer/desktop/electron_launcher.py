"""Launch the Electron desktop shell from the Python entry point."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

def main() -> None:
    project = Path(__file__).resolve().parents[2]
    electron_dir = project / "electron"
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm and os.name == "nt":
        candidate = Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "nodejs" / "npm.cmd"
        if candidate.exists():
            npm = str(candidate)
    if not npm:
        raise RuntimeError("npm est requis pour l’interface Electron. Installe Node.js LTS puis lance npm install dans electron/.")
    subprocess.run([npm, "start"], cwd=str(electron_dir), check=True)
