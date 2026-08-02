"""Input bar — textarea, model picker button, send button."""
import asyncio
import re as _re
from nicegui import ui, run

# Détection d'une demande de recherche web dans le message utilisateur
_SEARCH_DETECT_RE = _re.compile(
    r"\b(recherche|search|cherche|trouve|find|look up|"
    r"dernier|derni.re|r.cent|actuel|news|actualit.|latest|nouveau|nouvelle|"
    r"who is|qu.est.ce|c.est quoi|youtube|twitter|reddit|"
    r"site:|inurl:|filetype:|"
    # Résultats sportifs / événements factuels
    r"remport|vainqueur|champion|finale|score|r.sultat|classement|palmares|"
    r"a gagn.|qui a|who won|winner|"
    # Années récentes → question factuelle récente
    r"202[4-9]|"
    # Sorties culturelles
    r"derni.re vid.o|dernier film|dernier album|sorti en|sort[i]|publi.|lanc.|"
    # Prix / récompenses
    r"oscar|grammy|c.sar|bafta|nobel|eurovision|"
    # Dev / tech — version, doc, release
    r"changelog|release.?notes?|"
    r"version (?:de|actuelle|stable|courante|latest)|quelle version|"
    r"doc(?:umentation)? (?:de|pour|officielle)|"
    r"tuto(?:riel)? (?:de|pour)|"
    # IA / modèles LLM
    r"llama|mistral|gemini|gpt.?[0-9o]|stable.?diffusion|hugging.?face|"
    r"quel(?:le)? (?:ia|llm|mod.le) |meilleur (?:llm|mod.le ia)|"
    # Jeux vidéo
    r"patch.?notes?|dlc|\bearly.?access\b|season.?pass|"
    r"prix (?:de|du) (?:jeu|pass)|sortie (?:du|de) jeu|"
    # Loi / admin / fiscal
    r"legifrance|service.?public|"
    r"loi (?:n°|\d{4}|sur)|r.glement (?:eu|ue|\d)|"
    r"amende (?:de|pour|\d)|imp.t|d.claration fiscale|"
    # Finance / crypto
    r"cours (?:du|de la|de l')|bitcoin|ethereum|cryptomonnaie|"
    r"taux (?:d.|de)|(?:action|cotation) (?:de|du)|bourse|"
    # Santé
    r"sympt.mes? (?:de|du)|m.dicament (?:pour|contre)|posologie|effet(?:s)? secondaire|"
    # Culture
    r"biographie de|qui a .crit|auteur de|exposition (?:de|du|au)|"
    # Général
    r"combien|quel est le|quelle est la|qui est le|qui est la)\b",
    _re.IGNORECASE,
)
_QUERY_CLEANUP_RE = _re.compile(
    r"\b(tu peux|pouvez.vous|peux.tu|me dire|me faire une?|"
    r"faire une? recherche(?: internet| web| en ligne)?|et me dire|"
    r"et avec|quels? autres?|can you|could you|please|tell me|"
    r"search (?:for|the)|find me|look up|je voudrais savoir|j.aimerais savoir)\b",
    _re.IGNORECASE,
)
_NEWS_DETECT_RE = _re.compile(
    r"\b(dernier|derni.re|r.cent|actuel|news|actualit.|latest|nouveau|nouvelle)\b",
    _re.IGNORECASE,
)
_LOCAL_PROVIDERS = {"lmstudio", "ollama", "llamacpp"}

_COMPLEX_DETECT_RE = _re.compile(
    r"\b(explique|compare|analyse|d.taille|pr.cis|complet|exhaustif|"
    r"liste|tous les|toutes les|pourquoi|comment|diff.rence|"
    r"avantage|inconv.nient|pros?|cons?|overview|summary|"
    r"contexte|historique|impact|cons.quence|signification)\b",
    _re.IGNORECASE,
)

def _is_complex_question(text: str) -> bool:
    """Question complexe = plusieurs sous-questions ou demande d'analyse approfondie."""
    return (
        text.count("?") >= 2
        or len(text.strip()) > 150
        or bool(_COMPLEX_DETECT_RE.search(text))
    )


def _extract_query_and_topic(msg: str) -> tuple[str, str]:
    """Extrait une query de recherche propre + topic depuis le message brut."""
    cleaned = _QUERY_CLEANUP_RE.sub(" ", msg)
    cleaned = _re.sub(r"\s{2,}", " ", cleaned).strip(" ?.,!")
    topic = "news" if _NEWS_DETECT_RE.search(msg) else "general"
    return (cleaned[:200] if len(cleaned) > 10 else msg[:200]), topic


def _format_memory_injection(global_mem: str, project_mem: str) -> str:
    """Formate la mémoire globale + projet en un seul bloc système à injecter
    en tête d'historique. Retourne '' si les deux sont vides (no-op côté
    appelant — pure logique de formatage, testable sans état NiceGUI)."""
    parts = []
    if global_mem:
        parts.append(f"MÉMOIRE GLOBALE (préférences utilisateur) :\n{global_mem}")
    if project_mem:
        parts.append(f"MÉMOIRE PROJET (contexte persistant) :\n{project_mem}")
    return "\n\n".join(parts)

from openagenticskyzer.app.state import state, ChatMessage
from openagenticskyzer.app.components.model_modal import open_model_modal

_TOOL_TAGS_STREAM = {
    "run_command": "run",
    "create_file": "write", "edit_file": "write", "delete_file": "write",
    "create_dir": "write", "delete_dir": "write",
    "view_file": "read", "read_file": "read", "list_dir": "read",
    "glob_files": "read", "grep_file": "read", "grep_codebase": "read",
    "internet_search": "search",
}


async def _stream_agent(agent, initial_state: dict) -> str:
    """Stream agent via astream_events v2 — accumule tokens dans state.streaming_content."""
    state.is_streaming = True
    state.streaming_content = ""
    try:
        async for event in agent.astream_events(
            initial_state,
            version="v2",
            config={"recursion_limit": 300},
        ):
            if state.stop_requested:
                break
            kind = event.get("event", "")

            if kind == "on_chat_model_stream":
                chunk = event["data"].get("chunk")
                if chunk and hasattr(chunk, "content"):
                    delta = chunk.content
                    if isinstance(delta, str):
                        state.streaming_content += delta
                    elif isinstance(delta, list):
                        for part in delta:
                            if isinstance(part, dict) and part.get("type") == "text":
                                state.streaming_content += part.get("text", "")
                state.live_tokens += 1

            elif kind == "on_tool_start":
                tool_name = event.get("name", "?")
                tag = _TOOL_TAGS_STREAM.get(tool_name, "read")
                data = event["data"].get("input", {})
                if isinstance(data, dict):
                    detail = str(data.get("path") or data.get("command") or data.get("query") or data)[:120]
                else:
                    detail = str(data)[:120]
                state.live_log.append(ChatMessage(
                    role="tool", content="", tool_name=tool_name,
                    tool_tag=tag, tool_detail=detail,
                ))
                state.streaming_content = ""  # Reset — la réponse intermédiaire n'est pas la finale

            elif kind == "on_tool_end":
                output = event["data"].get("output", "")
                output_str = str(output) if output else ""
                if state.live_log and state.live_log[-1].role == "tool" and not state.live_log[-1].content:
                    last = state.live_log[-1]
                    tool_diff = None
                    content_display = output_str[:300]
                    if "DIFF:\n" in output_str:
                        parts = output_str.split("DIFF:\n", 1)
                        content_display = parts[0].strip()[:200]
                        tool_diff = parts[1][:1500] if len(parts) > 1 else None
                    state.live_log[-1] = ChatMessage(
                        role="tool", content=content_display,
                        tool_name=last.tool_name, tool_tag=last.tool_tag,
                        tool_detail=last.tool_detail, tool_diff=tool_diff,
                    )
    except Exception as _e:
        state.streaming_content = f"❌ Erreur streaming : {_e}"
    finally:
        state.is_streaming = False
    return state.streaming_content


async def _send_message(text: str, input_el, send_lbl=None, send_btn=None):
    """Append user message, run agent, append AI response."""
    if not text.strip() or state.agent_running:
        return
    if not state.active_folder:
        ui.notify("Ouvre un dossier d'abord.", type="warning")
        return
    if not state.current_model:
        ui.notify("Sélectionne un modèle d'abord (bouton ● en bas à droite).", type="warning")
        return

    import os
    os.chdir(state.active_folder)

    from openagenticskyzer.app.components.chat import chat_messages, permission_banner
    from openagenticskyzer.app.components.context_bar import context_bar, trigger_compact

    _imgs = [f.content for f in state.attached_files if f.content_type == "image"]
    state.messages.append(ChatMessage(role="user", content=text, images=_imgs))
    state.live_log = []
    state.live_tokens = 0
    state.stop_requested = False
    input_el.set_value("")
    state.agent_running = True
    if send_lbl:
        send_lbl.set_text("■")
    if send_btn:
        send_btn.classes(remove="bg-purple-600 hover:bg-purple-700", add="bg-red-700 hover:bg-red-800")
    chat_messages.refresh()

    from openagenticskyzer.app.notifier import task_started, task_finished
    task_started()
    state.is_streaming = False
    state.streaming_content = ""

    def _on_permission_request(req):
        state.pending_permission = req
        permission_banner.refresh()

    try:
        from openagenticskyzer.agent import build_agent
        from openagenticskyzer.permissions import PermissionManager
        from openagenticskyzer.app.storage import load_global_config, load_folder_config
        from openagenticskyzer.utils.utils import _DEFAULT_CTX_LIMITS

        global_cfg = load_global_config()
        folder_cfg = load_folder_config(state.active_folder)

        # Mode agent (héritage global → dossier)
        mode = folder_cfg.get("agent_mode", "inherit")
        if mode == "inherit":
            mode = global_cfg.get("agent_mode", "auto")

        # Limite de tokens avec réservation pour la réponse
        max_ctx = _DEFAULT_CTX_LIMITS.get(state.current_provider or "ollama", 32_000)
        configured_max = global_cfg.get("max_tokens") or max_ctx
        reserved = int(global_cfg.get("reserved_tokens", 2048))
        max_tokens = max(1000, configured_max - reserved)

        perm_manager = PermissionManager(
            mode=state.permission_mode,
            is_cli=False,
            on_request=_on_permission_request,
        )

        agent = build_agent(
            mode=mode,
            max_tokens=max_tokens,
            permission_manager=perm_manager,
            provider=state.current_provider,
            model_name=state.current_model,
        )

        # Contexte système personnalisé du dossier
        custom_prompt = folder_cfg.get("custom_prompt", "").strip()

        history = [
            {"role": m.role if m.role != "ai" else "assistant", "content": m.content}
            for m in state.messages[:-1]
            if m.role in ("user", "ai")
        ]

        # Injecte le custom_prompt comme premier message système si défini
        if custom_prompt:
            history = [{"role": "system", "content": custom_prompt}] + history

        # Injecte la mémoire persistante (globale + projet) en tête d'historique
        from openagenticskyzer.context.project_memory import load_project_memory, load_global_memory

        global_mem = load_global_memory()
        project_mem = load_project_memory(state.active_folder) if state.active_folder else ""
        memory_injection = _format_memory_injection(global_mem, project_mem)
        if memory_injection:
            history = [{"role": "system", "content": memory_injection}] + history

        # Injecte les learnings confirmés (global + projet) en tête d'historique
        from openagenticskyzer.context.learnings import load_learnings, format_learnings_for_injection

        learnings = load_learnings(project_folder=state.active_folder, confirmed_only=True)
        learnings_injection = format_learnings_for_injection(learnings)
        if learnings_injection:
            history = [{"role": "system", "content": learnings_injection}] + history

        # ── Pré-fetch web : recherche + lecture de source(s) — local providers uniquement ──
        user_content_for_agent = text
        if state.current_provider in _LOCAL_PROVIDERS and _SEARCH_DETECT_RE.search(text):
            try:
                from openagenticskyzer.tools.internet_search import internet_search as _isearch
                from openagenticskyzer.tools.web_fetch import fetch_url as _fetch_url
                sq, s_topic = _extract_query_and_topic(text)
                is_complex = _is_complex_question(text)
                max_fetches = 3 if is_complex else 1

                state.live_log.append(ChatMessage(
                    role="tool",
                    content="Recherche multi-sources…" if is_complex else "Recherche en cours…",
                    tool_name="internet_search", tool_tag="search", tool_detail=sq,
                ))
                chat_messages.refresh()

                # Questions complexes : 2 recherches parallèles (angles différents)
                if is_complex:
                    sq2 = sq[:80].rstrip()
                    res1, res2 = await asyncio.gather(
                        run.io_bound(_isearch.invoke, {"query": sq, "topic": s_topic, "max_results": 6}),
                        run.io_bound(_isearch.invoke, {"query": sq2, "topic": "news", "max_results": 6}),
                    )
                    seen_urls: set[str] = set()
                    all_results = []
                    for res in (res1, res2):
                        for r in (res.get("results", []) if isinstance(res, dict) else []):
                            if r.get("url") not in seen_urls:
                                seen_urls.add(r.get("url", ""))
                                all_results.append(r)
                    search_res = {"results": all_results}
                else:
                    search_res = await run.io_bound(
                        _isearch.invoke, {"query": sq, "topic": s_topic, "max_results": 8}
                    )

                if isinstance(search_res, dict) and search_res.get("results"):
                    results = search_res["results"]
                    lines = [
                        f"[{r.get('title', '')}]\n{(r.get('content') or '')[:600]}\nURL: {r.get('url', '')}"
                        for r in results[:8]
                    ]
                    state.live_log[-1] = ChatMessage(
                        role="tool", content=f"{len(results)} résultats trouvés",
                        tool_name="internet_search", tool_tag="search", tool_detail=sq,
                    )

                    # ── Fetch des meilleures sources ──────────────────────────
                    _TRUSTED = (
                        # Encyclopédie
                        "wikipedia.org",
                        # Presse FR généraliste
                        "lemonde.fr", "lefigaro.fr", "liberation.fr",
                        "franceinfo.fr", "le-parisien.fr", "20minutes.fr",
                        "bfmtv.com", "lexpress.fr", "nouvelobs.com",
                        # Presse EN internationale
                        "reuters.com", "apnews.com", "bbc.com",
                        "theguardian.com", "nytimes.com",
                        # Tech / Dev
                        "github.com", "stackoverflow.com",
                        "developer.mozilla.org", "docs.python.org",
                        "npmjs.com", "pypi.org",
                        "learn.microsoft.com", "docs.microsoft.com",
                        "rust-lang.org", "go.dev",
                        "developer.apple.com",
                        # Tech news FR
                        "numerama.com", "clubic.com", "01net.com",
                        "lesnumeriques.com", "igen.fr",
                        # Tech news EN
                        "techcrunch.com", "theverge.com", "wired.com",
                        "arstechnica.com", "engadget.com",
                        # IA / ML
                        "huggingface.co", "openai.com", "anthropic.com",
                        "arxiv.org", "paperswithcode.com", "deepmind.com",
                        # Jeux vidéo FR
                        "jeuxvideo.com", "gamekult.com", "millenium.org",
                        # Jeux vidéo EN
                        "ign.com", "eurogamer.net", "pcgamer.com",
                        "rockpapershotgun.com", "steamdb.info",
                        "store.steampowered.com",
                        # Sports
                        "lequipe.fr", "eurosport.fr", "uefa.com",
                        "olympics.com", "maxifoot.fr", "footmercato.net",
                        # Loi / admin FR
                        "legifrance.gouv.fr", "service-public.fr",
                        "impots.gouv.fr", "gouvernement.fr",
                        # Santé
                        "who.int", "ameli.fr", "sante.gouv.fr", "inserm.fr",
                        # Science
                        "nature.com", "sciencedirect.com", "cnrs.fr",
                        "pubmed.ncbi.nlm.nih.gov",
                        # Finance
                        "boursorama.com", "investing.com",
                        "tradingeconomics.com", "coinmarketcap.com",
                        # Culture / cinéma / musique
                        "allocine.fr", "imdb.com", "metacritic.com",
                        "rottentomatoes.com", "konbini.com",
                        # Données
                        "statista.com",
                        # Domaines .gov/.gouv génériques
                        "gov.fr", ".gouv.fr",
                    )
                    urls = [r.get("url", "") for r in results if r.get("url")]
                    trusted_urls = [u for u in urls if any(t in u for t in _TRUSTED)]
                    fallback_urls = [u for u in urls if u not in trusted_urls]
                    candidates = trusted_urls + fallback_urls[:4]

                    _kws = [w for w in sq.split() if len(w) >= 4]
                    page_sections: list[str] = []

                    for candidate in candidates[: max_fetches * 2]:
                        if len(page_sections) >= max_fetches:
                            break
                        state.live_log.append(ChatMessage(
                            role="tool", content="Lecture de la source…",
                            tool_name="fetch_url", tool_tag="search", tool_detail=candidate,
                        ))
                        chat_messages.refresh()
                        fetched = await run.io_bound(
                            _fetch_url.invoke, {"url": candidate, "max_chars": 3000 if is_complex else 4000}
                        )
                        content = fetched.get("content", "") if isinstance(fetched, dict) else ""
                        relevant = any(kw.lower() in content.lower() for kw in _kws)
                        if content and len(content) >= 200 and not fetched.get("error") and relevant:
                            title = fetched.get("title", candidate)
                            page_sections.append(
                                f"SOURCE — {title}\nURL : {candidate}\n\n{content}"
                            )
                            state.live_log[-1] = ChatMessage(
                                role="tool",
                                content=f"Source lue : {title[:60]}",
                                tool_name="fetch_url", tool_tag="search", tool_detail=candidate,
                            )
                        else:
                            state.live_log.pop()

                    sources_block = (
                        "\n\n" + "\n\n---\n\n".join(page_sections)
                        if page_sections else ""
                    )
                    user_content_for_agent = (
                        "RÉSULTATS DE RECHERCHE WEB (temps réel) :\n\n"
                        + "\n---\n".join(lines)
                        + sources_block
                        + f"\n\nEn te basant sur ces informations, réponds précisément à cette question : {text}"
                    )
                else:
                    state.live_log.pop()
            except Exception:
                if state.live_log and state.live_log[-1].tool_tag == "search":
                    state.live_log.pop()

        from openagenticskyzer.app.file_processor import build_message_content
        final_content = build_message_content(user_content_for_agent, list(state.attached_files))
        state.attached_files.clear()

        initial_state = {"messages": history + [{"role": "user", "content": final_content}]}
        ai_text = await _stream_agent(agent, initial_state)
        state.streaming_content = ""
        task_finished(ai_text[:100] if ai_text else "Terminé")

        # Retire les echoes de tool output que certains modèles répètent dans leur réponse finale
        if ai_text:
            import re as _re
            for _pattern in [
                r'File created at [A-Za-z]:[\\\/]',
                r'File created at \/[a-z]',
                r'EDIT_OK\n',
                r'Directory created at [A-Za-z]',
                r'\nFile [^\n]+ \(\d+ lines?\)',
            ]:
                _m = _re.search(_pattern, ai_text)
                if _m and _m.start() > 0:
                    ai_text = ai_text[:_m.start()].rstrip()
            ai_text = ai_text.strip()

        # Intègre les tool calls capturés dans l'historique permanent
        if state.live_log:
            state.messages.extend(state.live_log)
            state.live_log = []

        if ai_text:
            state.messages.append(ChatMessage(role="ai", content=ai_text))

        # Sauvegarde de l'historique chat sur disque
        from openagenticskyzer.app.storage import save_chat_history
        save_chat_history(state.active_folder, state.messages)

        # Mise à jour de la jauge de contexte (tokens réservés déduits)
        total_chars = sum(len(m.content) for m in state.messages if m.role in ("user", "ai"))
        effective_max = max(1, max_tokens)
        state.context_tokens = total_chars // 4
        state.context_pct = min(100.0, state.context_tokens / effective_max * 100)

        # Auto-compact si activé et seuil atteint
        if (
            global_cfg.get("auto_compact", True)
            and state.context_pct >= global_cfg.get("compact_threshold", 70)
        ):
            await trigger_compact()

    except Exception as exc:
        exc_str = str(exc)
        if "StopRequested" not in type(exc).__name__ and "Arrêté" not in exc_str:
            if "jinja template" in exc_str.lower() or "cannot put tools" in exc_str.lower():
                state.messages.append(ChatMessage(role="ai", content=(
                    "❌ **Template Jinja incompatible avec le tool use**\n\n"
                    "Le modèle chargé ne supporte pas le function calling avec son template actuel.\n\n"
                    "**Solutions :**\n"
                    "• Dans le catalogue LM Studio, cherchez le même modèle sous l'organisation "
                    "`lmstudio-community` (templates corrigés).\n"
                    "• Recommandé pour le tool use : `Hermes-3-Llama-3.1-8B` (NousResearch) "
                    "ou `Mistral-7B-Instruct-v0.3`.\n"
                    "• Alternativement : changez le Prompt Template dans LM Studio "
                    "→ My Models → model settings → Prompt Template."
                )))
            else:
                state.messages.append(ChatMessage(role="ai", content=f"❌ Erreur : {exc}"))
    finally:
        state.live_log = []
        state.live_tokens = 0
        state.stop_requested = False
        state.agent_running = False
        state.is_streaming = False
        state.streaming_content = ""
        state.pending_permission = None
        if send_lbl:
            send_lbl.set_text("➤")
        if send_btn:
            send_btn.classes(remove="bg-red-700 hover:bg-red-800", add="bg-purple-600 hover:bg-purple-700")
        try:
            chat_messages.refresh()
            permission_banner.refresh()
            context_bar.refresh()
        except Exception:
            pass


@ui.refreshable
def model_button():
    full_name = state.current_model or 'Aucun modèle'
    label = f"● {full_name[:20]}{'…' if len(full_name) > 20 else ''} ▾"
    with ui.button(label, on_click=open_model_modal).classes(
        "text-xs text-gray-400 border border-gray-700 bg-gray-900 "
        "hover:border-purple-500 px-2 h-10 rounded-lg flex-shrink-0"
    ):
        if full_name != 'Aucun modèle':
            ui.tooltip(full_name).classes("text-xs bg-gray-900 text-gray-200 border border-gray-700")


def render_input_bar():
    with ui.column().classes("w-full px-3 pb-3 pt-2 gap-1 oa-input-col").style(
        "background:#111;border-top:1px solid #1e1e1e;flex-shrink:0"
    ):
        with ui.row().classes("w-full items-end gap-2"):
            input_el = ui.textarea(placeholder="Un message…").classes(
                "flex-1 text-xs rounded-lg oa-input-ta"
            ).style(
                "background:#1a1a1a;border:1px solid #2a2a2a;color:#e0e0e0;"
                "min-height:40px;padding:8px 12px;overflow-y:auto;"
                "overflow-wrap:break-word;word-break:break-word;"
                "resize:none"
            ).props("rows=2")

            model_button()

            # Bouton upload fichiers
            def _handle_upload(e):
                from openagenticskyzer.app.file_processor import process_upload
                try:
                    result = process_upload(e.name, e.content.read())
                    if result:
                        state.attached_files.append(result)
                        _refresh_attachments()
                        ui.notify(f"📎 {e.name} ajouté", type="positive")
                    else:
                        ui.notify(f"Format non supporté : {e.name}", type="warning")
                except Exception as ex:
                    ui.notify(f"Erreur upload : {ex}", type="negative")

            upload_el = ui.upload(
                on_upload=_handle_upload,
                auto_upload=True,
                multiple=True,
            ).props(
                "accept='.txt,.py,.js,.ts,.json,.yaml,.yml,.toml,.html,.css,.rs,.go,.java,.c,.cpp,.sh,.md,.pdf,.csv,.png,.jpg,.jpeg,.webp,.gif'"
                " flat hide-upload-btn"
            ).classes("hidden")

            ui.button("📎", on_click=lambda: upload_el.run_method("pickFiles")).classes(
                "w-10 h-10 bg-gray-900 border border-gray-700 text-gray-300 rounded-lg flex-shrink-0"
            )

            with ui.button(on_click=lambda: None).classes(
                "w-10 h-10 bg-purple-600 hover:bg-purple-700 rounded-lg flex-shrink-0 oa-send-btn"
            ) as send_btn:
                send_lbl = ui.label("➤").classes("text-white text-sm leading-none")

        @ui.refreshable
        def _attachments_display():
            if not state.attached_files:
                return
            with ui.row().classes("flex-wrap gap-2 px-1 pb-1"):
                for i, f in enumerate(state.attached_files):
                    if f.content_type == "image":
                        # Preview image — thumbnail cliquable avec ✕
                        with ui.element("div").style(
                            "position:relative;display:inline-block;"
                            "width:72px;height:72px;border-radius:8px;overflow:hidden;"
                            "border:1px solid #3a3a3a;flex-shrink:0"
                        ):
                            ui.html(
                                f'<img src="{f.content}" style="width:72px;height:72px;'
                                f'object-fit:cover;display:block" title="{f.name}">'
                            )
                            ui.button(
                                "✕",
                                on_click=lambda _, idx=i: _remove_attachment(idx)
                            ).style(
                                "position:absolute;top:2px;right:2px;"
                                "width:18px;height:18px;min-width:0;padding:0;"
                                "background:rgba(0,0,0,.7);color:#fff;"
                                "border-radius:50%;font-size:10px;line-height:18px"
                            ).props("flat dense")
                    else:
                        # Carte fichier (PDF, CSV, texte, code…)
                        _EXT_ICONS = {
                            "pdf": "📕", "csv": "📊",
                            "py": "🐍", "js": "🟨", "ts": "🟦",
                            "json": "📋", "md": "📝",
                        }
                        ext = f.name.rsplit(".", 1)[-1].lower() if "." in f.name else ""
                        icon = _EXT_ICONS.get(ext, "📄")
                        with ui.element("div").style(
                            "display:flex;flex-direction:column;justify-content:space-between;"
                            "width:90px;height:72px;border-radius:8px;padding:6px 8px;"
                            "background:#1e1e2e;border:1px solid #3a3a3a;position:relative;flex-shrink:0"
                        ):
                            ui.label(icon).style("font-size:22px;line-height:1")
                            ui.label(f.name).style(
                                "font-size:9px;color:#aaa;overflow:hidden;"
                                "text-overflow:ellipsis;white-space:nowrap;max-width:74px"
                            )
                            ui.button(
                                "✕",
                                on_click=lambda _, idx=i: _remove_attachment(idx)
                            ).style(
                                "position:absolute;top:2px;right:2px;"
                                "width:16px;height:16px;min-width:0;padding:0;"
                                "background:rgba(0,0,0,.5);color:#aaa;"
                                "border-radius:50%;font-size:9px;line-height:16px"
                            ).props("flat dense")

        def _refresh_attachments():
            _attachments_display.refresh()

        def _remove_attachment(idx: int):
            if 0 <= idx < len(state.attached_files):
                state.attached_files.pop(idx)
                _attachments_display.refresh()

        _attachments_display()

        # Détecte les fichiers ajoutés via paste/drop (endpoint FastAPI bypass _refresh_attachments)
        _prev_count = [len(state.attached_files)]
        def _poll_attachments():
            curr = len(state.attached_files)
            if curr != _prev_count[0]:
                _prev_count[0] = curr
                _attachments_display.refresh()
        ui.timer(0.8, _poll_attachments)

        ui.label("Entrée = envoyer · Shift+Entrée / Ctrl+Entrée = nouvelle ligne").classes("text-xs text-gray-700 px-1")

        def _on_send_click():
            if state.agent_running:
                state.stop_requested = True
            else:
                asyncio.ensure_future(_send_message(input_el.value, input_el, send_lbl, send_btn))

        send_btn.on("click", _on_send_click)

        # JS : Enter seul = envoyer, Shift/Ctrl+Enter = saut de ligne
        # + word-wrap + resize vertical avec sauvegarde localStorage
        # La fonction JS se ré-essaie jusqu'à trouver le DOM (évite le one-shot raté)
        def _setup_input_js():
            ui.run_javascript("""
(function trySetup() {
    var col = document.querySelector('.oa-input-col');
    if (!col) { setTimeout(trySetup, 200); return; }
    if (col._oaSetup) return;

    var ta = col.querySelector('textarea');
    if (!ta) { setTimeout(trySetup, 200); return; }

    col._oaSetup = true;

    // Word wrap
    ta.style.overflowWrap = 'break-word';
    ta.style.wordBreak = 'break-word';
    ta.style.whiteSpace = 'pre-wrap';
    ta.style.resize = 'vertical';
    ta.style.overflowY = 'auto';
    ta.style.maxHeight = '60vh';
    ta.style.boxSizing = 'border-box';

    // Restaurer la hauteur sauvegardée
    var saved = localStorage.getItem('oa-input-height');
    if (saved) { ta.style.height = saved; }

    // Sauvegarder la hauteur après redimensionnement
    new ResizeObserver(function() {
        var h = ta.offsetHeight;
        if (h > 20) localStorage.setItem('oa-input-height', h + 'px');
    }).observe(ta);

    // Enter sans modificateur = cliquer le bouton envoi
    ta.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            var btn = col.querySelector('.oa-send-btn');
            if (btn) btn.click();
        }
    });
})();
""")
        ui.timer(0.1, _setup_input_js, once=True)
