"""LangGraph node implementations."""

import json
import logging
import re

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.graph import END

from openagenticskyzer.context.messages import clean_messages, trim_message_history
from openagenticskyzer.graph.complexity import analyze_complexity
from openagenticskyzer.graph.state import AgentState
from openagenticskyzer.prompts.reasoning_templates import (
    COT_PROMPT, COT_SYSTEM_INJECT, REASONING_TEMPLATES,
)

logger = logging.getLogger("openagentic.nodes")


def _parse_text_tool_calls(text: str) -> list[dict]:
    """Extrait un ou plusieurs JSON tool calls collés dans un texte."""
    results = []
    decoder = json.JSONDecoder()
    idx = 0
    text = text.strip()
    while idx < len(text):
        try:
            obj, end_idx = decoder.raw_decode(text, idx)
            if isinstance(obj, dict) and "name" in obj and "arguments" in obj:
                results.append(obj)
            idx = end_idx
            while idx < len(text) and text[idx] in " \t\n\r":
                idx += 1
        except json.JSONDecodeError:
            break
    return results


def _coerce_text_tool_call(response):
    """Certains modèles Ollama mélangent texte + tool calls JSON dans le même contenu.
    Cherche spécifiquement le pattern {"name": pour éviter les faux positifs (code Java, etc.)."""
    if getattr(response, "tool_calls", None):
        return response
    content = getattr(response, "content", "")
    if not isinstance(content, str):
        return response
    # Cherche {"name": ou { "name": — pattern spécifique aux tool calls
    match = re.search(r'\{\s*"name"\s*:', content)
    if not match:
        return response
    tool_text = content[match.start():]
    tool_calls_data = _parse_text_tool_calls(tool_text)
    if not tool_calls_data:
        return response
    tool_calls = [
        {"id": f"call_{d['name']}_{i}", "name": d["name"], "args": d["arguments"]}
        for i, d in enumerate(tool_calls_data)
    ]
    logger.info("Text tool calls detected: %s", [t["name"] for t in tool_calls])
    return AIMessage(content="", tool_calls=tool_calls)


# ── Détection création de fichiers ───────────────────────────────────────────
_FILE_CREATION_RE = re.compile(
    r"(?:fait|fais|cr[eé][eé]?|g[eé]n[eè]re?|[eé]cri[st]|make|create|write|generate|produi[st])\s+"
    r"(?:moi\s+)?(?:un|une|deux|trois|\d+\s+)?(?:nouveau\s+|new\s+)?fichier",
    re.IGNORECASE,
)

_INFO_FILE_RE = re.compile(
    r"(?:transport|trajet|comment aller|it.?in.?raire|guide|chemin|route|horaire|ratp|rer|m[eé]tro|bus|train)",
    re.IGNORECASE,
)

_CODE_EXT_RE = re.compile(
    r"\.(?:java|py|ts|js|cs|cpp|c|rb|go|rs|html|css|php|swift|kt)\b"
    r"|fichier\s+(?:java|python|typescript|javascript|c\+\+|c#|ruby|go|rust|html|css|php|swift|kotlin)\b",
    re.IGNORECASE,
)

_TXT_EXT_RE = re.compile(r"\.txt\b|fichier\s+(?:txt|texte|text)\b", re.IGNORECASE)

_JAVA_TEMPLATE = """\
import javax.swing.*;
import java.awt.*;
import java.awt.event.*;

public class AppGraphique extends JFrame {

    private JLabel label;
    private JButton bouton;
    private JTextField champTexte;

    public AppGraphique() {
        setTitle("Application Graphique Java - Exemple");
        setSize(500, 350);
        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setLocationRelativeTo(null);
        setLayout(new BorderLayout(10, 10));

        // Panneau titre
        JPanel panneauTitre = new JPanel();
        panneauTitre.setBackground(new Color(70, 130, 180));
        label = new JLabel("Bienvenue dans l'application !");
        label.setForeground(Color.WHITE);
        label.setFont(new Font("Arial", Font.BOLD, 18));
        panneauTitre.add(label);
        add(panneauTitre, BorderLayout.NORTH);

        // Panneau central
        JPanel panneauCentral = new JPanel(new FlowLayout(FlowLayout.CENTER, 10, 20));
        JLabel lblNom = new JLabel("Votre nom :");
        champTexte = new JTextField(20);
        panneauCentral.add(lblNom);
        panneauCentral.add(champTexte);
        add(panneauCentral, BorderLayout.CENTER);

        // Panneau boutons
        JPanel panneauBas = new JPanel(new FlowLayout());
        bouton = new JButton("Dire bonjour");
        bouton.setBackground(new Color(70, 130, 180));
        bouton.setForeground(Color.WHITE);
        bouton.setFocusPainted(false);
        bouton.addActionListener(new ActionListener() {
            @Override
            public void actionPerformed(ActionEvent e) {
                String nom = champTexte.getText().trim();
                if (nom.isEmpty()) {
                    JOptionPane.showMessageDialog(AppGraphique.this,
                        "Veuillez entrer votre nom.", "Avertissement",
                        JOptionPane.WARNING_MESSAGE);
                } else {
                    label.setText("Bonjour, " + nom + " !");
                }
            }
        });

        JButton btnQuitter = new JButton("Quitter");
        btnQuitter.addActionListener(e -> System.exit(0));
        panneauBas.add(bouton);
        panneauBas.add(btnQuitter);
        add(panneauBas, BorderLayout.SOUTH);
    }

    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            AppGraphique app = new AppGraphique();
            app.setVisible(true);
        });
    }
}
"""


def _force_file_creation_if_refused(response, messages: list):
    """Force create_file ou internet_search si le modèle répond du texte
    à la place d'un tool call pour une demande de création de fichier."""
    if getattr(response, "tool_calls", None):
        return response

    # Récupère le dernier message utilisateur
    raw_query = ""
    for msg in reversed(messages):
        role = getattr(msg, "type", "") or getattr(msg, "role", "")
        if role in ("human", "user"):
            raw_query = getattr(msg, "content", "") or ""
            if isinstance(raw_query, list):
                raw_query = " ".join(
                    c.get("text", "") if isinstance(c, dict) else str(c) for c in raw_query
                )
            raw_query = str(raw_query)
            break

    if not raw_query or not _FILE_CREATION_RE.search(raw_query):
        return response

    # Anti-boucle : create_file ou internet_search déjà appelé récemment
    for msg in messages[-8:]:
        for tc in getattr(msg, "tool_calls", None) or []:
            name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
            if name in ("create_file", "internet_search"):
                return response

    tool_calls = []

    # Fichier Java ou code → create_file avec template approprié
    if _CODE_EXT_RE.search(raw_query):
        ext_match = re.search(
            r"\.?(java|py|ts|js|cs|cpp|c|rb|go|rs|html|css)\b", raw_query, re.IGNORECASE
        )
        ext = (ext_match.group(1).lower() if ext_match else "java")
        filename = f"AppExemple.{ext}"
        content = _JAVA_TEMPLATE if ext == "java" else f"# Fichier {ext} — exemple généré\n"
        tool_calls.append({
            "id": "call_create_code_file_auto",
            "name": "create_file",
            "args": {"path": filename, "content": content},
        })

    # Fichier TXT avec info web → internet_search d'abord
    if _TXT_EXT_RE.search(raw_query) or (
        "txt" not in raw_query.lower() and _INFO_FILE_RE.search(raw_query)
    ):
        # Construire une query propre depuis le message
        query, topic = _build_search_query(raw_query)
        tool_calls.append({
            "id": "call_search_for_txt_file",
            "name": "internet_search",
            "args": {"query": query, "topic": topic, "max_results": 6},
        })

    # Cas 2 : internet_search vient de tourner pour ce fichier TXT
    # mais le modèle répond encore du texte → forcer create_file avec les résultats
    if not tool_calls:
        search_result_content = ""
        for msg in reversed(messages[-6:]):
            # ToolMessage de internet_search
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            if role == "tool":
                tc_name = getattr(msg, "name", "") or ""
                if tc_name == "internet_search":
                    search_result_content = getattr(msg, "content", "") or ""
                    break

        if search_result_content and _FILE_CREATION_RE.search(raw_query):
            # Détermine le nom du fichier TXT
            txt_name = "guide.txt"
            if re.search(r"transport|trajet|it.?in.?raire", raw_query, re.IGNORECASE):
                txt_name = "transports.txt"
            content = (
                f"Guide généré par OpenAgentic Skyzer\n"
                f"Demande : {raw_query[:200]}\n"
                f"{'='*60}\n\n"
                f"{search_result_content[:3000]}"
            )
            tool_calls.append({
                "id": "call_create_txt_from_search",
                "name": "create_file",
                "args": {"path": txt_name, "content": content},
            })

    if not tool_calls:
        return response

    logger.info(
        "File creation without tool calls detected — forcing: %s",
        [t["name"] for t in tool_calls],
    )
    return AIMessage(content="", tool_calls=tool_calls)


# ── Refus recherche web ───────────────────────────────────────────────────────
_REFUSAL_WORDS_RE = re.compile(
    r"can'?t|cannot|don'?t have|do not have|unable to|no ability to"
    r"|n'ai pas|ne peux pas|ne suis pas capable|incapable|impossible"
    r"|pas la capacit|pas acc|suis d.sol",
    re.IGNORECASE,
)
_SEARCH_WORDS_RE = re.compile(
    r"internet|web|search|recherche|externe|external",
    re.IGNORECASE,
)
_NEWS_TOPIC_RE = re.compile(
    r"\b(dernier|derni.re|r.cent|actuel|news|actualit.|today|aujourd.hui|latest|last|nouveau|nouvelle)\b",
    re.IGNORECASE,
)
# Questions factuelles récentes qui nécessitent une recherche — le modèle ne doit pas répondre de mémoire
_FACTUAL_RECENT_RE = re.compile(
    r"\b(202[4-9]|"
    r"remport|vainqueur|champion|finale|score|r.sultat|classement|palmares|"
    r"a gagn.|qui a gagn.|who won|winner|"
    r"derni.re vid.o|dernier film|dernier album|sorti en|"
    r"oscar|grammy|c.sar|bafta|nobel|eurovision|"
    r"box.?office|record|meilleur vente|top.?chart)\b",
    re.IGNORECASE,
)
# Phrases de politesse/question à supprimer avant de construire la query
_QUERY_NOISE_RE = re.compile(
    r"\b(tu peux|pouvez.vous|peux.tu|est.ce que|s.il te pla.t|s.il vous pla.t|"
    r"me dire|me faire une?|faire une? recherche(?: internet| web| en ligne)?|"
    r"et me dire|et avec quels?|quels? autres?|il a fait|cette vid.o|quel(?:les?)? (?:est|sont|.tait)|"
    r"can you|could you|please|tell me|search (?:for|the)|find me|look up|"
    r"je voudrais savoir|j.aimerais savoir|donne.?moi)\b",
    re.IGNORECASE,
)


def _build_search_query(user_message: str) -> tuple[str, str]:
    """Retourne (query_nettoyée, topic) depuis le message brut de l'utilisateur."""
    cleaned = _QUERY_NOISE_RE.sub(" ", user_message)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip(" ?.,!")
    topic = "news" if _NEWS_TOPIC_RE.search(user_message) else "general"
    query = cleaned[:200] if len(cleaned) > 10 else user_message[:200]
    return query, topic


def _force_internet_search_if_refused(response, messages: list):
    """Force internet_search si le modèle refuse OU répond de mémoire à une question factuelle récente."""
    if getattr(response, "tool_calls", None):
        return response

    content = getattr(response, "content", "") or ""

    # Anti-boucle : si internet_search a déjà été appelé récemment, ne pas re-forcer
    for msg in messages[-6:]:
        for tc in getattr(msg, "tool_calls", None) or []:
            name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
            if name == "internet_search":
                return response

    # Récupère la dernière requête utilisateur
    raw_query = ""
    for msg in reversed(messages):
        role = getattr(msg, "type", "") or getattr(msg, "role", "")
        if role in ("human", "user"):
            raw_query = (getattr(msg, "content", "") or "").strip()
            if isinstance(raw_query, list):
                raw_query = " ".join(
                    c.get("text", "") if isinstance(c, dict) else str(c) for c in raw_query
                )
            raw_query = str(raw_query)
            break

    if not raw_query:
        return response

    # Cas 1 : refus explicite de chercher sur internet
    if _REFUSAL_WORDS_RE.search(content) and _SEARCH_WORDS_RE.search(content):
        query, topic = _build_search_query(raw_query)
        logger.info("Internet search refusal detected — forcing internet_search(query=%r, topic=%s)", query, topic)
        return AIMessage(
            content="",
            tool_calls=[{
                "id": "call_internet_search_auto",
                "name": "internet_search",
                "args": {"query": query, "topic": topic, "max_results": 8},
            }],
        )

    # Cas 2 : question factuelle récente répondue de mémoire sans aucun outil
    # (ex : "qui a remporté la Champions League 2025 ?" → modèle invente de mémoire)
    # Guard : si le pré-fetch de input_bar a déjà injecté des résultats dans le message,
    # ne pas re-chercher (le message commence par "RÉSULTATS DE RECHERCHE WEB")
    prefetch_already_done = raw_query.startswith("RÉSULTATS DE RECHERCHE WEB")
    if not prefetch_already_done and _FACTUAL_RECENT_RE.search(raw_query):
        query, topic = _build_search_query(raw_query)
        topic = "news"
        logger.info("Factual recent question detected — forcing internet_search(query=%r)", query)
        return AIMessage(
            content="",
            tool_calls=[{
                "id": "call_internet_search_factual",
                "name": "internet_search",
                "args": {"query": query, "topic": topic, "max_results": 8},
            }],
        )

    return response


def make_agent_node(
    model,
    system_prompt: str,
    max_history: int = 20,
    max_tokens: int | None = None,
    lmstudio_compat: bool = False,
):
    """Return an agent node closure bound to the given model and system prompt.

    Before each LLM call:
    - Trims history to last max_history messages and max_tokens
    - Cleans LLM metadata bloat from additional_kwargs
    - Prepends the system prompt fresh

    lmstudio_compat: quand True, fusionne le SystemMessage dans le premier HumanMessage
    au lieu de le laisser en tête — contourne le bug Jinja de certains modèles LM Studio
    qui ne peuvent pas injecter les tool definitions quand le premier message n'est pas human.
    """
    from langchain_core.messages import HumanMessage

    def agent_node(state: AgentState) -> dict:
        messages = state["messages"]

        trimmed = trim_message_history(messages, max_messages=max_history, max_tokens=max_tokens)
        trimmed = clean_messages(trimmed)

        if lmstudio_compat:
            # Cherche le premier HumanMessage dans trimmed
            first_human = next(
                (i for i, m in enumerate(trimmed) if getattr(m, "type", "") == "human"), None
            )
            if first_human is not None:
                original = trimmed[first_human].content or ""
                merged = f"<system>\n{system_prompt}\n</system>\n\n{original}"
                trimmed = list(trimmed)
                trimmed[first_human] = HumanMessage(content=merged)
                full_context = trimmed
            else:
                # Pas de HumanMessage encore — fallback classique
                full_context = [SystemMessage(content=system_prompt)] + trimmed
        else:
            full_context = [SystemMessage(content=system_prompt)] + trimmed

        logger.info(
            "LLM call — history: %d msgs (trimmed from %d)",
            len(trimmed), len(messages),
        )

        response = model.invoke(full_context)
        response = _coerce_text_tool_call(response)
        response = _force_internet_search_if_refused(response, trimmed)
        response = _force_file_creation_if_refused(response, trimmed)
        return {"messages": [response]}

    return agent_node


# ── Nœuds Phase 16 — Intelligence Amplification ──────────────────────────────

def make_reasoning_node(model):
    """Factory : retourne un nœud LangGraph qui génère le CoT interne avant le LLM."""

    def reasoning_node(state: AgentState) -> dict:
        raw = next(
            (m.content for m in reversed(state["messages"])
             if isinstance(m, HumanMessage)),
            "",
        )
        if isinstance(raw, list):
            last_user_msg = " ".join(
                c.get("text", "") if isinstance(c, dict) else str(c) for c in raw
            )
        else:
            last_user_msg = raw or ""
        analysis = analyze_complexity(last_user_msg, len(state["messages"]))

        result: dict = {
            "reasoning_mode": analysis.mode,
            "task_type": analysis.task_type,
            "reasoning_scratchpad": "",
            "confidence_score": 3,
            "critique_result": "",
            "needs_correction": False,
            "critique_iterations": 0,
        }

        if analysis.mode not in ("complex", "critical"):
            return result

        template_extra = REASONING_TEMPLATES.get(analysis.task_type, "")
        cot_prompt = COT_PROMPT.format(
            message=last_user_msg[:1500],
            template_extra=template_extra,
        )

        try:
            cot_response = model.invoke([
                SystemMessage(content="Tu es un assistant expert en raisonnement structuré."),
                HumanMessage(content=cot_prompt),
            ])
            reasoning = cot_response.content or ""
        except Exception as exc:
            logger.warning(
                "reasoning_node: LLM CoT call failed (%s: %s) — fallback to empty scratchpad",
                type(exc).__name__, exc,
            )
            return result

        result["reasoning_scratchpad"] = reasoning
        result["messages"] = [
            SystemMessage(content=COT_SYSTEM_INJECT.format(reasoning=reasoning))
        ]
        return result

    return reasoning_node


def route_after_agent(state: AgentState) -> str:
    """Route to tools if the last AI message has tool calls, otherwise end."""
    last = state["messages"][-1]
    if getattr(last, "tool_calls", None):
        return "tools"
    return END
