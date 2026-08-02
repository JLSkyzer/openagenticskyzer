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
- [ ] Task 4 — Compaction LLM réelle (`context_bar.py`)
- [ ] Task 5 — Apprentissage adaptatif (`context/learnings.py`) + tests + injection

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
