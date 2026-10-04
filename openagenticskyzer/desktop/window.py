"""Native desktop UI with the same core workflow as the former web shell."""
from __future__ import annotations

import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk
from pathlib import Path
from queue import Queue, Empty

from openagenticskyzer.app.storage import (
    add_folder_to_index, load_chat_history, load_folder_index, load_global_config,
    save_chat_history, save_global_config, load_mcp_config, save_mcp_config,
)
from openagenticskyzer.desktop.workers import AgentWorker
from openagenticskyzer.desktop.project_settings import load_project_settings, save_project_settings

BG = "#0b0e14"
PANEL = "#111722"
PANEL_2 = "#171e2b"
TEXT = "#edf1f7"
MUTED = "#8792a5"
ACCENT = "#8b5cf6"
BLUE = "#5aa8f0"

class MainWindow(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("openagent")
        self.geometry("1400x900")
        self.minsize(1050, 680)
        self.configure(bg=BG)
        self.active_folder: str | None = None
        self._events: Queue = Queue()
        self._worker: AgentWorker | None = None
        self._history: list[dict] = []
        self._build_styles()
        self._build_ui()
        self._load_last_folder()
        self.after(100, self._poll_events)

    def _build_styles(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background=BG)
        style.configure("Panel.TFrame", background=PANEL)
        style.configure("TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 10))
        style.configure("Muted.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("Title.TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 11, "bold"))
        style.configure("TButton", background=PANEL_2, foreground=TEXT, borderwidth=0, padding=(10, 7), font=("Segoe UI", 9))
        style.map("TButton", background=[("active", "#26334a")])
        style.configure("Accent.TButton", background=ACCENT, foreground="white", padding=(12, 8), font=("Segoe UI", 9, "bold"))
        style.map("Accent.TButton", background=[("active", "#a78bfa")])
        style.configure("TCombobox", fieldbackground=PANEL_2, background=PANEL_2, foreground=TEXT)

    def _build_ui(self) -> None:
        top = tk.Frame(self, bg="#141b28", height=54)
        top.pack(fill="x")
        tk.Label(top, text="◈ openagent", bg="#141b28", fg="#a78bfa", font=("Segoe UI", 14, "bold")).pack(side="left", padx=18, pady=13)
        self.folder_title = tk.Label(top, text="Aucun dossier", bg="#141b28", fg=MUTED, font=("Segoe UI", 10))
        self.folder_title.pack(side="left", padx=12)
        ttk.Button(top, text="⚙", command=self.open_settings).pack(side="right", padx=(0, 10), pady=10)
        ttk.Button(top, text="⬇", command=self.open_export).pack(side="right", padx=(0, 4), pady=10)
        ttk.Button(top, text="⌘", command=self.open_commands).pack(side="right", padx=(0, 4), pady=10)

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True)
        self._build_sidebar(body)
        self._build_chat(body)

    def _build_sidebar(self, parent) -> None:
        sidebar = tk.Frame(parent, bg="#151e2d", width=260)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)
        ttk.Button(sidebar, text="📁  Ouvrir un dossier", command=self.open_folder, style="Accent.TButton").pack(fill="x", padx=14, pady=(16, 7))
        ttk.Button(sidebar, text="⚡  Initialiser le projet", command=self.init_project).pack(fill="x", padx=14, pady=(0, 16))
        tk.Label(sidebar, text="HISTORIQUE DES DOSSIERS", bg="#151e2d", fg=MUTED, font=("Segoe UI", 8, "bold")).pack(anchor="w", padx=16, pady=(0, 7))
        self.folder_list = tk.Listbox(sidebar, height=12, bg="#151e2d", fg=TEXT, selectbackground="#30236d", selectforeground="white", relief="flat", borderwidth=0, highlightthickness=0, activestyle="none", font=("Segoe UI", 9))
        self.folder_list.pack(fill="x", padx=8)
        self.folder_list.bind("<<ListboxSelect>>", self._folder_selected)
        for entry in load_folder_index():
            self.folder_list.insert("end", Path(entry.get("path", "")).name or entry.get("path", ""))
        tk.Label(sidebar, text="📚  BASE DE CONNAISSANCES", bg="#151e2d", fg=TEXT, font=("Segoe UI", 10, "bold")).pack(anchor="w", padx=16, pady=(28, 6))
        self.sources_label = tk.Label(sidebar, text="Aucun document indexé", bg="#151e2d", fg=MUTED, justify="left", anchor="w", wraplength=220, font=("Segoe UI", 9))
        self.sources_label.pack(fill="x", padx=16)
        tk.Label(sidebar, text="Indexation automatique à l’ouverture d’un dossier", bg="#151e2d", fg="#657187", justify="left", wraplength=220, font=("Segoe UI", 8)).pack(anchor="w", padx=16, pady=(10, 0))

    def _build_chat(self, parent) -> None:
        content = tk.Frame(parent, bg=BG)
        content.pack(side="left", fill="both", expand=True)
        self.chat_view = scrolledtext.ScrolledText(content, wrap="word", state="disabled", bg=BG, fg=TEXT, insertbackground=TEXT, selectbackground="#30236d", relief="flat", borderwidth=0, padx=36, pady=28, font=("Segoe UI", 10), spacing3=6)
        self.chat_view.pack(fill="both", expand=True)
        self._render_welcome()
        context = tk.Frame(content, bg="#111722", height=34)
        context.pack(fill="x")
        self.context_label = tk.Label(context, text="◉ Contexte   0%", bg="#111722", fg=MUTED, font=("Segoe UI", 8))
        self.context_label.pack(side="left", padx=18, pady=8)
        self.index_label = tk.Label(context, text="▥ Index : inactif", bg="#111722", fg=MUTED, font=("Segoe UI", 8))
        self.index_label.pack(side="right", padx=18, pady=8)
        input_frame = tk.Frame(content, bg="#121824")
        input_frame.pack(fill="x", padx=0, pady=0)
        self.input_bar = tk.Text(input_frame, height=4, wrap="word", bg="#171f2d", fg=TEXT, insertbackground=TEXT, selectbackground="#30236d", relief="flat", borderwidth=0, padx=14, pady=12, font=("Segoe UI", 10))
        self.input_bar.pack(fill="x", padx=18, pady=(14, 8))
        self.input_bar.bind("<Control-Return>", self._send)
        actions = tk.Frame(input_frame, bg="#121824")
        actions.pack(fill="x", padx=18, pady=(0, 12))
        self.provider = ttk.Combobox(actions, values=["OpenRouter", "Ollama", "Groq", "Together", "Mistral"], state="readonly", width=19)
        self.provider.set("OpenRouter")
        self.provider.pack(side="left")
        self.status_label = tk.Label(actions, text="Prêt", bg="#121824", fg=MUTED, font=("Segoe UI", 9))
        self.status_label.pack(side="left", padx=14)
        self.send_button = ttk.Button(actions, text="Envoyer  ▶", command=self._send, style="Accent.TButton")
        self.send_button.pack(side="right")
        self.stop_button = ttk.Button(actions, text="Arrêter", command=self._stop_agent, state="disabled")
        self.stop_button.pack(side="right", padx=(0, 8))

    def _render_welcome(self) -> None:
        self.chat_view.configure(state="normal")
        self.chat_view.delete("1.0", "end")
        self.chat_view.insert("end", "\n\n")
        self.chat_view.insert("end", "                 ◈\n", ("hero",))
        self.chat_view.insert("end", "           Comment puis-je t’aider ?\n\n", ("welcome",))
        self.chat_view.insert("end", "    Ouvre un dossier pour commencer une conversation avec ton agent.\n", ("hint",))
        self.chat_view.tag_configure("hero", foreground="#a78bfa", font=("Segoe UI", 34, "bold"))
        self.chat_view.tag_configure("welcome", foreground=TEXT, font=("Segoe UI", 16, "bold"))
        self.chat_view.tag_configure("hint", foreground=MUTED, font=("Segoe UI", 10))
        self.chat_view.configure(state="disabled")

    def _append_message(self, role: str, content: str) -> None:
        self.chat_view.configure(state="normal")
        self.chat_view.insert("end", f"\n{role}\n", ("role",))
        self.chat_view.insert("end", f"{content}\n")
        self.chat_view.tag_configure("role", foreground="#a78bfa", font=("Segoe UI", 9, "bold"))
        self.chat_view.configure(state="disabled")
        self.chat_view.see("end")

    def open_folder(self) -> None:
        folder = filedialog.askdirectory(title="Ouvrir un dossier")
        if folder:
            self._activate_folder(folder)

    def _activate_folder(self, folder: str) -> None:
        self.active_folder = folder
        self.folder_title.configure(text=Path(folder).name)
        add_folder_to_index(folder)
        self._history = load_chat_history(folder)
        self._render_history()
        self.status_label.configure(text="Dossier actif")

    def _render_history(self) -> None:
        self.chat_view.configure(state="normal")
        self.chat_view.delete("1.0", "end")
        for message in self._history:
            self.chat_view.insert("end", f"\n{message.get('role', 'agent').title()}\n", ("role",))
            self.chat_view.insert("end", f"{message.get('content', '')}\n")
        self.chat_view.configure(state="disabled")

    def _load_last_folder(self) -> None:
        entries = load_folder_index()
        if entries and Path(entries[0].get("path", "")).is_dir():
            self._activate_folder(entries[0]["path"])

    def _folder_selected(self, _event=None) -> None:
        selection = self.folder_list.curselection()
        if selection:
            index = selection[0]
            entries = load_folder_index()
            if index < len(entries):
                self._activate_folder(entries[index].get("path", ""))

    def _send(self, _event=None):
        text = self.input_bar.get("1.0", "end").strip()
        if not text or self._worker:
            return "break"
        self.input_bar.delete("1.0", "end")
        self._append_message("Vous", text)
        history = list(self._history)
        self._history.append({"role": "user", "content": text})
        self._worker = AgentWorker(self.active_folder, text, self._events, history=history)
        self.send_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.status_label.configure(text="Génération en cours…")
        self._worker.start()
        return "break"

    def _stop_agent(self) -> None:
        if self._worker:
            self._worker.stop()
            self.status_label.configure(text="Arrêt demandé…")

    def _poll_events(self) -> None:
        try:
            while True:
                kind, payload = self._events.get_nowait()
                if kind == "result":
                    self._append_message("Agent", payload)
                    self._history.append({"role": "ai", "content": payload})
                    if self.active_folder:
                        try:
                            save_chat_history(self.active_folder, self._history)
                        except Exception:
                            pass
                elif kind == "error":
                    self._append_message("Erreur", f"❌ {payload}")
                elif kind == "finished":
                    self.send_button.configure(state="normal")
                    self.stop_button.configure(state="disabled")
                    self.status_label.configure(text="Prêt")
                    self._worker = None
        except Empty:
            pass
        self.after(100, self._poll_events)

    def init_project(self) -> None:
        if self.active_folder:
            self._append_message("Système", "Initialisation du projet disponible depuis le prochain panneau outils.")
        else:
            messagebox.showinfo("Projet", "Ouvre d’abord un dossier.")

    def open_settings(self) -> None:
        dialog = tk.Toplevel(self)
        dialog.title("Paramètres")
        dialog.geometry("760x600")
        dialog.minsize(650, 500)
        dialog.configure(bg=BG)
        ttk.Label(dialog, text="Paramètres", style="Title.TLabel").pack(anchor="w", padx=22, pady=(20, 14))
        notebook = ttk.Notebook(dialog)
        notebook.pack(fill="both", expand=True, padx=18, pady=(0, 18))
        general = ttk.Frame(notebook, padding=18)
        notebook.add(general, text="Général")
        cfg = load_global_config()
        ttk.Label(general, text="Mode agent par défaut").pack(anchor="w")
        mode = ttk.Combobox(general, values=["ask", "auto", "plan"], state="readonly")
        mode.set(cfg.get("agent_mode", "auto")); mode.pack(anchor="w", pady=(5, 16))
        ttk.Label(general, text="Provider actif (variable d’environnement)").pack(anchor="w")
        provider = ttk.Combobox(general, values=["OpenRouter", "Ollama", "Groq", "Together", "Mistral", "Gemini", "LM Studio"], state="readonly")
        provider.set((cfg.get("provider") or "OpenRouter").title()); provider.pack(anchor="w", pady=(5, 16))
        restore = tk.BooleanVar(value=cfg.get("restore_last_folder", True))
        ttk.Checkbutton(general, text="Démarrer dans le dernier dossier", variable=restore).pack(anchor="w", pady=5)
        ttk.Label(general, text="Répertoire de données").pack(anchor="w", pady=(18, 2))
        data_dir = ttk.Entry(general, width=72); data_dir.insert(0, cfg.get("data_dir", "")); data_dir.pack(anchor="w")

        appearance = ttk.Frame(notebook, padding=18); notebook.add(appearance, text="Apparence")
        ttk.Label(appearance, text="Thème").pack(anchor="w")
        theme = ttk.Combobox(appearance, values=["dark", "light"], state="readonly"); theme.set(cfg.get("theme", "dark")); theme.pack(anchor="w", pady=6)
        ttk.Label(appearance, text="L’interface native utilise un thème sombre optimisé pour le code.", style="Muted.TLabel").pack(anchor="w", pady=8)

        context = ttk.Frame(notebook, padding=18); notebook.add(context, text="Contexte & Mémoire")
        ttk.Label(context, text="Tokens réservés pour la réponse").pack(anchor="w")
        reserved = ttk.Spinbox(context, from_=512, to=8192, increment=256, width=12); reserved.set(cfg.get("reserved_tokens", 2048)); reserved.pack(anchor="w", pady=6)
        auto_compact = tk.BooleanVar(value=cfg.get("auto_compact", True)); ttk.Checkbutton(context, text="Auto-compact", variable=auto_compact).pack(anchor="w", pady=8)
        ttk.Label(context, text="Seuil auto-compact (%)").pack(anchor="w"); threshold = ttk.Spinbox(context, from_=40, to=95, increment=5, width=12); threshold.set(cfg.get("compact_threshold", 70)); threshold.pack(anchor="w", pady=6)

        permissions = ttk.Frame(notebook, padding=18); notebook.add(permissions, text="Permissions")
        ttk.Label(permissions, text="Niveau de permission").pack(anchor="w")
        permission = ttk.Combobox(permissions, values=["demander", "auto", "strict"], state="readonly"); permission.set(cfg.get("permission_mode", "demander")); permission.pack(anchor="w", pady=6)
        ttk.Label(permissions, text="Demander = confirmation | Auto = sans confirmation | Strict = lecture seule", style="Muted.TLabel").pack(anchor="w", pady=4)
        shell_ask = tk.BooleanVar(value=cfg.get("shell_ask", True)); ttk.Checkbutton(permissions, text="Confirmer l’exécution shell", variable=shell_ask).pack(anchor="w", pady=8)
        files_ask = tk.BooleanVar(value=cfg.get("files_ask", False)); ttk.Checkbutton(permissions, text="Confirmer les écritures de fichiers", variable=files_ask).pack(anchor="w")

        folder_tab = ttk.Frame(notebook, padding=18); notebook.add(folder_tab, text="Dossier")
        ttk.Label(folder_tab, text=self.active_folder or "Aucun dossier actif", style="Title.TLabel").pack(anchor="w")
        project = load_project_settings(self.active_folder)
        ttk.Label(folder_tab, text="Provider du projet").pack(anchor="w", pady=(16, 2))
        project_provider = ttk.Combobox(folder_tab, values=["openrouter", "groq", "together", "mistral", "gemini", "ollama"], state="readonly", width=24)
        project_provider.set(project.get("provider", "") or "openrouter"); project_provider.pack(anchor="w")
        ttk.Label(folder_tab, text="Clé API du projet").pack(anchor="w", pady=(12, 2))
        project_key = ttk.Entry(folder_tab, width=72, show="•"); project_key.insert(0, project.get("api_key", "")); project_key.pack(anchor="w")
        ttk.Label(folder_tab, text="Modèle").pack(anchor="w", pady=(12, 2))
        project_model = ttk.Entry(folder_tab, width=72); project_model.insert(0, project.get("model", "")); project_model.pack(anchor="w")
        ttk.Label(folder_tab, text="URL de base (optionnel)").pack(anchor="w", pady=(12, 2))
        project_url = ttk.Entry(folder_tab, width=72); project_url.insert(0, project.get("base_url", "")); project_url.pack(anchor="w")
        ttk.Label(folder_tab, text="Patterns ignorés").pack(anchor="w", pady=(20, 2)); ignored = ttk.Entry(folder_tab, width=72); ignored.insert(0, "node_modules/, .env, dist/"); ignored.pack(anchor="w")
        ttk.Label(folder_tab, text="Contexte système personnalisé").pack(anchor="w", pady=(20, 2)); custom = tk.Text(folder_tab, height=7, bg="#171f2d", fg=TEXT, insertbackground=TEXT, relief="flat"); custom.pack(fill="x", pady=4)

        tools = ttk.Frame(notebook, padding=18)
        notebook.add(tools, text="Outils")
        ttk.Label(tools, text="Plugins et serveurs MCP").pack(anchor="w")
        try:
            from openagenticskyzer.plugins.loader import load_plugins
            plugins, errors = load_plugins(self.active_folder)
            ttk.Label(tools, text="\n".join(f"🧩 {tool.name}" for tool in plugins) or "Aucun plugin chargé", style="Muted.TLabel").pack(anchor="w", pady=8)
            if errors: ttk.Label(tools, text="\n".join(f"⚠ {e}" for e in errors), style="Muted.TLabel").pack(anchor="w")
        except Exception as exc:
            ttk.Label(tools, text=f"Plugins indisponibles : {exc}", style="Muted.TLabel").pack(anchor="w", pady=8)
        ttk.Label(tools, text="Serveurs MCP configurés", style="Title.TLabel").pack(anchor="w", pady=(18, 4))
        mcp_box = tk.Listbox(tools, height=5, bg="#0c0e12", fg=TEXT, relief="flat", highlightthickness=0)
        mcp_box.pack(fill="x")
        for server in load_mcp_config(): mcp_box.insert("end", server.get("command", ""))

        danger = ttk.Frame(notebook, padding=18); notebook.add(danger, text="⚠ Danger")
        ttk.Label(danger, text="Zone Danger", foreground="#f87171").pack(anchor="w")
        ttk.Button(danger, text="Effacer l’historique du dossier actif", command=self.clear_history).pack(anchor="w", pady=(20, 5))
        ttk.Label(danger, text="Cette action supprime les sessions JSON du dossier actif.", style="Muted.TLabel").pack(anchor="w")

        def save():
            cfg.update({"agent_mode": mode.get(), "provider": provider.get().lower(), "theme": theme.get(), "restore_last_folder": restore.get(), "data_dir": data_dir.get().strip(), "reserved_tokens": int(reserved.get()), "auto_compact": auto_compact.get(), "compact_threshold": int(threshold.get()), "permission_mode": permission.get(), "shell_ask": shell_ask.get(), "files_ask": files_ask.get()})
            save_global_config(cfg)
            if self.active_folder:
                save_project_settings(self.active_folder, {"provider": project_provider.get(), "api_key": project_key.get().strip(), "model": project_model.get().strip(), "base_url": project_url.get().strip()})
            dialog.destroy(); self.status_label.configure(text="Paramètres sauvegardés")
        ttk.Button(dialog, text="Enregistrer", command=save, style="Accent.TButton").pack(side="right", padx=22, pady=(0, 18))

    def clear_history(self) -> None:
        if self.active_folder and messagebox.askyesno("Confirmer", "Effacer l’historique du dossier actif ?"):
            self._history = []; self._render_welcome(); self.status_label.configure(text="Historique effacé")

    def open_commands(self) -> None:
        dialog = tk.Toplevel(self); dialog.title("Palette de commandes"); dialog.geometry("520x420"); dialog.configure(bg=BG)
        ttk.Label(dialog, text="Rechercher une commande…", style="Title.TLabel").pack(anchor="w", padx=18, pady=(18, 8))
        search = ttk.Entry(dialog); search.pack(fill="x", padx=18, pady=(0, 10)); search.focus_set()
        commands = [("Ouvrir un dossier", self.open_folder), ("Paramètres", self.open_settings), ("Exporter la conversation", self.open_export), ("Effacer l’historique", self.clear_history)]
        box = tk.Listbox(dialog, bg="#0c0e12", fg=TEXT, selectbackground="#30236d", relief="flat", highlightthickness=0); box.pack(fill="both", expand=True, padx=18, pady=(0, 18))
        for label, _ in commands: box.insert("end", label)
        def run(_event=None):
            idx = box.curselection()
            if idx: dialog.destroy(); commands[idx[0]][1]()
        box.bind("<Double-1>", run); search.bind("<Return>", run)

    def open_export(self) -> None:
        if not self._history: messagebox.showinfo("Exporter", "Aucune conversation à exporter."); return
        path = filedialog.asksaveasfilename(title="Exporter la conversation", defaultextension=".md", filetypes=[("Markdown", "*.md"), ("JSON", "*.json")])
        if not path: return
        try:
            if path.lower().endswith(".json"):
                import json; Path(path).write_text(json.dumps(self._history, indent=2, ensure_ascii=False), encoding="utf-8")
            else:
                Path(path).write_text("\n\n".join(f"## {m.get('role', 'agent').title()}\n\n{m.get('content', '')}" for m in self._history), encoding="utf-8")
            self.status_label.configure(text="Conversation exportée")
        except OSError as exc: messagebox.showerror("Export", str(exc))
