# Todo

## Plan 2026-04-27-git-dev-tools — TERMINÉ (2026-08-01)

- [x] Task 1 — Créer `openagenticskyzer/tools/git_tools.py` (14 outils git) + tests
- [x] Task 2 — Enregistrer les outils dans l'agent (`agent.py`), permissions (`permissions.py`), prompt (`prompt.py`)
- [x] Task 3 — Widget statut branche git dans la sidebar (`sidebar.py`)
- [x] Fix critique post-review finale — `git_pull` non protégé contre l'injection d'arguments (voir lessons.md), vérifié indépendamment par un subagent de review

Commits (master) : 0543b3e, b0041ce, 732a505, b0c8370, e999984, 2af08f8, 6cbba56, 646f128

Gap mineur non bloquant restant : pas de test pour le cas `git_pull` non-fast-forward (historique divergent). À ajouter si on retouche `git_tools.py`.

## Plan 2026-04-27-memory-learning — EN COURS

- [x] Task 1 — Créer `openagenticskyzer/context/project_memory.py` (mémoire projet + globale) + tests
- [x] Task 2 — Outils mémoire pour l'agent (`tools/memory_tools.py`) + intégration `agent.py`/`prompt.py`
- [x] Task 3 — Injection mémoire en début de conversation (`input_bar.py`)
- [x] Task 4 — Compaction LLM réelle (`context_bar.py`)
- [x] Task 5 — Apprentissage adaptatif (`context/learnings.py`) + tests + injection

Task 1 commits (master) : c33e43f, 3bf383f (fix follow-up post code-review : gestion gracieuse des erreurs I/O + `newline="\n"` sur toutes les écritures + test que `.openagent/` et ses autres fichiers survivent à `clear_project_memory`)

Task 1 — écarts vs. code suggéré par le plan (voir lessons.md pour le détail) :
- `test_save_creates_directory` du plan avait une assertion no-op (`assert Path(...)` est toujours truthy) — remplacée par une vraie vérification `.exists()` + contenu.
- `append_to_project_memory`/`append_to_global_memory` : ajout d'un garde no-op sur faits vides/blancs (le plan les aurait quand même écrits comme entrée horodatée vide — pur bruit vu que ce fichier est réinjecté dans chaque conversation future par la Task 3).
- Path.home() / encodage CRLF Windows / suppression de fichier vérifiés empiriquement — pas de bug réel trouvé là, code du plan gardé tel quel sur ces points.

Task 2 commits (master) : 2168555 (feat: add save/read/forget memory tools to agent), 4782bb1 (refactor follow-up post code-review)

Task 2 — écarts vs. code suggéré par le plan :
- `forget_memory` : le plan suggérait un filtrage ligne par ligne (`[l for l in mem.splitlines() if keyword not in l]`), ce qui aurait laissé des en-têtes `<!-- timestamp -->` orphelins ou des fragments d'un fait multi-lignes quand seule une ligne matchait le mot-clé. Remplacé par une suppression par entrée entière (découpage sur le marqueur horodaté `<!-- YYYY-MM-DD HH:MM -->` écrit par `append_to_project_memory`).
- Gap-fix proactif dans `permissions.py` (pas dans le texte littéral du plan, mais discipline appliquée suite à la leçon du plan git-dev-tools) : `save_memory`/`forget_memory` ajoutés à `_RESTRICTED_TOOLS` (écriture disque), `read_memory` à `_READ_ONLY_TOOLS`.
- En écrivant un test de régression générique (`test_every_registered_tool_is_classified`) qui vérifie que tout outil de `agent._ALL_TOOLS` est classé dans `permissions.py`, une vraie lacune préexistante et non liée à cette tâche a été détectée : `fetch_url` (outil déjà enregistré avant cette tâche) n'était classé nulle part. Corrigé en l'ajoutant à `_READ_ONLY_TOOLS` (c'est un simple GET HTTP, aucune écriture disque).

Task 2 — review follow-up (commit 4782bb1) :
- Fix Important (format-ownership leak) : `memory_tools.py` re-dérivait indépendamment le format d'entrée horodatée (`<!-- timestamp -->`, séparateur `\n\n`) que `project_memory.py` définit et possède déjà. Logique de découpage/suppression déplacée dans `project_memory.remove_entries_matching(existing, keyword)` — `forget_memory` est redevenu un simple wrapper fin, comme `save_memory`/`read_memory`.
- Fix Minor 1 : `test_restricted_and_read_only_sets_are_disjoint` ajouté (un outil dans les deux ensembles sauterait silencieusement la confirmation en mode "demander", `_READ_ONLY_TOOLS` étant vérifié en premier).
- Fix Minor 2 : cas limite le plus risqué couvert — supprimer la seule entrée de la mémoire doit laisser `load_project_memory()` égal à `""`, pas un résidu d'espaces blancs (testé aux deux niveaux : `remove_entries_matching` directement et `forget_memory` bout en bout).
- Point non bloquant laissé tel quel : `forget_memory` retourne toujours un message de succès même si 0 entrée matchait le mot-clé — convention volontaire identique à `save_memory` sur faits vides (déjà testée/acceptée en Task 2).

Task 3 commit (master) : 5413cf9 (feat: inject project and global memory into each conversation)

Task 3 — écarts vs. code suggéré par le plan :
- Logique de formatage extraite dans une fonction pure `_format_memory_injection(global_mem, project_mem) -> str` (module `input_bar.py`) au lieu de l'inline suggéré par le plan — `_send_message` est fortement couplé à l'état NiceGUI (ui.notify, input_el, refresh…) et n'est pas testable en isolation ; extraire le formatage en fonction pure permet de le couvrir par 4 tests unitaires (`tests/test_input_bar.py`) sans harnais UI.
- Pas de `run.io_bound` autour de `load_global_memory()`/`load_project_memory()` malgré la leçon du widget git sidebar (Phase 2.1) sur le blocking I/O dans l'event loop NiceGUI : vérifié empiriquement que `load_global_config()`/`load_folder_config()` (juste au-dessus dans la même fonction `_send_message`) font déjà des `path.read_text()` synchrones non enveloppés — un `subprocess` git (le cas qui avait motivé le fix précédent) a un coût d'ordre de grandeur différent (spawn de process, dizaines de ms à secondes) qu'une lecture de petit fichier markdown local (cache OS, sub-ms). Envelopper cette lecture dans `run.io_bound` aurait été incohérent avec le pattern déjà établi juste à côté et n'aurait rien résolu de réel.
- Pas de cap de taille sur le contenu de mémoire injecté (le plan n'en suggère pas non plus, et `read_memory()` de la Task 2 n'en a pas non plus) — laissé identique au comportement de la Task 2 par cohérence ; signalé comme risque de croissance non bornée à surveiller si la Task 5 (learnings) ajoute un deuxième bloc système sans cap non plus.

Task 4 commits (master) : 78d9600 (feat: real LLM-based compaction, extraction des 3 helpers purs + fix critique `await trigger_compact()` manquant au 2e call site), 5b8d91c (fix follow-up post code-review)

Task 4 — bug critique anticipé avant implémentation :
- `trigger_compact` devient `async def` ; un 2e site d'appel (`input_bar.py:467`, à l'intérieur d'un `async def _send_message` déjà) appelait la fonction de façon synchrone (bare call). Sans `await`, cela crée silencieusement une coroutine jamais exécutée — l'auto-compact se serait cassé sans aucune erreur visible. Corrigé dès l'implémentation initiale, vérifié indépendamment par le spec reviewer (diff pre/post commit).

Task 4 — review qualité (1er passage, commit 78d9600) → "Needs fixes", 4 problèmes Importants, tous corrigés en 5b8d91c et re-vérifiés indépendamment (verdict "Approved") :
1. Race de perte de messages : `history_text` était snapshotté depuis `state.messages[:-2]` avant le `await run.io_bound(...)` (qui cède le contrôle sur l'event loop mono-thread NiceGUI), mais la réassemblée finale relisait `state.messages[-2:]` *après* l'await — perdant silencieusement tout message ajouté pendant l'attente. Fix : un seul `snapshot = list(state.messages)` pris une fois ; `history_text` ET `tail = snapshot[-2:]` dérivent tous deux de ce même snapshot, avant l'await.
2. Aucune garde de ré-entrance : `trigger_compact` accessible à la fois par le bouton manuel et le déclenchement auto après envoi de message, sans rien empêchant deux exécutions concurrentes (aggravant le point 1 et risquant une double écriture dans la mémoire projet). Fix : flag module-level `_compact_in_progress`, vérifié en entrée (retour anticipé + notify si déjà en cours), remis à `False` dans un `finally` couvrant tout le corps — vérifié qu'aucun chemin de sortie (y compris le nouveau retour anticipé sur résumé vide) ne peut laisser le flag bloqué à `True`.
3. No-op silencieux sur résumé vide : si le LLM renvoyait `""`, le bloc `if summary:` était sauté sans aucun retour utilisateur. Fix : branche explicite `if not summary:` avec `ui.notify(..., type="negative")` + retour.
4. Portée du `try` trop large : englobait aussi les appels de refresh/notify après succès, donc un échec de refresh après une summarization LLM réussie déclenchait à tort le message "LLM indisponible". Fix : `try` resserré autour du seul appel LLM + extraction du résumé ; mutation d'état, `append_to_project_memory` et refresh/notify de succès sortis du bloc.
Tests : 4 nouvelles classes dans `test_context_bar.py` (garde de ré-entrance, résumé vide jamais silencieux, snapshot de la queue résistant à une croissance concurrente pendant l'await, régression du fallback LLM-indisponible) — vérifiées par le re-reviewer comme exerçant réellement les scénarios (pas de mock qui neutraliserait ce qui est testé). Suite complète : 259 passed / 3 failed, mêmes échecs pré-existants sans rapport (confirmés via `git stash`).

Point non bloquant relevé en re-review : fichier `scratchpad_base_context_bar.py` à la racine du repo, non tracké, non créé par l'implémenteur (probablement résiduel d'une session antérieure) — laissé tel quel, à nettoyer à l'occasion.

Task 5 commit (master) : feat: add adaptive learning system with JSONL storage and injection (Phase 15)

Task 5 — écarts vs. code suggéré par le plan (bug critique identifié avant implémentation, voir lessons.md) :
- `GLOBAL_LEARNINGS_PATH = Path.home() / ".openagent" / "learnings.jsonl"` du plan était une **constante de module** calculée une seule fois à l'import — aucun test suggéré par le plan ne la monkeypatchait, donc `delete_learning`/`load_learnings` appelés sans `project_folder` (ou avec, puisque `delete_learning` du plan boucle aussi sur `GLOBAL_LEARNINGS_PATH` en plus du chemin projet) auraient lu/réécrit le vrai `~/.openagent/learnings.jsonl` du poste de développement à chaque run de test. Remplacée par `_global_learnings_path() -> Path`, une fonction, exactement comme `project_memory._global_memory_path` (Task 1) — chaque test qui touche la portée globale la monkeypatche vers `tmp_path`.
- `delete_learning` du plan construisait `paths = [_learnings_path(project_folder), GLOBAL_LEARNINGS_PATH]` sans dédupliquer : quand `project_folder is None`, `_learnings_path(None)` retourne déjà le chemin global, donc la liste contenait deux fois le même `Path` → lecture+réécriture redondante du même fichier. Dédupliqué explicitmeent (`if global_path not in paths`) dans `load_learnings` et `delete_learning`.
- Mêmes conventions déjà établies en Task 1 répliquées ici : `try/except OSError` en lecture (retour `[]`) et en écriture (échec silencieux) sur `save_learning`/`_read_learnings_file`/`delete_learning` ; `newline="\n"` explicite sur l'écriture JSONL (append en mode texte avec `open(..., newline="\n")`, et `Path.write_text(..., newline="\n")` dans `delete_learning`).
- Pas de garde no-op sur mistake/correction vides dans `new_learning`/`save_learning` (contrairement à `append_to_project_memory` en Task 1) : à la différence de la mémoire projet, aucun outil `@tool` agent-facing n'est ajouté dans cette tâche (explicitement hors scope du plan) — il n'existe donc pas encore de chemin où un LLM pourrait appeler `save_learning(mistake="")` en argument libre ; de plus une entrée `confirmed=False` par défaut n'est de toute façon jamais injectée (`load_learnings(confirmed_only=True)`). Un garde spéculatif sans point d'entrée réel aurait été de la sur-ingénierie ; à revisiter si un futur outil `save_learning`/`confirm_learning` est ajouté.
- Injection dans `input_bar.py` : bloc système additionnel ajouté après le bloc mémoire (Task 3), sans toucher au code existant — suit exactement le pattern `if memory_injection: history = [...] + history`, avec `format_learnings_for_injection` appelé directement (pas de wrapper pur supplémentaire créé dans `input_bar.py`, puisque `format_learnings_for_injection` est déjà la fonction pure testée dans `test_learnings.py`). Aucun nouveau test ajouté à `test_input_bar.py` en conséquence (pas de nouvelle logique pure introduite dans ce fichier).

Tests : 32 tests dans `tests/test_learnings.py` (création/troncature, save/load roundtrip, filtre `confirmed_only`, dédup projet+global par id, isolation du chemin global via monkeypatch — y compris un test explicite pointant `Path.home()` vers un tmp_path vide pour vérifier qu'aucune exception n'est levée et que rien n'est lu du vrai poste —, dégradation OSError en lecture/écriture/suppression, lignes JSON malformées ignorées, formatage d'injection avec cap à 20 entrées). Suite complète : 291 passed / 3 failed, mêmes échecs pré-existants sans rapport (`test_context_limit.py::test_ctx_limits_has_all_providers`, `test_loop_detector.py::TestLoopDetectorSameFileEdit::test_interleaved_tool_resets_file_streak`, `test_utils.py::TestParseMentions::test_email_like_not_captured`).
