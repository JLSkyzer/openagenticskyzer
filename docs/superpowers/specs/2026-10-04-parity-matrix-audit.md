# Audit ligne à ligne — matrice de parité NiceGUI → Electron

Date : 2026-10-04. Matrice : `docs/superpowers/plans/2026-09-14-electron-parity.md` (38 lignes de domaine).
Dépôt : `D:\Openagenticai-skyzeredition`, HEAD `bb9f506`. Source Python lue au tag `python-final`.

Méthode : lecture du code (`electron/main.cjs`, `worker.mjs`, `core/*.mts`, `renderer-src/src/**`) et des tests
(`electron/tests/*.test.mts`, `*-visual.cjs`, `final-e2e*.cjs`). **Aucun test n'a été exécuté** pendant cet audit
(lecture seule ; les tests visuels et e2e ouvrent des fenêtres). Un test n'est retenu que s'il exerce le
comportement pour de vrai (vrai worker, vrais fichiers, vrai serveur HTTP local, vraie fenêtre Electron). Les
tests purs du reducer ou avec dépendances injectées (`export-ui.test.mts`, `chat-branches.test.mts`…) ne
comptent pas comme preuve d'un comportement d'interface. Les bilans de `tasks/todo.md` ont été vérifiés contre
le code, pas recopiés.

Chemins abrégés : `M` = `electron/main.cjs`, `W` = `electron/worker.mjs`, `C/` = `electron/core/`,
`R/` = `electron/renderer-src/src/`, `T/` = `electron/tests/`.

## Synthèse

| Classement | Nombre |
|---|---|
| prouvée | 23 |
| partielle | 10 |
| absente | 0 |
| décision délibérée (ligne entière écartée) | 5 |

Dix lignes « prouvée » ou « partielle » portent en plus une **décision délibérée partielle**, signalée dans la
dernière colonne : 4, 15, 23, 24, 31, 32, 35, 38, et indirectement 1 et 27.

## Tableau

| # | Domaine | Classement | Implémentation (fichier:ligne) | Test qui prouve (fichier — nom) | Manques / décision délibérée |
|---|---|---|---|---|---|
| 1 | Fenêtre et lancement | **partielle** | `M:257` `requestSingleInstanceLock`, `M:260` `second-instance`→`showMainWindow` `M:88-93` (restore/show/focus), `M:98-107` tray Ouvrir/Quitter, `M:139-164` `stopWorker`, `M:285-290` `before-quit`, `W:524-530` op `shutdown` | `T/final-e2e*.cjs` (exe packagé, « python must not be resolvable on the PATH », « the app exited after the window was closed ») ; `T/final-e2e-lot3.cjs` « the dev server stopped with the app » ; `T/worker-tools.test.mts` — « shutdown stops the background dev servers a run started… » ; `T/main-shutdown.test.mts` — « stopWorker on a real worker leaves it terminated » ; `T/package-smoke.cjs` | Verrou single-instance : **aucun test** (limite assumée Tâche 82). Tray : seul le PNG est testé (`T/tray-icon.test.mts`). **Écart fonctionnel** : `M:291` quitte l'app à la fermeture de la fenêtre, alors que Python restait dans la barre système et rouvrait la fenêtre par « Ouvrir openagent » ; ici « Ouvrir » ne peut que restaurer une fenêtre réduite (`showMainWindow` ne recrée jamais une fenêtre détruite). Le commentaire `M:95-97` (« keep running in the background after the window is closed ») est faux. Aucun test sur une machine sans Python (bilan 2026-10-04 le dit). |
| 2 | Projets | **partielle** | `M:195` dialogue natif `open-folder` ; `R/components/Sidebar.tsx:53-60` `activate`, `:74-89` restauration au démarrage, `:180-201` historique nom/chemin/date ; `W:462-466` `activate_folder` ; `C/folders.mts:26` | `T/sidebar-visual.cjs` (clic → tête de liste, actif, persistance disque) ; `T/restore-folder-visual.cjs` ; `T/worker-folders.test.mts` — « worker::activate_folder records the folder in history… » ; `T/folders.test.mts` ; isolation : `T/branches-visual.cjs` « the other folder shows its own (empty) conversation », `T/storage.test.mts` — « legacy history survives fork edits, reopening and other projects » | **Saisie d'un chemin absente** : Python (`sidebar.py::open_folder_prompt`) offrait un champ texte + « Parcourir… » ; Electron n'a que le dialogue natif, sans décision écrite. Affichage chemin/date jamais asserté (seul le nom l'est). Le dialogue natif lui-même n'est pas pilotable (bouchonné partout, limite acceptable). |
| 3 | Git sidebar | prouvée | `C/git-status.mts:20-36` (null sur échec, jamais d'exception) ; `W:426` ; `R/components/Sidebar.tsx:43-51,168-177` | `T/git-status-visual.cjs` (vrai git, propre → modifié `●`, dossier non-git sans widget) ; `T/git-status.test.mts` — « gitStatus reports dirty once a tracked file is modified », « gitStatus returns null, not "clean", when git status itself fails » ; `T/worker-git-status.test.mts` | — |
| 4 | Initialisation | prouvée | `C/project-analyzer.mts:100` `scanProject`, `:169` `generateOpenAgentMd`, `:228` `initializeProject`, `:267` outil agent ; `W:431` ; `R/components/Sidebar.tsx:107-127,152-167` confirmation ; priorité `C/context.mts:22-27` | `T/project-analyzer.test.mts` (9 tests : TS/React/npm/CI, pnpm>npm, exclusions, profondeur, fichiers sensibles) ; `T/worker-project-analyzer.test.mts` ; `T/project-init-visual.cjs` (fixture Python, OPENAGENT.md réel) ; `T/worker-project-tool.test.mts` ; priorité : `T/context.test.mts` — « legacy instructions, custom prompt, memory and confirmed learnings reach the actual provider request » (CLAUDE.md non injecté si OPENAGENT.md existe) | Décision délibérée (Tâche 85) : une seule question « Créer ou remplacer… » au lieu de deux messages. Non mentionné par la décision : l'avertissement Python « deviendra prioritaire sur CLAUDE.md » a disparu. |
| 5 | Premier lancement | prouvée | `R/components/Onboarding.tsx:17-107`, `R/state/onboarding.ts:2-27` | `T/onboarding-visual.cjs` (4 étapes par vrais clics, Retour, Passer, sélecteur au-dessus, dossier réel, rien enregistré avant la fin, échec d'écriture affiché) ; `T/final-e2e-lot11.cjs` (vrai redémarrage de l'exe) ; `T/worker-onboarding.test.mts` — « completing the wizard is saved for good: a new process still reads it as done » | — |
| 6 | Conversation | **partielle** | `R/components/ChatView.tsx:69-74` défilement, `:126-149` bulles/outils/streaming ; `R/components/MessageBubble.tsx` ; `R/markdown/Markdown.tsx` (gfm + highlight) ; `R/components/ToolMessage.tsx:10-19` diff coloré | `T/chat-visual.cjs` (badge WRITE, nom d'outil, `<strong>`, fichier réel) ; `T/stop-visual.cjs` (streaming partiel) ; `T/attachments-visual.cjs` (images dans la bulle) ; erreurs : `T/context-visual.cjs` « Erreur du provider (400) » | **Détail d'outil absent** : Python affichait `tool_detail` (chemin/commande/requête) dans l'en-tête de carte ; `ToolMessage` n'affiche que le nom. **Diff d'édition absent** : `edit_file` (`C/workspace.mts:180`) ne renvoie aucun diff, le rendu `looksLikeDiff` n'est jamais alimenté par une édition, et n'est testé nulle part. **Régression au rechargement** : `folder-loaded` (`R/state/reducer.ts:91-93`) ne reconstruit ni `_tool` ni `_category` ; une conversation rouverte affiche « outil » sans badge (Python persistait `tool_tag`/`tool_detail`). Blocs de code et défilement automatique vers le bas : non testés. |
| 7 | Composer | **partielle** | `R/components/InputBar.tsx:76-86` envoi (garde `agentRunning`/`compacting`), `:108-126` Entrée / Shift+Entrée / `/`, `:187-194` Envoyer/Stop ; `R/components/model/ModelButton.tsx` | Envoi par Entrée : tous les tests visuels ; Stop : `T/stop-visual.cjs` ; bouton revenu au repos : `T/chat-visual.cjs` ; modèle actif : `T/model-selector-visual.cjs` ; slash-prompts : `T/prompts-visual.cjs`, `T/final-e2e-lot6.cjs` | **Shift+Entrée** (nouvelle ligne, aucun envoi) : non testé. **Prévention du double envoi** : non testée. |
| 8 | Pièces jointes | prouvée | `R/state/upload.ts:131` `processUpload` ; `R/components/InputBar.tsx:36-74` sélection/collage/dépôt ; `R/components/AttachmentChips.tsx` ; `C/attachments.mts:25,51,70` ; `W:511` | `T/attachments-visual.cjs` (texte, CSV, image, vrai PDF via pdf.js, refus, ✕ avant envoi, glisser-déposer, requête modèle capturée) ; `T/final-e2e-lot12.cjs` (exe packagé + redémarrage) ; `T/worker-attachments.test.mts` | Limite documentée : le moteur `.gguf` local ignore les images (`T/local-provider.test.mts`). |
| 9 | Édition et régénération | prouvée | `R/state/ChatProvider.tsx:286` `editMessage`, `:304` `regenerate` ; `W:503-508` contrôle de `keep` | `T/edit-regenerate-visual.cjs` ; `T/final-e2e-lot9.cjs` ; `T/worker-keep.test.mts` — « worker::send refuses a `keep` longer than what is saved, and loses nothing » | — |
| 10 | Branches | prouvée | `C/conversations.mts:102-113` `fork` ; `W:564-569` ; `R/state/ChatProvider.tsx:230,257` ; `R/components/BranchSelector.tsx` | `T/branches-visual.cjs` ; `T/final-e2e-lot4.cjs` (redémarrage réel) ; `T/worker-branches.test.mts` — « worker::fork copies up to and including the clicked message, and sending on the fork never touches main » | — |
| 11 | Artifacts | prouvée | `R/components/ArtifactPanel.tsx:81` ; `R/state/artifacts.ts:9` ; `electron/artifact-protocol.cjs` ; `M:221` `artifact-put`, CSP `M:38-43` | `T/artifact-visual.cjs` (HTML isolé du parent, du réseau et de la navigation ; SVG inerte ; Mermaid ; Markdown ; ✕) ; `T/final-e2e-lot10.cjs` ; `T/artifact-protocol.test.mts` | Décision (lot artifacts) : le panneau se ferme au changement de dossier. |
| 12 | Palette | prouvée | `R/components/CommandPalette.tsx:19` ; `R/state/commands.ts:8-17` (8 commandes), `:45` Ctrl+K | `T/palette-visual.cjs` (Ctrl+K depuis la zone de saisie, filtre, clavier, 7 commandes exécutées) ; la 8ᵉ (Exporter) : `T/export-visual.cjs` ; `T/final-e2e-lot7.cjs` | — |
| 13 | Prompts | prouvée | `C/prompts.mts:35`, `C/prompt-defaults.mts:6` ; `R/components/PromptPicker.tsx` ; `R/state/prompts.ts` | `T/prompts-visual.cjs` ; `T/final-e2e-lot6.cjs` (fichier relu après redémarrage) ; `T/prompts.test.mts` — « the ten default prompts are those of the NiceGUI app, in the same order » ; `T/prompts.test.mts` — « worker::list-prompts serves the library of its data directory » | — |
| 14 | Exports | **partielle** | `C/export.mts:57,86,92,132,161` ; `W:277-294` ; `M:211-218` `open-export` ; `R/components/ExportMenu.tsx`, `R/state/export.ts:21` | `T/export-visual.cjs` (3 formats relus, tags réels, depuis ⬇ et palette) ; `T/final-e2e-lot8.cjs` (vrai `shell.openPath`) ; `T/worker-export.test.mts` — « exports a fork branch, distinct from main », « refuses an invalid format and a missing folder, and writes nothing » | **Erreur d'E/S visible dans l'UI** : seul `T/export-ui.test.mts` (fonction pure, dépendances simulées) prouve le toast « Échec de l'export » ; dans `export-visual.cjs`, le refus est appelé directement sur le worker, pas à travers l'interface. |
| 15 | Général global | prouvée | `R/components/settings/GeneralTab.tsx:23` ; `C/settings.mts:4-14,91` ; `C/data-dir.mts:22,46` ; `C/hf-token.mts:12` ; `W:429-430` | `T/settings-tabs-visual.cjs` (sans dossier actif : mode, restauration, animations, jeton masqué, répertoire de données) ; `T/data-dir-visual.cjs` ; `T/worker-data-dir.test.mts` ; `T/hf-token-visual.cjs` ; `T/worker-hf-token.test.mts` ; `T/worker-settings.test.mts` — « save-global-settings persists the HuggingFace token but never sends it back » | Constat : `hf_token` n'a plus aucun consommateur dans `C/` ni `W` depuis l'abandon du catalogue HF (2026-09-27) ; le champ et « Tester le token » restent, sans usage. `animations` est sans effet, comme en Python. |
| 16 | Apparence globale | **partielle** | `R/components/settings/AppearanceTab.tsx:7-49` ; `R/theme/ThemeProvider.tsx` ; validation `C/settings.mts:35` | `T/theme-visual.cjs` (sombre par défaut, clic Clair, persistance, captures des deux thèmes) ; refus d'un accent invalide : `T/storage.test.mts` — « legacy unknown settings are preserved, invalid patches and malformed shapes are rejected » | **Changement d'accent** par l'UI (application à `--accent` + persistance) : non testé ; seule la valeur par défaut est vérifiée. |
| 17 | Contexte global | prouvée | `R/components/settings/ContextTab.tsx:15,96-105` (7/30/90/indéfiniment) ; `R/components/ContextBar.tsx:20-62` ; `C/cleanup.mts:23`, `W:89` | `T/settings-tabs-visual.cjs` (max_tokens, réservés, auto_compact, rétention 90 persistés) ; `T/context-visual.cjs` (seuil modifié en direct, jauge masquée/réaffichée, auto-compact) ; `T/worker-cleanup.test.mts` — « worker startup wipes conversation data of a project unused beyond the configured retention » ; `T/final-e2e-lot5.cjs` | — |
| 18 | Permissions globales | **partielle** | `C/agent.mts:49-62` `policy`, `:64` `offeredTools` ; `R/components/settings/PermissionsTab.tsx:5-40` ; `W:353` | `T/worker-tools.test.mts` — « the model is offered every tool by default, and only the read tools in strict mode », « run_command asks by default, runs after approval, and shell_ask=false skips the prompt », « a saved files_ask: false is respected » ; `T/agent.test.mts` — « shell_ask decides whether a shell tool asks… » ; `T/worker-project-tool.test.mts` (mode auto) | **`search_ask`** (catégorie `network`, `C/agent.mts:54`) : aucun test, ni demande quand il vaut `true`, ni passage quand il vaut `false`. |
| 19 | Permissions en cours | prouvée | `R/components/PermissionBanner.tsx:12-66` ; `W:369-375` `confirm`, `W:531-539` ; `C/agent.mts:40-48` abandon pendant l'attente | `T/permission-visual.cjs` (Autoriser, Refuser, Toujours, commande shell entière, rien écrit avant la décision) ; `T/worker-request.test.mts` — « a Stop during a permission prompt saves a paired "Interrompu" result, and the next turn works » ; `T/agent.test.mts` — « cancellation while waiting for approval exits without executing the tool » ; `T/worker-tools.test.mts` — « "Toujours" on create_file covers create_file only… » | Décision H5 (2026-10-03) : « Toujours » limité à la session. |
| 20 | Projet | prouvée | `C/connections.mts:59` (portées globale/projet) ; `R/components/model/ModelDialog.tsx:164-165,209,334-341` ; `R/components/settings/FolderTab.tsx:11` ; `C/settings.mts:91` ; `M:184-191` | `T/connections.test.mts` — « keys are encrypted at rest, omitted from UI snapshots and isolated across projects/providers », « endpoint changes cannot silently forward a saved or inherited key » ; `T/model-selector-visual.cjs` ; `T/bridge-real.cjs` ; `T/settings-folder-danger-visual.cjs` (mode, exclusions, prompt personnalisé) ; `T/final-e2e-lot2.cjs` ; effet des exclusions : `T/workspace.test.mts` — « workspace rejects traversal, ignored files… » | — |
| 21 | Actions sensibles | prouvée | `R/components/settings/DangerTab.tsx:28` ; `W:550-557` ; `C/conversations.mts:93` | `T/settings-folder-danger-visual.cjs` (confirmation, Annuler n'efface rien, fichiers projet intacts) ; `T/worker-danger.test.mts` — « remove-folder drops the history entry but never touches the files » ; `T/final-e2e-lot2.cjs` | — |
| 22 | Contexte et mémoire | prouvée | `R/state/context.ts:20-60` ; `R/components/ContextBar.tsx` ; `C/compact.mts:22-87` ; `W:141-163,476-497` ; `C/context.mts:30-33` | `T/context-visual.cjs` ; `T/final-e2e-lot5.cjs` ; `T/worker-compact.test.mts` — « worker::compact asks the model with NO tool… », « …keeps a tool call together with its result… » ; `T/context.test.mts` (mémoires globale et projet dans la vraie requête) | — |
| 23 | Apprentissages | prouvée | `C/context.mts:34-50` (chargement, filtre `confirmed`, dédoublonnage après filtrage, 20 max) | `T/context.test.mts` — « legacy instructions, custom prompt, memory and confirmed learnings reach the actual provider request » (id non confirmé côté projet, confirmé côté global : le confirmé est injecté) ; « optional corrupt learnings report a warning without corrupting or suppressing project instructions » | **Décision délibérée** : création/suppression non portées. Lot « audit indépendant + résumé de compaction persisté en mémoire projet (2026-10-01) », ligne 2928 : « `context/learnings.py::new_learning` … sont du code Python mort (jamais appelés nulle part…) — rien à porter ». `delete_learning` n'avait pas d'appelant non plus. |
| 24 | Providers | prouvée | `C/connections.mts:6-12` (8 fournisseurs) ; `C/provider.mts:33-37,134` ; `C/agent.mts:68-153` (garde de répétition `:87-127`, `maxSteps` `:72-73`) ; `C/system-prompt.mts:5-28` ; `C/local-engine.mts:107` | `T/provider-parity.test.mts` (vrai serveur HTTP local, plafond par fournisseur pour les 8, erreurs, reprises, inactivité) ; `T/agent.test.mts` — « provider decodes split UTF8/SSE… », « the repeat guard counts consecutive identical calls… », « provider preserves a Gemini tool signature… » ; `T/system-prompt.test.mts` — « ask and plan add their instruction; auto adds none » ; `T/model-selector-visual.cjs` (sélection explicite openrouter → ollama) ; `T/stop-visual.cjs` | **Décisions délibérées** : modes ask/plan en lecture seule ; détecteur de boucle simplifié et pré-fetch web non porté (« Bilan du lot — audit indépendant + persistance du résumé de compaction (2026-10-01) » : « Écart mineur évalué et délibérément NON porté… même discipline que la Tâche 87 (pré-fetch web) ») ; nœuds raisonnement/critique absents, jugés « not a loss » dans `docs/superpowers/specs/2026-10-03-agent-core-audit.md` (cette décision n'est dans aucun bilan de `todo.md`). |
| 25 | Modèles Ollama | **décision délibérée** | Reste : `ollama` comme point d'accès compatible OpenAI (`C/connections.mts:10`) | Sélection persistée d'un modèle ollama : `T/model-selector-visual.cjs` | Détection, téléchargement et progression écartés : lot « fournisseur local intégré (fichiers .gguf) (2026-09-27) », décision verbatim (« j'aime pas la merde qu'est ollama, lm studio etc… ») ; « Bilan du lot — écarts réels restants NiceGUI → Electron (2026-09-27 → 2026-09-30) ». |
| 26 | LM Studio | **décision délibérée** | Reste : point d'accès `lmstudio` (`C/connections.mts:10`) | — | Même décision (2026-09-27). Aucun chargement, VRAM, dossier de modèles ni désinstallation. |
| 27 | llama.cpp | **décision délibérée** | Remplacé par le moteur intégré : `C/gguf-library.mts:28`, `C/local-engine.mts:56-115`, `C/local-provider.mts` ; `W:317-322` ; `M:199-202` `pick-gguf` | `T/gguf-library.test.mts` ; `T/local-engine.test.mts` — « the model stays warm across two calls on the same path, and disposeEngine really frees it » ; `T/worker-local-model.test.mts` ; `T/local-model-visual.cjs` ; `T/final-e2e-lot13.cjs` | Même décision (2026-09-27) : plus de serveur externe ni de détection matérielle ou de catalogue ; l'import `.gguf` remplace l'installation. |
| 28 | Catalogue HF | **décision délibérée** | — | — | Même décision (2026-09-27) ; « Bilan du lot — écarts réels restants… » : « Catalogue de modèles HuggingFace + intégration Ollama/LM Studio/llama.cpp externe — explicitement rejeté par l'utilisateur ». |
| 29 | Téléchargements | **décision délibérée** | — | — | Lot « assistant de premier lancement (2026-09-25) », ligne 2034 : « Reste NON migré : 📥 Téléchargements (dépend du catalogue LM Studio, lui-même non migré) », puis la décision du 2026-09-27. `todo.md` ligne 12 note que la case n'a pas été réécrite. |
| 30 | Index projet | **partielle** | `C/embeddings.mts:38` (ONNX, sans Python) ; `C/semantic-index.mts:9-10` (exclusions), `:63-95` (reconstruction complète), `:97` recherche ; `W:66-85` (asynchrone + événements), `W:465` ; `R/components/ContextBar.tsx:49` | `T/semantic-index.test.mts` — « indexFolder scans, chunks, embeds real files… » (node_modules exclu, progression), « re-indexing after a file is deleted purges its stale chunks… » ; `T/worker-index-status.test.mts` ; `T/index-status-visual.cjs` ; `T/search-tools.test.mts` ; `T/worker-search-tools.test.mts` | **Modifier un fichier puis rechercher** : non testé (seule la suppression l'est). Constat hors parité : l'index n'applique ni `ignored_patterns` ni le filtre de fichiers secrets des outils fichiers (un `secrets.json` est indexé et lisible via `semantic_search`), comme en Python. |
| 31 | Connaissances | prouvée | `C/knowledge-base.mts:41,66,78,84,95` ; `W:459-461` ; `M:205-208` ; `R/components/KnowledgeSection.tsx` | `T/knowledge-base.test.mts` (ajout, remplacement par source, suppression ciblée, recherche réelle) ; `T/worker-knowledge.test.mts` ; `T/knowledge-visual.cjs` | « Migration du texte existant » non implémentée, mais l'inventaire exigé par la spec a été fait : lot `index_status` (ligne 2761) établit que `add_to_knowledge` n'était appelé nulle part en Python, donc la collection Chroma `knowledge` n'a jamais été alimentée par l'app. |
| 32 | Plugins | **partielle** | `C/plugin-loader.mts:8,15-36,78-117` ; `W:239-248,432-444` ; `R/components/settings/ToolsTab.tsx` ; confiance `C/project-trust.mts:78` | `T/plugin-loader.test.mts` (3 dossiers, erreurs isolées, tout-ou-rien, rechargement) ; `T/worker-plugin.test.mts` — « worker::send registers a real plugin tool and actually calls it end to end » ; `T/plugin-visual.cjs` ; `T/trust-visual.cjs` | **Diagnostic des anciens `.py` absent** : `pluginFiles` (`C/plugin-loader.mts:40-46`) ne garde que `.mjs`/`.mts` et ignore les `.py` en silence, alors que la matrice et `docs/superpowers/specs/2026-09-14-electron-autonomous-design.md` (« détectés et signalés comme nécessitant un portage, jamais chargés silencieusement ») l'exigent. Décision délibérée : plugins Python remplacés par des plugins Node (« Bilan du lot — système de plugins Node (2026-10-01) »). |
| 33 | MCP | **partielle** | `C/mcp-config.mts:75,177,253` ; `C/mcp-client.mts:38-86` (stdio, `killTree` à la fermeture), `:217` ; `W:180-213,222-233,453-456` | `T/mcp-client.test.mts` (vrai processus enfant : découverte, appel, erreur, crash isolé, délai) ; `T/mcp-config.test.mts` (env) ; `T/worker-mcp.test.mts` — « worker::send registers a real configured MCP server's tools and actually calls one » ; `T/mcp-visual.cjs` ; `T/worker-trust.test.mts` — « nothing a project brings runs before approval… » | **« Aucun lancement à l'ouverture des réglages » non respecté** : l'onglet Outils appelle `plugin-list` à son montage (`R/components/settings/ToolsTab.tsx:66`), qui exécute `nonPluginTools` → `mcpTools` (`W:441`, `W:183`) et démarre donc tous les serveurs MCP globaux et ceux d'un projet approuvé. `T/worker-trust.test.mts` asserte même « started once trusted » après `plugin-list`/`mcp-list`. L'arrêt du processus après usage n'est asserté par aucun test. |
| 34 | Outils fichiers | prouvée | `C/workspace.mts:121-242` (read/view/list/create/edit/create_dir/delete_file/delete_dir/grep_file/glob/grep_codebase) | `T/workspace.test.mts` (confinement, jonctions, secrets, corbeille) ; `T/workspace-search.test.mts` | Décision L4 (audit 2026-10-03) : `edit_file` refuse une chaîne ambiguë. |
| 35 | Outils shell/web | prouvée | `C/shell-tool.mts:12,36,62,76,145-191` ; `C/process.mts:24,42` ; `C/web-tools.mts:227-316` | `T/shell-tool.test.mts` — « run_command runs in the real project root », « a command that exceeds its timeout is killed with everything it started », « a dev server is started in the background… » ; `T/web-tools.test.mts` (vrai HTTP, Tavily, DDG, plafonds) ; `T/worker-tools.test.mts` ; `T/final-e2e-lot3.cjs` | Non portés volontairement (lot « outils du moteur Node », sans bilan daté) : `_normalize_paths` et `agent_actions.log`. L3 (audit 2026-10-03) : `topic=news` sans Tavily n'est plus une recherche d'actualités. |
| 36 | Outils Git | prouvée | `C/git-tools.mts:56,91-159` ; `C/git-safety.mts:49` | `T/git-tools.test.mts` (les 15 outils, dont `git_pull` en avance rapide ; arguments-options refusés, `ext::` refusé, push forcé et suppression refusés, config du dépôt neutralisée) ; `T/final-e2e-lot3.cjs` | — |
| 37 | Outils mémoire | prouvée | `C/memory-tools.mts:80,89-155` | `T/memory-tools.test.mts` (portées, entrée entière supprimée, faits vides refusés, écritures concurrentes, liens refusés, fichiers temporaires) | — |
| 38 | Sessions/données | prouvée | `C/json-store.mts:32-68` (sauvegarde `.pre-electron.bak`, écriture atomique) ; `C/conversations.mts:36-49` (lecture de l'ancien `chat_history.json`) ; `C/cleanup.mts:23` ; `C/data-dir.mts:46` ; `C/connections.mts:40` (`.env` historique) | `T/storage.test.mts` — « atomic updates preserve every concurrent increment and the original backup », « malformed data refuses updates without altering the damaged original », « legacy history survives fork edits, reopening and other projects », « a JSON null conversation cannot silently discard existing migrated data » ; `T/connections.test.mts` — « legacy .env is read without mutation… » ; `T/cleanup.test.mts` ; `T/data-dir.test.mts` | Décisions délibérées : sessions CLI (`~/.openagentic/sessions`) abandonnées avec la CLI (« Bilan du lot — bascule finale sans Python (2026-10-04) » : « Abandonné : la commande `openagent` (CLI Python) ») ; journal `agent_actions.log` « Non porté volontairement » (lot outils). Limite : les formats hérités sont prouvés sur des fixtures écrites à la main, pas sur des fichiers produits par l'app Python (`todo.md` ligne 9 le note). |

## Lignes non prouvées : ce qui les fermerait

### 1. Fenêtre et lancement (partielle)
- **Écart fonctionnel à trancher** : fermer la fenêtre quitte l'app (`M:291`). Soit porter le comportement
  Python (sur `close`, cacher la fenêtre ; `showMainWindow` recrée une fenêtre détruite ; « Quitter » appelle
  `app.quit()`), soit consigner la décision et corriger le commentaire `M:95-97`.
- **Test** : dans un script `final-e2e` (exe packagé), lancer une seconde instance avec le même
  `OPENAGENT_USERDATA_DIR` ; vérifier qu'elle sort en code 0 en moins de quelques secondes et que la première
  répond toujours en CDP avec une seule cible de page.

### 2. Projets (partielle)
- **Fonction manquante** : un champ de saisie du chemin à côté de « 📂 Ouvrir un dossier », qui appelle
  `activateFolder`. Le refus d'un chemin relatif ou inexistant existe déjà dans `FoldersService.recordOpened`.
- **Test** : dans `sidebar-visual.cjs`, taper un chemin réel, valider, vérifier l'entrée active et
  `folders.json`. Asserter aussi le texte de `.oa-folder-path` (chemin tronqué + date).

### 6. Conversation (partielle)
- **Fonctions manquantes** :
  - afficher un détail (chemin, commande ou requête) dans l'en-tête de `ToolMessage`, dérivé des arguments de
    `tool-start` ;
  - au chargement d'un historique, reconstruire `_tool`/`_category` depuis les `tool_calls` précédents, comme
    le fait déjà `C/export.mts::renderEntries` ;
  - faire renvoyer à `edit_file` un court diff unifié (ou générer le diff côté rendu).
- **Tests à ajouter dans `chat-visual.cjs`** :
  - recharger le dossier et vérifier que le badge WRITE et le nom d'outil restent ;
  - un `edit_file` produit des lignes `+` vertes et `-` rouges ;
  - une réponse avec un bloc ```python rend `pre code.hljs` ;
  - après un long fil, `scrollTop + clientHeight ≈ scrollHeight` sur `[data-testid="oa-chat-scroll"]`.

### 7. Composer (partielle)
- **Tests** : dans `chat-visual.cjs`, envoyer un `keydown` Enter avec `shiftKey: true` : aucune requête au faux
  modèle et le texte reste dans la zone. Puis deux `keydown` Enter consécutifs sans attente : exactement une
  requête reçue par le faux serveur et un seul message utilisateur sur disque.

### 14. Exports (partielle)
- **Test** : dans `export-visual.cjs`, activer un dossier, le rendre inaccessible (le supprimer ou le renommer
  sur disque), cliquer ⬇ → Markdown. Vérifier un toast `negative` « Échec de l'export : … » et qu'aucun
  `open-export` n'a été demandé.

### 16. Apparence globale (partielle)
- **Test** : dans `theme-visual.cjs`, fixer `#oa-accent-input` à `#ff0000` puis émettre `input`/`change`.
  Vérifier `--accent` = `#ff0000`, `config.json.accent_color` = `#ff0000`, puis la valeur encore là après
  rechargement de la page.

### 18. Permissions globales (partielle)
- **Test** : ajouter à la table de `agent.test.mts` (« shell_ask decides… ») des cas catégorie `network` :
  `search_ask: true` demande (refus → non exécuté), `search_ask: false` passe sans demande, `plan`/`strict`
  refusent. Mieux : un test `worker-tools` avec `search_ask: true` qui vérifie le `permission-request` sur
  `internet_search` avant toute requête réseau.

### 30. Index projet (partielle)
- **Test** : dans `semantic-index.test.mts`, indexer, réécrire un fichier avec un contenu différent,
  réindexer. `searchCollection` doit renvoyer le nouveau texte, et l'ancien ne doit plus figurer dans le store.
- Hors parité, à décider : appliquer à l'index le filtre de fichiers secrets et `ignored_patterns` des outils
  fichiers.

### 32. Plugins (partielle)
- **Fonction manquante** : dans `loadPlugins`, signaler chaque `*.py` trouvé dans les trois dossiers par une
  erreur « plugin Python non pris en charge : à porter en .mjs », sans l'importer. L'onglet Outils l'affiche
  déjà via `errors`.
- **Test** : un cas dans `plugin-loader.test.mts` (fichier `.py` → une erreur qui le nomme, aucun outil), plus
  une assertion dans `plugin-visual.cjs`.

### 33. MCP (partielle)
- **Correctif** : `plugin-list` ne doit pas démarrer de serveur. Calculer les collisions contre les noms
  intégrés (et, si besoin, contre les noms MCP mémorisés du dernier tour), sans appeler `mcpTools`.
- **Test** : dans `worker-mcp.test.mts`, configurer un serveur global dont le démarrage écrit un marqueur,
  appeler `mcp-list` et `plugin-list` avec un dossier actif, puis vérifier que le marqueur est absent. Adapter
  l'assertion « started once trusted » de `worker-trust.test.mts` pour qu'elle porte sur un tour, pas sur
  `plugin-list`.
- **Test d'arrêt** : après un appel d'outil MCP, le faux serveur écrit son PID ; vérifier que ce processus
  n'existe plus.

### Lignes « décision délibérée » (25 à 29)
Rien à porter. La matrice et la case de `todo.md` ligne 12 devraient être réécrites pour refléter le
remplacement par le fournisseur `.gguf` intégré. Il faut aussi décider du sort du jeton HuggingFace (ligne 15),
devenu sans consommateur.
