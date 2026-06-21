# Analytics, API Server, Recherche, Résilience & Budget — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter le suivi des coûts API, le dashboard d'usage, l'audit log, le serveur API REST local, les webhooks entrants, la recherche de conversations, le système de fallback de modèles (circuit breaker) et le budget avec limites (Phases 12 + 13 + 17 + 19 + 20).

**Architecture:** Nouveaux fichiers `app/cost_tracker.py`, `app/analytics.py`, `context/audit_log.py`, `api_server.py`, `webhooks.py`, `context/conversation_search.py`, `agent/resilience.py`, `app/budget.py`, `app/portability.py`. Nouveau composant `app/components/search_panel.py`. Modifications `state.py`, `context_bar.py`, `settings.py`, `agent.py`.

**Tech Stack:** Python 3.11+, FastAPI + uvicorn (optionnel), NiceGUI, pytest, zipfile, json, collections.Counter

---

## Structure des fichiers

| Fichier | Action | Rôle |
|---------|--------|------|
| `openagenticskyzer/app/cost_tracker.py` | Créer | Estimation coûts API par provider/modèle |
| `openagenticskyzer/app/analytics.py` | Créer | Agrégation métriques usage depuis sessions |
| `openagenticskyzer/context/audit_log.py` | Créer | Audit log JSONL horodaté |
| `openagenticskyzer/context/conversation_search.py` | Créer | Recherche dans sessions JSONL |
| `openagenticskyzer/app/components/search_panel.py` | Créer | Composant UI recherche |
| `openagenticskyzer/agent/resilience.py` | Créer | Circuit breaker + fallback chain |
| `openagenticskyzer/agent/__init__.py` | Créer | Package agent |
| `openagenticskyzer/app/budget.py` | Créer | Budget journalier/mensuel + alertes |
| `openagenticskyzer/app/portability.py` | Créer | Export/import config ZIP |
| `openagenticskyzer/api_server.py` | Créer | FastAPI REST server port 8767 |
| `openagenticskyzer/webhooks.py` | Créer | Webhooks entrants avec HMAC |
| `openagenticskyzer/app/state.py` | Modifier | session_input_tokens, cost fields |
| `openagenticskyzer/app/components/context_bar.py` | Modifier | Affichage coût session |
| `openagenticskyzer/app/components/settings.py` | Modifier | Onglets Analytics, Budget, Données |
| `openagenticskyzer/app/components/sidebar.py` | Modifier | Bouton recherche |
| `tests/test_infrastructure.py` | Créer | Tests cost_tracker, audit_log, search, budget, resilience |

---

## Task 1 : Suivi des coûts API (Phase 12.1)

**Files:**
- Create: `openagenticskyzer/app/cost_tracker.py`
- Modify: `openagenticskyzer/app/state.py`
- Modify: `openagenticskyzer/app/components/context_bar.py`
- Test: `tests/test_infrastructure.py`

- [ ] **Step 1 : Écrire les tests**

```python
# tests/test_infrastructure.py
"""Tests analytics, budget, recherche, résilience."""
import pytest


class TestCostTracker:
    def test_estimate_cost_groq(self):
        from openagenticskyzer.app.cost_tracker import estimate_cost
        cost = estimate_cost("groq", "llama-3.3-70b-versatile", 1_000_000, 1_000_000)
        assert cost == pytest.approx(0.59 + 0.79, rel=0.01)

    def test_estimate_cost_local_is_zero(self):
        from openagenticskyzer.app.cost_tracker import estimate_cost
        assert estimate_cost("ollama", "llama3:8b", 1000, 1000) == 0.0
        assert estimate_cost("lmstudio", "any", 1000, 1000) == 0.0

    def test_estimate_cost_unknown_model_is_zero(self):
        from openagenticskyzer.app.cost_tracker import estimate_cost
        assert estimate_cost("groq", "unknown-model-xyz", 1000, 1000) == 0.0

    def test_format_cost_zero(self):
        from openagenticskyzer.app.cost_tracker import format_cost
        assert "gratuit" in format_cost(0.0).lower() or format_cost(0.0) == "gratuit (local)"

    def test_format_cost_nonzero(self):
        from openagenticskyzer.app.cost_tracker import format_cost
        result = format_cost(0.05)
        assert "$" in result
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```
pytest tests/test_infrastructure.py::TestCostTracker -v
```
Attendu : FAIL

- [ ] **Step 3 : Créer `cost_tracker.py`**

```python
# openagenticskyzer/app/cost_tracker.py
"""Estimation du coût des appels LLM par provider/modèle."""

# Prix en USD par million de tokens (input / output)
PRICING: dict[str, dict[str, tuple[float, float]]] = {
    "groq": {
        "llama-3.3-70b-versatile":    (0.59, 0.79),
        "llama-3.1-8b-instant":       (0.05, 0.08),
        "mixtral-8x7b-32768":         (0.24, 0.24),
        "gemma2-9b-it":               (0.20, 0.20),
    },
    "mistral": {
        "mistral-large-latest":       (2.00, 6.00),
        "mistral-small-latest":       (0.20, 0.60),
        "codestral-latest":           (0.20, 0.60),
        "open-mistral-7b":            (0.25, 0.25),
    },
    "together": {
        "meta-llama/Llama-3.3-70B":  (0.88, 0.88),
        "mistralai/Mixtral-8x7B":     (0.60, 0.60),
    },
    "gemini": {
        "gemini-2.0-flash":           (0.075, 0.30),
        "gemini-1.5-pro":             (1.25, 5.00),
    },
    "openrouter": {},
    "ollama":   {},
    "lmstudio": {},
}


def estimate_cost(provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
    """Retourne le coût estimé en USD."""
    rates = PRICING.get(provider, {}).get(model)
    if not rates:
        return 0.0
    input_rate, output_rate = rates
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000


def format_cost(usd: float) -> str:
    if usd == 0.0:
        return "gratuit (local)"
    if usd < 0.001:
        return "< $0.001"
    return f"${usd:.4f}"
```

- [ ] **Step 4 : Ajouter champs dans `state.py`**

```python
session_input_tokens: int = 0
session_output_tokens: int = 0
session_cost_usd: float = 0.0
total_cost_usd: float = 0.0
```

- [ ] **Step 5 : Afficher le coût dans `context_bar.py`**

```python
from openagenticskyzer.app.cost_tracker import format_cost

# À ajouter dans le rendu de la context_bar, à côté des autres labels :
if state.session_cost_usd > 0 or (state.current_provider not in ("ollama", "lmstudio", None, "")):
    ui.label(format_cost(state.session_cost_usd)).classes("text-xs text-gray-600 ml-2").tooltip(
        f"Coût total toutes sessions : {format_cost(state.total_cost_usd)}"
    )
```

- [ ] **Step 6 : Lancer les tests**

```
pytest tests/test_infrastructure.py::TestCostTracker -v
```
Attendu : 5 PASS

- [ ] **Step 7 : Commit**

```bash
rtk git add openagenticskyzer/app/cost_tracker.py openagenticskyzer/app/state.py openagenticskyzer/app/components/context_bar.py tests/test_infrastructure.py
rtk git commit -m "feat: API cost tracker + session cost display (Phase 12.1)"
```

---

## Task 2 : Dashboard analytics + Audit Log (Phase 12.2 + 12.3)

**Files:**
- Create: `openagenticskyzer/app/analytics.py`
- Create: `openagenticskyzer/context/audit_log.py`
- Modify: `openagenticskyzer/app/components/settings.py`
- Test: `tests/test_infrastructure.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_infrastructure.py`, ajouter :

```python
class TestAnalytics:
    def test_compute_stats_empty(self, tmp_path, monkeypatch):
        import openagenticskyzer.app.analytics as ana
        monkeypatch.setattr(ana, "_sessions_dir", lambda: tmp_path)
        stats = ana.compute_stats()
        assert stats["session_count"] == 0
        assert stats["total_tokens"] == 0

    def test_compute_stats_reads_sessions(self, tmp_path, monkeypatch):
        import json
        import openagenticskyzer.app.analytics as ana
        monkeypatch.setattr(ana, "_sessions_dir", lambda: tmp_path)
        session = {
            "total_tokens": 500,
            "cost_usd": 0.01,
            "provider": "groq",
            "messages": [{"role": "tool", "tool_name": "read_file"}],
        }
        (tmp_path / "sess1.json").write_text(json.dumps(session), encoding="utf-8")
        stats = ana.compute_stats()
        assert stats["session_count"] == 1
        assert stats["total_tokens"] == 500
        assert stats["top_tools"][0][0] == "read_file"


class TestAuditLog:
    def test_log_action_creates_file(self, tmp_path, monkeypatch):
        import openagenticskyzer.context.audit_log as al
        monkeypatch.setattr(al, "_audit_path", lambda: tmp_path / "audit.jsonl")
        al.log_action("edit_file", {"path": "test.py"}, "ok", folder="/tmp")
        content = (tmp_path / "audit.jsonl").read_text(encoding="utf-8")
        import json
        entry = json.loads(content.strip())
        assert entry["tool"] == "edit_file"
        assert "ts" in entry
```

- [ ] **Step 2 : Créer `analytics.py`**

```python
# openagenticskyzer/app/analytics.py
"""Agrégation des métriques d'usage depuis les sessions sauvegardées."""
import json
from collections import Counter
from pathlib import Path


def _sessions_dir() -> Path:
    from openagenticskyzer.app.storage import _sessions_dir as _sd
    return _sd()


def compute_stats() -> dict:
    sessions_path = _sessions_dir()
    tool_counts: Counter = Counter()
    total_tokens = 0
    total_cost = 0.0
    session_count = 0
    providers_used: Counter = Counter()

    if not sessions_path.exists():
        return {
            "session_count": 0,
            "total_tokens": 0,
            "total_cost_usd": 0.0,
            "top_tools": [],
            "providers": {},
        }

    for path in sessions_path.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            session_count += 1
            total_tokens += data.get("total_tokens", 0)
            total_cost += data.get("cost_usd", 0.0)
            providers_used[data.get("provider", "unknown")] += 1
            for msg in data.get("messages", []):
                if msg.get("role") == "tool" and msg.get("tool_name"):
                    tool_counts[msg["tool_name"]] += 1
        except Exception:
            continue

    return {
        "session_count": session_count,
        "total_tokens": total_tokens,
        "total_cost_usd": total_cost,
        "top_tools": tool_counts.most_common(10),
        "providers": dict(providers_used),
    }
```

- [ ] **Step 3 : Créer `audit_log.py`**

```python
# openagenticskyzer/context/audit_log.py
"""Audit log — enregistre chaque action agent avec timestamp."""
import json
from datetime import datetime
from pathlib import Path


def _audit_path() -> Path:
    from openagenticskyzer.app.storage import get_data_home
    p = get_data_home() / "audit.jsonl"
    return p


def log_action(tool_name: str, args: dict, result_summary: str, folder: str = "") -> None:
    """Enregistre une action dans l'audit log (JSONL)."""
    entry = {
        "ts": datetime.now().isoformat(),
        "tool": tool_name,
        "args": {k: str(v)[:200] for k, v in args.items()},
        "result": result_summary[:300],
        "folder": folder,
    }
    path = _audit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read_audit_log(n: int = 100) -> list[dict]:
    """Retourne les n dernières entrées de l'audit log."""
    path = _audit_path()
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    entries = []
    for line in lines[-n:]:
        try:
            entries.append(json.loads(line))
        except Exception:
            continue
    return list(reversed(entries))
```

- [ ] **Step 4 : Ajouter onglet "📈 Statistiques" dans `settings.py`**

```python
def _tab_analytics():
    from openagenticskyzer.app.analytics import compute_stats
    from openagenticskyzer.app.cost_tracker import format_cost

    stats = compute_stats()
    _section("Vue d'ensemble")
    with ui.grid(columns=3).classes("w-full px-4 gap-3"):
        _stat_card("Sessions", str(stats["session_count"]))
        _stat_card("Tokens total", f"{stats['total_tokens']:,}")
        _stat_card("Coût total", format_cost(stats["total_cost_usd"]))

    if stats["top_tools"]:
        _section("Outils les plus utilisés")
        max_count = stats["top_tools"][0][1]
        for tool_name, count in stats["top_tools"]:
            with ui.row().classes("px-4 items-center gap-2"):
                ui.label(tool_name).classes("text-xs text-gray-400 font-mono w-32 truncate")
                with ui.element("div").classes("flex-1 h-1.5 bg-gray-800 rounded"):
                    pct = count / max_count * 100
                    ui.element("div").classes("h-1.5 bg-purple-600 rounded").style(f"width:{pct:.0f}%")
                ui.label(str(count)).classes("text-xs text-gray-600 w-8 text-right")

    if stats["providers"]:
        _section("Providers utilisés")
        for provider, count in stats["providers"].items():
            ui.label(f"{provider}: {count} sessions").classes("text-xs text-gray-500 px-4")


def _stat_card(label: str, value: str):
    with ui.card().classes("bg-gray-900 border border-gray-800 rounded-xl p-3 text-center"):
        ui.label(value).classes("text-base text-gray-200 font-bold")
        ui.label(label).classes("text-xs text-gray-600")
```

- [ ] **Step 5 : Lancer les tests**

```
pytest tests/test_infrastructure.py::TestAnalytics tests/test_infrastructure.py::TestAuditLog -v
```
Attendu : 4 PASS

- [ ] **Step 6 : Commit**

```bash
rtk git add openagenticskyzer/app/analytics.py openagenticskyzer/context/audit_log.py openagenticskyzer/app/components/settings.py tests/test_infrastructure.py
rtk git commit -m "feat: usage analytics dashboard + audit log (Phase 12.2-12.3)"
```

---

## Task 3 : Recherche de conversations (Phase 17)

**Files:**
- Create: `openagenticskyzer/context/conversation_search.py`
- Create: `openagenticskyzer/app/components/search_panel.py`
- Modify: `openagenticskyzer/app/components/sidebar.py`
- Test: `tests/test_infrastructure.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_infrastructure.py`, ajouter :

```python
class TestConversationSearch:
    def _write_session(self, tmp_path, session_id, messages, date="2026-04-01", project=None):
        import json
        sessions_dir = tmp_path / "sessions"
        sessions_dir.mkdir(exist_ok=True)
        lines = [json.dumps({"type": "meta", "date": date, "project": project})]
        lines += [json.dumps(m) for m in messages]
        (sessions_dir / f"{session_id}.jsonl").write_text("\n".join(lines), encoding="utf-8")

    def test_finds_message_by_keyword(self, tmp_path, monkeypatch):
        import openagenticskyzer.context.conversation_search as cs
        monkeypatch.setattr(cs, "SESSIONS_DIR", str(tmp_path / "sessions"))
        self._write_session(tmp_path, "sess1", [
            {"role": "user", "content": "Comment utiliser pandas pour lire un CSV ?"},
            {"role": "assistant", "content": "Utilise pd.read_csv(path)"},
        ])
        results = cs.search_conversations("pandas")
        assert len(results) == 2
        assert any("pandas" in r.excerpt for r in results)

    def test_filter_by_date(self, tmp_path, monkeypatch):
        import openagenticskyzer.context.conversation_search as cs
        monkeypatch.setattr(cs, "SESSIONS_DIR", str(tmp_path / "sessions"))
        self._write_session(tmp_path, "old", [{"role": "user", "content": "pandas test"}], date="2025-01-01")
        self._write_session(tmp_path, "new", [{"role": "user", "content": "pandas test"}], date="2026-04-01")
        results = cs.search_conversations("pandas", date_from="2026-01-01")
        assert all(r.session_date >= "2026-01-01" for r in results)
        assert len(results) == 1

    def test_no_results_when_empty(self, tmp_path, monkeypatch):
        import openagenticskyzer.context.conversation_search as cs
        monkeypatch.setattr(cs, "SESSIONS_DIR", str(tmp_path / "sessions"))
        results = cs.search_conversations("keyword")
        assert results == []
```

- [ ] **Step 2 : Créer `conversation_search.py`**

```python
# openagenticskyzer/context/conversation_search.py
"""Recherche dans l'historique des sessions de conversation."""
import json
import re
from dataclasses import dataclass
from pathlib import Path

# Sera surchargé par monkeypatch dans les tests
try:
    from openagenticskyzer.app.storage import _sessions_dir as _sd
    SESSIONS_DIR = str(_sd())
except Exception:
    SESSIONS_DIR = str(Path.home() / ".openagent" / "sessions")


@dataclass
class SearchResult:
    session_id: str
    session_date: str
    project: str | None
    role: str
    excerpt: str
    match_count: int


def search_conversations(
    query: str,
    project_filter: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    max_results: int = 20,
) -> list[SearchResult]:
    """Cherche dans tous les fichiers de sessions JSONL."""
    pattern = re.compile(re.escape(query), re.IGNORECASE)
    results: list[SearchResult] = []

    sessions_path = Path(SESSIONS_DIR)
    if not sessions_path.exists():
        return []

    for session_file in sorted(sessions_path.glob("*.jsonl"), reverse=True):
        try:
            lines = session_file.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue

        session_meta: dict = {}
        messages: list[dict] = []
        for line in lines:
            try:
                obj = json.loads(line)
                if obj.get("type") == "meta":
                    session_meta = obj
                elif obj.get("role") in ("user", "assistant"):
                    messages.append(obj)
            except json.JSONDecodeError:
                continue

        session_date = session_meta.get("date", session_file.stem[:10])
        project = session_meta.get("project")

        if date_from and session_date < date_from:
            continue
        if date_to and session_date > date_to:
            continue
        if project_filter and project != project_filter:
            continue

        for msg in messages:
            content = msg.get("content", "")
            matches = list(pattern.finditer(content))
            if not matches:
                continue
            m = matches[0]
            start = max(0, m.start() - 80)
            end = min(len(content), m.end() + 120)
            excerpt = ("..." if start > 0 else "") + content[start:end] + ("..." if end < len(content) else "")
            results.append(SearchResult(
                session_id=session_file.stem,
                session_date=session_date,
                project=project,
                role=msg["role"],
                excerpt=excerpt,
                match_count=len(matches),
            ))
            if len(results) >= max_results:
                return results

    return results
```

- [ ] **Step 3 : Créer `search_panel.py`**

```python
# openagenticskyzer/app/components/search_panel.py
"""Panneau de recherche dans les conversations passées."""
from nicegui import ui
from openagenticskyzer.context.conversation_search import search_conversations, SearchResult
from openagenticskyzer.app.state import state


@ui.refreshable
def search_panel():
    with ui.column().classes("w-full gap-3 p-4"):
        ui.label("🔍 Recherche dans les conversations").classes("text-sm text-gray-300 font-semibold")

        with ui.row().classes("w-full gap-2"):
            query_input = ui.input(placeholder="Mot-clé, phrase, nom de fonction…").classes(
                "flex-1 bg-gray-900 text-gray-200 px-3 py-2 rounded border border-gray-700 text-sm"
            )
            ui.button("Rechercher", on_click=lambda: _do_search(query_input.value, results_col)).classes(
                "text-xs text-purple-400 border border-purple-800 bg-transparent px-3 py-2 rounded"
            )

        with ui.row().classes("gap-3 items-center"):
            date_from_el = ui.input(placeholder="De (YYYY-MM-DD)").classes(
                "w-36 text-xs bg-gray-900 text-gray-400 px-2 py-1 rounded border border-gray-800"
            )
            date_to_el = ui.input(placeholder="À (YYYY-MM-DD)").classes(
                "w-36 text-xs bg-gray-900 text-gray-400 px-2 py-1 rounded border border-gray-800"
            )

        results_col = ui.column().classes("w-full gap-2 mt-2")


def _do_search(query: str, results_col):
    if not query.strip():
        return
    results = search_conversations(query.strip(), max_results=20)
    results_col.clear()
    if not results:
        ui.notify("Aucun résultat trouvé.", type="info")
        return
    ui.notify(f"{len(results)} résultat(s).", type="positive")
    with results_col:
        _render_results(results)


def _render_results(results: list[SearchResult]):
    role_icon = {"user": "👤", "assistant": "🤖"}
    for r in results:
        with ui.card().classes("w-full border border-gray-800 bg-gray-950 p-3 cursor-pointer").on(
            "click", lambda sid=r.session_id: _open_session(sid)
        ):
            with ui.row().classes("items-center gap-2 mb-1"):
                ui.label(f"{role_icon.get(r.role, '•')} {r.role.upper()}").classes("text-xs text-gray-500")
                ui.label(r.session_date).classes("text-xs text-gray-600")
                if r.project:
                    ui.badge(r.project, color="purple").classes("text-xs")
                ui.label(f"{r.match_count} occ.").classes("text-xs text-gray-600 ml-auto")
            ui.label(r.excerpt).classes("text-xs text-gray-300 leading-relaxed")


def _open_session(session_id: str):
    from openagenticskyzer.app.storage import load_session
    msgs = load_session(session_id)
    if msgs:
        state.messages = msgs
        from openagenticskyzer.app.components.chat import chat_messages
        chat_messages.refresh()
        ui.notify(f"Session {session_id[:8]}… chargée.", type="positive")
```

- [ ] **Step 4 : Lancer les tests**

```
pytest tests/test_infrastructure.py::TestConversationSearch -v
```
Attendu : 3 PASS

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/context/conversation_search.py openagenticskyzer/app/components/search_panel.py tests/test_infrastructure.py
rtk git commit -m "feat: conversation search by keyword/date + search panel (Phase 17)"
```

---

## Task 4 : Résilience et fallback de modèles (Phase 19)

**Files:**
- Create: `openagenticskyzer/agent/__init__.py`
- Create: `openagenticskyzer/agent/resilience.py`
- Modify: `openagenticskyzer/app/components/settings.py`
- Test: `tests/test_infrastructure.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_infrastructure.py`, ajouter :

```python
class TestResilience:
    def test_provider_starts_available(self):
        from openagenticskyzer.agent.resilience import get_provider_health
        health = get_provider_health("test_provider_fresh")
        assert health.is_available() is True

    def test_circuit_opens_after_threshold(self):
        from openagenticskyzer.agent.resilience import ProviderHealth
        h = ProviderHealth(name="test")
        for _ in range(h.FAILURE_THRESHOLD):
            h.record_failure()
        assert h.circuit_open is True
        assert h.is_available() is False

    def test_circuit_recovers_after_timeout(self):
        import time
        from openagenticskyzer.agent.resilience import ProviderHealth
        h = ProviderHealth(name="test", RECOVERY_SECONDS=0.01)
        for _ in range(h.FAILURE_THRESHOLD):
            h.record_failure()
        time.sleep(0.02)
        assert h.is_available() is True

    def test_record_success_resets_circuit(self):
        from openagenticskyzer.agent.resilience import ProviderHealth
        h = ProviderHealth(name="test")
        for _ in range(h.FAILURE_THRESHOLD):
            h.record_failure()
        h.record_success()
        assert h.circuit_open is False
        assert h.failures == 0
```

- [ ] **Step 2 : Créer `agent/resilience.py`**

```python
# openagenticskyzer/agent/__init__.py
```

```python
# openagenticskyzer/agent/resilience.py
"""Circuit breaker et fallback chain pour les providers LLM."""
import time
from dataclasses import dataclass, field
from openagenticskyzer.app.storage import load_global_config


@dataclass
class ProviderHealth:
    name: str
    failures: int = 0
    last_failure: float = 0.0
    circuit_open: bool = False
    FAILURE_THRESHOLD: int = 3
    RECOVERY_SECONDS: float = 60.0

    def record_failure(self):
        self.failures += 1
        self.last_failure = time.time()
        if self.failures >= self.FAILURE_THRESHOLD:
            self.circuit_open = True

    def record_success(self):
        self.failures = 0
        self.circuit_open = False

    def is_available(self) -> bool:
        if not self.circuit_open:
            return True
        if time.time() - self.last_failure > self.RECOVERY_SECONDS:
            self.circuit_open = False
            self.failures = 0
            return True
        return False


_provider_health: dict[str, ProviderHealth] = {}


def get_provider_health(provider: str) -> ProviderHealth:
    if provider not in _provider_health:
        _provider_health[provider] = ProviderHealth(name=provider)
    return _provider_health[provider]


def get_active_provider_and_model() -> tuple[str, str]:
    """Retourne le premier provider disponible selon la chaîne de fallback."""
    cfg = load_global_config()
    primary_provider = cfg.get("provider", "groq")
    primary_model = cfg.get("model_name", "llama3-70b-8192")
    fallback_chain: list[dict] = cfg.get("fallback_chain", [])
    chain = [{"provider": primary_provider, "model": primary_model}] + fallback_chain

    for entry in chain:
        provider = entry["provider"]
        health = get_provider_health(provider)
        if health.is_available():
            return provider, entry["model"]

    return primary_provider, primary_model


def reset_provider(provider: str) -> None:
    """Réinitialise manuellement le circuit d'un provider."""
    if provider in _provider_health:
        _provider_health[provider].record_success()
```

- [ ] **Step 3 : Afficher l'état des providers dans `settings.py`**

```python
def _tab_resilience():
    from openagenticskyzer.agent.resilience import _provider_health, reset_provider
    _section("État des providers")
    if not _provider_health:
        ui.label("Aucun provider actif pour l'instant.").classes("text-xs text-gray-600 px-4")
        return
    for provider, health in list(_provider_health.items()):
        status = "🟢 OK" if health.is_available() else f"🔴 Circuit ouvert ({health.failures} erreurs)"
        with ui.row().classes("items-center gap-3 px-4 py-1"):
            ui.label(provider).classes("text-sm text-gray-300 w-24")
            ui.label(status).classes("text-xs text-gray-500 flex-1")
            if not health.is_available():
                ui.button("Réinitialiser", on_click=lambda p=provider: (
                    reset_provider(p),
                    ui.notify(f"{p} réinitialisé.", type="positive"),
                )).classes("text-xs text-yellow-400 border border-yellow-900 bg-transparent px-2 py-0.5 rounded")

    _section("Chaîne de fallback")
    from openagenticskyzer.app.storage import load_global_config
    cfg = load_global_config()
    chain = cfg.get("fallback_chain", [])
    if not chain:
        ui.label("Aucun fallback configuré (édite global_config.json).").classes("text-xs text-gray-600 px-4")
    for i, entry in enumerate(chain):
        ui.label(f"{i+1}. {entry.get('provider')} / {entry.get('model')}").classes("text-xs text-gray-400 px-4")
```

- [ ] **Step 4 : Lancer les tests**

```
pytest tests/test_infrastructure.py::TestResilience -v
```
Attendu : 4 PASS

- [ ] **Step 5 : Commit**

```bash
rtk git add openagenticskyzer/agent/ openagenticskyzer/app/components/settings.py tests/test_infrastructure.py
rtk git commit -m "feat: circuit breaker + fallback chain for LLM providers (Phase 19)"
```

---

## Task 5 : Budget et portabilité (Phase 20)

**Files:**
- Create: `openagenticskyzer/app/budget.py`
- Create: `openagenticskyzer/app/portability.py`
- Modify: `openagenticskyzer/app/components/input_bar.py`
- Modify: `openagenticskyzer/app/components/settings.py`
- Test: `tests/test_infrastructure.py`

- [ ] **Step 1 : Écrire les tests**

Dans `tests/test_infrastructure.py`, ajouter :

```python
class TestBudget:
    def test_no_alert_when_no_limit(self, tmp_path, monkeypatch):
        import openagenticskyzer.app.budget as budget
        monkeypatch.setattr(budget, "BUDGET_STATS_PATH", tmp_path / "stats.json")
        with patch("openagenticskyzer.app.budget.load_global_config",
                   return_value={"budget_limit_daily_usd": 0.0, "budget_limit_monthly_usd": 0.0}):
            alerts = budget.check_budget_alerts()
        assert alerts == []

    def test_alert_when_limit_exceeded(self, tmp_path, monkeypatch):
        import json
        from datetime import date
        import openagenticskyzer.app.budget as budget
        monkeypatch.setattr(budget, "BUDGET_STATS_PATH", tmp_path / "stats.json")
        today = date.today().isoformat()
        stats = {"daily": {today: 2.0}, "monthly": {}}
        (tmp_path / "stats.json").write_text(json.dumps(stats), encoding="utf-8")
        with patch("openagenticskyzer.app.budget.load_global_config",
                   return_value={"budget_limit_daily_usd": 1.0, "budget_limit_monthly_usd": 0.0}):
            alerts = budget.check_budget_alerts()
        assert any(a["level"] == "error" for a in alerts)

    def test_is_budget_exceeded_false_by_default(self, tmp_path, monkeypatch):
        import openagenticskyzer.app.budget as budget
        monkeypatch.setattr(budget, "BUDGET_STATS_PATH", tmp_path / "stats.json")
        with patch("openagenticskyzer.app.budget.load_global_config",
                   return_value={"budget_limit_daily_usd": 0.0, "budget_limit_monthly_usd": 0.0}):
            assert budget.is_budget_exceeded() is False
```

- [ ] **Step 2 : Créer `budget.py`**

```python
# openagenticskyzer/app/budget.py
"""Budget journalier/mensuel avec alertes."""
import json
from datetime import date
from pathlib import Path
from openagenticskyzer.app.storage import load_global_config

BUDGET_STATS_PATH = Path.home() / ".openagent" / "budget_stats.json"


def get_budget_stats() -> dict:
    if BUDGET_STATS_PATH.exists():
        return json.loads(BUDGET_STATS_PATH.read_text(encoding="utf-8"))
    return {"daily": {}, "monthly": {}}


def record_session_cost(cost_usd: float) -> None:
    stats = get_budget_stats()
    today = date.today().isoformat()
    month = today[:7]
    stats["daily"][today] = stats["daily"].get(today, 0.0) + cost_usd
    stats["monthly"][month] = stats["monthly"].get(month, 0.0) + cost_usd
    BUDGET_STATS_PATH.parent.mkdir(parents=True, exist_ok=True)
    BUDGET_STATS_PATH.write_text(json.dumps(stats, indent=2), encoding="utf-8")


def check_budget_alerts() -> list[dict]:
    """Retourne les alertes actives."""
    cfg = load_global_config()
    limit_daily = cfg.get("budget_limit_daily_usd", 0.0)
    limit_monthly = cfg.get("budget_limit_monthly_usd", 0.0)
    stats = get_budget_stats()
    today = date.today().isoformat()
    month = today[:7]
    spent_today = stats["daily"].get(today, 0.0)
    spent_month = stats["monthly"].get(month, 0.0)

    alerts = []
    if limit_daily > 0:
        pct = spent_today / limit_daily * 100
        if pct >= 100:
            alerts.append({"level": "error",
                           "message": f"Limite journalière atteinte ({spent_today:.3f}$ / {limit_daily:.2f}$)"})
        elif pct >= 80:
            alerts.append({"level": "warning",
                           "message": f"80% limite journalière ({spent_today:.3f}$/{limit_daily:.2f}$)"})
    if limit_monthly > 0:
        pct = spent_month / limit_monthly * 100
        if pct >= 100:
            alerts.append({"level": "error",
                           "message": f"Limite mensuelle atteinte ({spent_month:.2f}$ / {limit_monthly:.2f}$)"})
        elif pct >= 80:
            alerts.append({"level": "warning",
                           "message": f"80% limite mensuelle ({spent_month:.2f}$/{limit_monthly:.2f}$)"})
    return alerts


def is_budget_exceeded() -> bool:
    """True si une limite dure est atteinte → bloquer les envois."""
    return any(a["level"] == "error" for a in check_budget_alerts())
```

- [ ] **Step 3 : Bloquer l'envoi si budget dépassé dans `input_bar.py`**

Au début de `_send_message` :

```python
from openagenticskyzer.app.budget import is_budget_exceeded, check_budget_alerts

async def _send_message(text: str, ...):
    if is_budget_exceeded():
        ui.notify("❌ Limite de budget atteinte. Augmente la limite dans les paramètres.", type="negative", timeout=8000)
        return
    for alert in check_budget_alerts():
        if alert["level"] == "warning":
            ui.notify(f"⚠️ {alert['message']}", type="warning", timeout=5000)
            break
    # ... envoi normal ...
```

- [ ] **Step 4 : Créer `portability.py`**

```python
# openagenticskyzer/app/portability.py
"""Import/export de la configuration et des données utilisateur."""
import json
import shutil
import zipfile
from datetime import datetime
from pathlib import Path


def export_config(output_path: str | None = None) -> Path:
    """Exporte toutes les données utilisateur dans un .zip."""
    if not output_path:
        ts = datetime.now().strftime("%Y%m%d_%H%M")
        output_path = str(Path.home() / "Downloads" / f"openagenticskyzer_backup_{ts}.zip")

    home = Path.home() / ".openagent"

    files_to_include = [
        (home / "config.json", "global_config.json"),
        (home / "learnings.jsonl", "learnings.jsonl"),
        (home / "memory.md", "global_memory.md"),
        (home / "budget_stats.json", "budget_stats.json"),
    ]

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for src, arcname in files_to_include:
            if Path(src).exists():
                zf.write(src, arcname)
        sessions = home / "sessions"
        if sessions.exists():
            for sf in list(sessions.glob("*.jsonl"))[-50:]:
                zf.write(sf, f"sessions/{sf.name}")
        manifest = {"version": "1.0", "exported_at": datetime.now().isoformat(), "app": "openagenticskyzer"}
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))

    return Path(output_path)


def import_config(zip_path: str) -> list[str]:
    """Importe une configuration depuis un .zip."""
    home = Path.home() / ".openagent"
    file_map = {
        "global_config.json": home / "config.json",
        "learnings.jsonl": home / "learnings.jsonl",
        "global_memory.md": home / "memory.md",
        "budget_stats.json": home / "budget_stats.json",
    }
    restored = []
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        for arcname, dest in file_map.items():
            if arcname in names:
                dest.parent.mkdir(parents=True, exist_ok=True)
                zf.extract(arcname, str(dest.parent))
                extracted = dest.parent / arcname
                if extracted != dest:
                    shutil.move(str(extracted), str(dest))
                restored.append(arcname)
    return restored
```

- [ ] **Step 5 : Ajouter onglets "Budget" et "Données" dans `settings.py`**

```python
def _tab_budget():
    from openagenticskyzer.app.storage import load_global_config, save_global_config
    from openagenticskyzer.app.budget import get_budget_stats
    from datetime import date

    cfg = load_global_config()
    stats = get_budget_stats()
    today = date.today().isoformat()
    month = today[:7]

    _section("Dépenses actuelles")
    ui.label(f"Aujourd'hui : ${stats['daily'].get(today, 0.0):.4f}").classes("text-sm text-gray-400 px-4")
    ui.label(f"Ce mois : ${stats['monthly'].get(month, 0.0):.4f}").classes("text-sm text-gray-400 px-4")

    _section("Limites de dépense API")
    with ui.row().classes("items-center gap-3 px-4"):
        ui.label("Limite journalière (USD)").classes("text-sm text-gray-400 w-48")
        daily_input = ui.number(value=cfg.get("budget_limit_daily_usd", 0.0), min=0, step=0.5, format="%.2f")
        daily_input.on("blur", lambda: (cfg.update({"budget_limit_daily_usd": daily_input.value}), save_global_config(cfg)))
        ui.label("(0 = illimité)").classes("text-xs text-gray-600")

    with ui.row().classes("items-center gap-3 px-4"):
        ui.label("Limite mensuelle (USD)").classes("text-sm text-gray-400 w-48")
        monthly_input = ui.number(value=cfg.get("budget_limit_monthly_usd", 0.0), min=0, step=5)
        monthly_input.on("blur", lambda: (cfg.update({"budget_limit_monthly_usd": monthly_input.value}), save_global_config(cfg)))


def _tab_data():
    _section("Sauvegarde et portabilité")
    async def _export():
        from openagenticskyzer.app.portability import export_config
        path = export_config()
        ui.notify(f"✅ Exporté dans {path}", type="positive")

    ui.button("⬇️ Exporter ma configuration", on_click=_export).classes(
        "mx-4 text-xs text-green-400 border border-green-900 bg-transparent px-3 py-2 rounded"
    )
    ui.label("Exporte config, mémoire, learnings, 50 dernières sessions dans un .zip").classes("text-xs text-gray-600 px-4")
```

- [ ] **Step 6 : Lancer les tests**

```
pytest tests/test_infrastructure.py::TestBudget -v
```
Attendu : 3 PASS

- [ ] **Step 7 : Commit**

```bash
rtk git add openagenticskyzer/app/budget.py openagenticskyzer/app/portability.py openagenticskyzer/app/components/input_bar.py openagenticskyzer/app/components/settings.py tests/test_infrastructure.py
rtk git commit -m "feat: budget limits + export/import config ZIP (Phase 20)"
```

---

## Task 6 : API Server REST (Phase 13)

**Files:**
- Create: `openagenticskyzer/api_server.py`
- Create: `openagenticskyzer/webhooks.py`
- Modify: `openagenticskyzer/app/components/settings.py`

- [ ] **Step 1 : Créer `api_server.py`**

```python
# openagenticskyzer/api_server.py
"""Serveur API REST local — expose l'agent sur http://127.0.0.1:8767.
Nécessite : pip install fastapi uvicorn
"""
import threading

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel
    import uvicorn

    app = FastAPI(title="OpenAgentic Skyzer API", version="1.0.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    class ChatRequest(BaseModel):
        message: str
        folder: str = ""
        mode: str = "auto"
        model: str | None = None
        provider: str | None = None
        history: list[dict] = []

    class ChatResponse(BaseModel):
        response: str
        tool_calls: list[dict] = []
        tokens_used: int = 0

    @app.post("/chat", response_model=ChatResponse)
    async def chat(req: ChatRequest):
        from openagenticskyzer.agent import build_agent
        agent = build_agent(mode=req.mode, provider=req.provider, model_name=req.model)
        messages = req.history + [{"role": "user", "content": req.message}]
        try:
            result = agent.invoke({"messages": messages}, {"recursion_limit": 100})
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

        ai_text = ""
        tool_calls_log = []
        for msg in reversed(result.get("messages", [])):
            content = getattr(msg, "content", "")
            if content and not getattr(msg, "tool_calls", None):
                ai_text = content if isinstance(content, str) else str(content)
                break
        for msg in result.get("messages", []):
            for tc in getattr(msg, "tool_calls", None) or []:
                name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
                args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {})
                if name:
                    tool_calls_log.append({"tool": name, "args": args})

        return ChatResponse(response=ai_text, tool_calls=tool_calls_log)

    @app.get("/health")
    async def health():
        return {"status": "ok", "version": "1.0.0"}

    @app.get("/models")
    async def list_models():
        from openagenticskyzer.utils.utils import list_ollama_models
        return {"ollama": list_ollama_models()}

    def start_api_server(host: str = "127.0.0.1", port: int = 8767):
        def _run():
            uvicorn.run(app, host=host, port=port, log_level="warning")
        threading.Thread(target=_run, daemon=True).start()

except ImportError:
    def start_api_server(host: str = "127.0.0.1", port: int = 8767):
        pass
```

- [ ] **Step 2 : Toggle API server dans `settings.py`**

```python
def _tab_api():
    from openagenticskyzer.app.storage import load_global_config, save_global_config
    cfg = load_global_config()
    _section("API Server local")
    with ui.row().classes("items-center gap-3 px-4"):
        sw = ui.switch(value=cfg.get("start_api_server", False))
        sw.on("update:model-value", lambda e: (
            cfg.update({"start_api_server": e.args}),
            save_global_config(cfg),
        ))
        ui.label("Démarrer l'API server au lancement").classes("text-sm text-gray-400")
    ui.label("Expose l'agent sur http://127.0.0.1:8767/chat").classes("text-xs text-gray-600 px-4")
    ui.label('Exemple : POST /chat {"message": "...", "mode": "auto"}').classes("text-xs text-gray-700 font-mono px-4")
```

- [ ] **Step 3 : Lancer le server si activé dans `main.py`**

```python
from openagenticskyzer.app.storage import load_global_config

cfg = load_global_config()
if cfg.get("start_api_server", False):
    from openagenticskyzer.api_server import start_api_server
    start_api_server()
```

- [ ] **Step 4 : Commit**

```bash
rtk git add openagenticskyzer/api_server.py openagenticskyzer/app/components/settings.py openagenticskyzer/app/main.py
rtk git commit -m "feat: local REST API server (FastAPI, port 8767) with /chat + /health (Phase 13)"
```
