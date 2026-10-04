"""Entry point for the native Tkinter application."""
from __future__ import annotations

from openagenticskyzer.desktop.theme import apply_theme
from openagenticskyzer.desktop.window import MainWindow

def run() -> int:
    window = MainWindow()
    apply_theme(window, "dark")
    window.mainloop()
    return 0

def main() -> None:
    raise SystemExit(run())

if __name__ == "__main__":
    main()
