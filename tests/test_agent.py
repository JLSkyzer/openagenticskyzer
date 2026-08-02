# tests/test_agent.py
"""Tests de la surface d'outils de l'agent (`build_agent` / `build_graph`).

Régression couverte : `trigger_compact` (app/components/context_bar.py)
construisait son résumeur via `build_agent(mode="ask", ...)` sans
`permission_manager`. `build_agent` bindait alors TOUTE la surface `_ALL_TOOLS`
(run_command, delete_file, git_push…) et `build_graph`, faute de
permission_manager, montait un `ToolNode(_ALL_TOOLS)` nu — exécution d'outils
sans aucun contrôle, déclenchée automatiquement et sans surveillance, sur une
entrée dérivée de l'historique de conversation (donc de contenu web/fichiers
potentiellement porteur d'une injection de prompt).
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage

import openagenticskyzer.agent as agent_module
from openagenticskyzer.graph.workflow import _noop_tool_node, build_graph


def _mock_model():
    model = MagicMock()
    model.bind_tools.return_value = model
    model.invoke.return_value = AIMessage(content="résumé")
    return model


def _tool_node_of(compiled):
    """Récupère la fonction réellement câblée sur le nœud 'tools' du graphe
    compilé (LangGraph expose les nœuds via `.nodes`)."""
    node = compiled.nodes["tools"]
    runnable = getattr(node, "bound", node)
    return getattr(runnable, "func", runnable)


class TestBuildGraphEmptyToolSurface:

    def test_empty_tools_never_binds_tools_to_the_model(self):
        model = _mock_model()
        build_graph(model=model, tools=[], system_prompt="S")
        assert not model.bind_tools.called

    def test_non_empty_tools_still_binds(self):
        model = _mock_model()
        build_graph(model=model, tools=agent_module._ALL_TOOLS, system_prompt="S")
        model.bind_tools.assert_called_once()
        assert model.bind_tools.call_args[0][0] == agent_module._ALL_TOOLS

    def test_empty_tools_wires_the_noop_tool_node(self):
        model = _mock_model()
        compiled = build_graph(model=model, tools=[], system_prompt="S")
        assert _tool_node_of(compiled) is _noop_tool_node

    def test_empty_tools_wins_over_a_permission_manager(self):
        """Une liste vide ne doit jamais produire un nœud d'exécution d'outils,
        même si un permission_manager est fourni."""
        from openagenticskyzer.permissions import PermissionManager

        model = _mock_model()
        compiled = build_graph(
            model=model, tools=[], system_prompt="S",
            permission_manager=PermissionManager(mode="auto", is_cli=True),
        )
        assert _tool_node_of(compiled) is _noop_tool_node

    def test_noop_tool_node_executes_nothing(self):
        """Même atteint, le nœud vide n'exécute aucun outil et ne renvoie rien."""
        assert _noop_tool_node({"messages": [
            AIMessage(content="", tool_calls=[
                {"name": "run_command", "args": {"command": "rm -rf /"}, "id": "tc1"},
            ]),
        ]}) == {}


class TestBuildAgentToolsParameter:

    def _capture_build_graph(self, monkeypatch) -> list:
        captured: list = []
        monkeypatch.setattr(agent_module, "get_llm", lambda **kw: _mock_model())
        monkeypatch.setattr(
            agent_module, "build_graph",
            lambda model, tools, system_prompt, **kw: captured.append(tools)
            or SimpleNamespace(),
        )
        return captured

    def test_default_keeps_the_full_tool_surface(self, monkeypatch):
        captured = self._capture_build_graph(monkeypatch)
        agent_module.build_agent()
        assert captured == [agent_module._ALL_TOOLS]

    def test_explicit_empty_list_yields_no_tools(self, monkeypatch):
        captured = self._capture_build_graph(monkeypatch)
        agent_module.build_agent(mode="ask", tools=[])
        assert captured == [[]]

    def test_all_tools_list_is_not_empty(self):
        """Garde-fou : le défaut doit rester la surface complète (sinon le test
        ci-dessus passerait trivialement)."""
        assert len(agent_module._ALL_TOOLS) > 10
