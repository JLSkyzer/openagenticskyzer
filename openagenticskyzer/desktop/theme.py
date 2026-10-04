"""Theme helpers for the native Tk desktop interface."""
from __future__ import annotations

from tkinter import ttk

def apply_theme(root, name: str = "dark") -> None:
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass
    dark = name != "light"
    background = "#111318" if dark else "#f4f5f7"
    foreground = "#e8eaf0" if dark else "#172033"
    field = "#0c0e12" if dark else "#ffffff"
    style.configure(".", background=background, foreground=foreground)
    style.configure("TFrame", background=background)
    style.configure("TLabel", background=background, foreground=foreground)
    style.configure("TButton", background="#202530" if dark else "#e6e9ef", foreground=foreground)
    style.configure("TEntry", fieldbackground=field, foreground=foreground)
    root.configure(bg=background)
