"""Tests de qualité LLM avec DeepEval.

Ces tests évaluent la qualité des sorties du pipeline d'agent en utilisant
un LLM-juge (par défaut GPT-4o via OPENAI_API_KEY, ou tout modèle configuré
dans deepeval). Ils sont marqués `llm_eval` pour pouvoir être sautés si
aucune clé API de juge n'est disponible.

Exécution :
    pytest tests/test_deepeval_quality.py -v
    pytest tests/test_deepeval_quality.py -v -m "not llm_eval"  # sans juge LLM
"""

import pytest
from unittest.mock import MagicMock

from deepeval import assert_test
from deepeval.metrics import GEval, AnswerRelevancyMetric
from deepeval.metrics.g_eval import GEvalMetric  # noqa: F401 – import optionnel
from deepeval.test_case import LLMTestCase, LLMTestCaseParams

from openagentic_ai.utils.utils import mode_router
from openagentic_ai.prompts.prompt import DEEP_AGENT_SYSTEM_PROMPT
from openagentic_ai.context.messages import trim_message_history, clean_messages
from openagentic_ai.graph.nodes import make_agent_node, route_after_agent


# ---------------------------------------------------------------------------
# Marqueur pytest pour les tests nécessitant un juge LLM
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.llm_eval


# ---------------------------------------------------------------------------
# 1. Qualité du prompt système
# ---------------------------------------------------------------------------

class TestSystemPromptQuality:
    """Valide que DEEP_AGENT_SYSTEM_PROMPT contient les instructions essentielles."""

    def test_system_prompt_is_instruction_focused(self):
        """Le prompt système doit exprimer un rôle d'assistant et des règles claires."""
        test_case = LLMTestCase(
            input="Décris le rôle de l'agent.",
            actual_output=DEEP_AGENT_SYSTEM_PROMPT,
        )
        metric = GEval(
            name="Qualité du prompt système",
            criteria=(
                "Le texte doit : (1) définir clairement un rôle d'assistant, "
                "(2) contenir des règles ou instructions d'utilisation des outils, "
                "(3) être rédigé sous forme d'instructions impératives."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.6,
        )
        assert_test(test_case, [metric])

    def test_system_prompt_mentions_tools(self):
        """Le prompt système doit lister des outils disponibles."""
        test_case = LLMTestCase(
            input="Quels outils sont disponibles ?",
            actual_output=DEEP_AGENT_SYSTEM_PROMPT,
        )
        metric = GEval(
            name="Mention des outils",
            criteria=(
                "Le texte doit mentionner explicitement au moins 5 outils différents "
                "avec leurs noms (ex. create_file, run_command, edit_file, etc.)."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.7,
        )
        assert_test(test_case, [metric])

    def test_system_prompt_has_no_contradictory_instructions(self):
        """Le prompt système ne doit pas contenir d'instructions contradictoires."""
        test_case = LLMTestCase(
            input="Ces instructions sont-elles cohérentes ?",
            actual_output=DEEP_AGENT_SYSTEM_PROMPT,
        )
        metric = GEval(
            name="Cohérence du prompt",
            criteria=(
                "Le texte ne doit pas contenir d'instructions qui se contredisent "
                "directement (ex. 'fais X' et 'ne fais jamais X' dans le même contexte)."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.7,
        )
        assert_test(test_case, [metric])


# ---------------------------------------------------------------------------
# 2. Qualité des prompts de mode (mode_router)
# ---------------------------------------------------------------------------

class TestModePromptQuality:
    """Vérifie que chaque mode génère un prompt pertinent et bien ciblé."""

    def test_ask_mode_restricts_modifications(self):
        """Le mode 'ask' doit clairement interdire les modifications."""
        output = mode_router("ask")
        test_case = LLMTestCase(
            input="Que peut faire l'agent en mode 'ask' ?",
            actual_output=output,
        )
        metric = GEval(
            name="Mode ask — restriction",
            criteria=(
                "La sortie doit clairement indiquer que l'agent NE DOIT PAS "
                "modifier des fichiers ni exécuter des commandes. "
                "Elle doit limiter l'agent à répondre aux questions uniquement."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.7,
        )
        assert_test(test_case, [metric])

    def test_auto_mode_enables_autonomous_work(self):
        """Le mode 'auto' doit autoriser les actions autonomes."""
        output = mode_router("auto")
        test_case = LLMTestCase(
            input="Que peut faire l'agent en mode 'auto' ?",
            actual_output=output,
        )
        metric = GEval(
            name="Mode auto — autonomie",
            criteria=(
                "La sortie doit indiquer que l'agent peut travailler de manière "
                "autonome : éditer des fichiers, exécuter des commandes, "
                "planifier et accomplir des tâches sans confirmation manuelle."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.7,
        )
        assert_test(test_case, [metric])

    def test_plan_mode_requires_approval(self):
        """Le mode 'plan' doit exiger une approbation avant d'agir."""
        output = mode_router("plan")
        test_case = LLMTestCase(
            input="Que fait l'agent en mode 'plan' ?",
            actual_output=output,
        )
        metric = GEval(
            name="Mode plan — approbation",
            criteria=(
                "La sortie doit indiquer que l'agent doit d'abord produire un plan "
                "détaillé et attendre l'approbation de l'utilisateur avant de "
                "procéder à toute modification ou commande."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.7,
        )
        assert_test(test_case, [metric])

    @pytest.mark.parametrize("mode", ["ask", "auto", "plan"])
    def test_mode_prompts_are_concise(self, mode):
        """Chaque prompt de mode doit être concis (< 200 caractères)."""
        output = mode_router(mode)
        test_case = LLMTestCase(
            input=f"Évalue la concision du prompt de mode '{mode}'.",
            actual_output=output,
        )
        metric = GEval(
            name=f"Concision mode {mode}",
            criteria=(
                "La sortie doit être une instruction concise et directe, "
                "sans répétitions ni informations superflues. "
                "Elle doit tenir en une seule phrase ou deux courtes phrases maximum."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.6,
        )
        assert_test(test_case, [metric])


# ---------------------------------------------------------------------------
# 3. Qualité des sorties du nœud agent (LLM mocké)
# ---------------------------------------------------------------------------

class TestAgentNodeOutputQuality:
    """Valide la pertinence des réponses générées par le nœud agent."""

    def _make_node_response(self, user_query: str, agent_response: str) -> LLMTestCase:
        """Construit un LLMTestCase à partir d'une paire (question, réponse)."""
        return LLMTestCase(
            input=user_query,
            actual_output=agent_response,
        )

    def test_coding_question_relevancy(self):
        """Une question de code doit obtenir une réponse pertinente."""
        test_case = self._make_node_response(
            user_query="Comment lire un fichier JSON en Python ?",
            agent_response=(
                "Pour lire un fichier JSON en Python, utilisez le module `json` :\n\n"
                "```python\nimport json\n\nwith open('data.json', 'r') as f:\n"
                "    data = json.load(f)\n```\n"
                "`json.load()` désérialise le fichier directement en dict/liste Python."
            ),
        )
        metric = AnswerRelevancyMetric(threshold=0.7)
        assert_test(test_case, [metric])

    def test_file_edit_response_correctness(self):
        """La réponse à une demande d'édition doit être claire et actionnable."""
        test_case = self._make_node_response(
            user_query="Remplace la fonction `old_func` par `new_func` dans main.py.",
            agent_response=(
                "J'utilise `edit_file` pour remplacer `old_func` par `new_func` "
                "dans `main.py`. La modification est effectuée avec succès."
            ),
        )
        metric = GEval(
            name="Réponse d'édition de fichier",
            criteria=(
                "La réponse doit : (1) indiquer l'outil utilisé pour effectuer "
                "la modification, (2) confirmer que la tâche a été accomplie, "
                "(3) être directe sans détails superflus."
            ),
            evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.6,
        )
        assert_test(test_case, [metric])

    def test_error_response_is_helpful(self):
        """La réponse à une erreur doit proposer une solution concrète."""
        test_case = self._make_node_response(
            user_query="La commande `pnpm run build` échoue avec une erreur TypeScript.",
            agent_response=(
                "Je lis le message d'erreur complet avec `read_file` puis j'identifie "
                "les fichiers concernés. Je corrige les erreurs de type une par une "
                "avec `edit_file`, puis je relance `pnpm exec tsc --noEmit` pour "
                "vérifier que toutes les erreurs sont résolues."
            ),
        )
        metric = GEval(
            name="Utilité de la réponse d'erreur",
            criteria=(
                "La réponse doit proposer une démarche de diagnostic structurée : "
                "(1) lire l'erreur, (2) identifier la cause, (3) proposer une correction "
                "concrète. Elle ne doit pas se contenter de répéter l'erreur."
            ),
            evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.6,
        )
        assert_test(test_case, [metric])


# ---------------------------------------------------------------------------
# 4. Tests de non-régression — comportement du pipeline de messages
# ---------------------------------------------------------------------------

class TestMessagePipelineQuality:
    """Valide que le pipeline de trim + clean produit un contexte de qualité."""

    def test_trimmed_context_is_coherent(self):
        """Après trim, le contexte doit rester cohérent (pas de ToolMessage orphelin)."""
        from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

        msgs = (
            [HumanMessage(content=f"Question {i}") for i in range(15)]
            + [AIMessage(content="appel outil",
                         tool_calls=[{"name": "t", "args": {}, "id": "tc1"}])]
            + [ToolMessage(content="résultat", tool_call_id="tc1")]
            + [HumanMessage(content="suite")]
        )
        trimmed = trim_message_history(msgs, max_messages=5)

        # Représentation textuelle du contexte trimé
        context_repr = "\n".join(
            f"[{type(m).__name__}] {m.content[:80]}" for m in trimmed
        )

        test_case = LLMTestCase(
            input="Le contexte suivant est-il cohérent pour un LLM ?",
            actual_output=context_repr,
        )
        metric = GEval(
            name="Cohérence du contexte trimé",
            criteria=(
                "Le contexte ne doit pas commencer par un ToolMessage sans "
                "AIMessage parent. L'ordre des messages doit suivre une logique "
                "de conversation (humain → IA → outil → humain → IA...)."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.7,
        )
        assert_test(test_case, [metric])

    def test_cleaned_messages_have_no_bloat(self):
        """Les messages nettoyés ne doivent pas contenir de métadonnées LLM internes."""
        from langchain_core.messages import AIMessage

        ai_msg = AIMessage(
            content="Réponse utile.",
            additional_kwargs={
                "__gemini_thinking__": "réflexion interne très longue...",
                "tool_calls": [],
            },
        )
        cleaned = clean_messages([ai_msg])
        cleaned_repr = str(cleaned[0].additional_kwargs)

        test_case = LLMTestCase(
            input="Ces métadonnées sont-elles propres ?",
            actual_output=cleaned_repr,
        )
        metric = GEval(
            name="Absence de métadonnées parasites",
            criteria=(
                "Le texte ne doit pas contenir de clés liées aux processus internes "
                "du LLM comme '__gemini_thinking__', 'raw_response', "
                "'system_fingerprint' ou '__mistral_thinking__'."
            ),
            evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
            threshold=0.8,
        )
        assert_test(test_case, [metric])
