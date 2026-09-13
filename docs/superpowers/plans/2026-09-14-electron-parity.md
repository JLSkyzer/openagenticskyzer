# Matrice de migration NiceGUI → Electron autonome

Date : 2026-09-14. Inventaire statique des sources ; aucun comportement de la nouvelle
application n'est certifié par ce document. Les fonctions listées ont été repérées
dans les modules et leurs gestionnaires. Les cas complexes doivent encore être lus
intégralement et exercés pendant leur portage. Statut initial : **à porter/tester**.

| Domaine | Source historique sous `openagenticskyzer/` | Contrat à reprendre et preuve attendue |
|---|---|---|
| Fenêtre et lancement | `app/main.py` | Instance unique, restauration, tray ouvrir/quitter, fermeture propre ; lancement paquet sans Python |
| Projets | `app/components/sidebar.py` | Dialogue natif + chemin, historique, activation, nom/chemin/date, restauration ; deux projets isolés |
| Git sidebar | `app/components/sidebar.py` | Branche et modifications réelles, échec Git non bloquant ; dépôt temporaire modifié |
| Initialisation | `tools/project_analyzer.py`, `context/project_instructions.py` | Analyse stack/lockfiles/tests/fichiers sensibles, génération OPENAGENT.md, confirmation avant remplacement, priorité CLAUDE/OPENAGENT ; fixtures multi-stacks |
| Premier lancement | `app/components/onboarding.py` | Quatre étapes, retour/suivant/passer, configuration modèle, choix projet, drapeau de fin ; redémarrage |
| Conversation | `app/components/chat.py`, `input_bar.py`, `gui_callback.py` | Messages Markdown/code, images, streaming, journaux outils, détails/diffs, erreurs, scroll bas ; réponse simulée progressive |
| Composer | `app/components/input_bar.py` | Envoyer/arrêter, Entrée/Shift+Entrée, modèle actif, slash-prompts, prévention double envoi ; annulation en cours |
| Pièces jointes | `app/file_processor.py`, `app/main.py`, `input_bar.py` | Fichiers texte/code, CSV, PDF, images, sélection/glisser-déposer, suppression avant envoi, transmission multimodale ; payload capturé |
| Édition et régénération | `app/components/chat.py`, `input_bar.py` | Modifier une question, régénérer depuis dernier utilisateur, blocage pendant génération ; aucun historique tronqué par course |
| Branches | `app/components/chat.py`, `app/state.py` | Fork, libellé, bascule, retour main, reset au changement projet ; persistance indépendante |
| Artifacts | `app/components/artifact_panel.py` | HTML, SVG, Mermaid, Markdown, ouverture/fermeture ; contenu hostile ne peut accéder à l'IPC |
| Palette | `app/components/command_palette.py` | Ctrl+K même dans le composer, recherche et 8 actions existantes ; chaque résultat exécute son action |
| Prompts | `app/components/prompt_library.py`, `app/storage.py` | Bibliothèque, filtre, application de template, chargement prompts personnalisés et 10 défauts ; persistance |
| Exports | `app/exporter.py`, `app/main.py` | Markdown/HTML/JSON de la branche active, détails outils, erreur I/O visible ; relire les fichiers exportés |
| Général global | `app/components/settings.py::_tab_general` | Mode par défaut, restaurer dernier dossier, animations, répertoire de données/migration des sessions, token HF/test ; disponible sans projet |
| Apparence globale | `settings.py::_tab_appearance`, `app/theme.py` | Sombre/clair, accent validé, application et persistance ; capture des deux thèmes |
| Contexte global | `settings.py::_tab_context`, `app/storage.py` | Limite contexte, tokens réservés, auto-compact/seuil, jauge visible, rétention 7/30/90/illimitée ; effets observables |
| Permissions globales | `settings.py::_tab_permissions` | Demander/auto/strict, shell/fichiers/recherche ; moteur réellement restreint |
| Permissions en cours | `app/components/chat.py`, `permissions.py` | Autoriser/refuser/toujours, affichage commande/arguments, refus par défaut, annulation ; aucune exécution avant décision |
| Projet | `settings.py::_tab_folder`, `model_modal.py` | Provider/clé/modèle/base URL par projet, héritage, mode, exclusions, instructions personnalisées ; deux clés factices distinctes, aucune fuite |
| Actions sensibles | `settings.py::_tab_danger` | Effacer sessions/historique ciblés, retirer dossier sans supprimer fichiers, reset global ; confirmation + données voisines intactes |
| Contexte et mémoire | `app/components/context_bar.py`, `context/system_context.py`, `project_memory.py` | Jauge estimée honnêtement, compaction manuelle/auto, mémoire globale/projet injectée, queue conservée, zéro outil en compaction ; capturer la requête LLM |
| Apprentissages | `context/learnings.py` | Chargement/filtre/injection, création/suppression avec format préservé ; déduplication après filtrage |
| Providers | `utils/utils.py`, `graph/`, `agent.py` | Together/Groq/Mistral/Gemini/OpenRouter/Ollama/LMStudio/llamacpp, sélection explicite, streaming/tool-calling, modes, raisonnement/critique, arrêt et anti-boucle ; contrats simulés |
| Modèles Ollama | `app/components/model_modal.py` | Détection, modèles configurés, sélection persistée, téléchargement par nom et progression ; API simulée |
| LM Studio | `app/components/model_modal.py`, `utils/` | Détection, modèles chargés/installés, charger/recharger, URL, dossier modèles, VRAM réserve, contexte, catalogue et désinstallation ; aucune suppression hors modèle confirmé |
| llama.cpp | `app/components/model_modal.py`, `utils/` | Détection, matériel, catalogue compatible, installation GGUF, lancement/arrêt serveur optionnel ; processus suivi |
| Catalogue HF | `app/hf_catalog.py`, `app/components/model_modal.py` | Recherche, filtres, modèles déjà installés, fichiers GGUF multipart, token ; tests pagination/erreurs |
| Téléchargements | `app/components/downloads.py`, `sidebar.py`, `model_modal.py` | Progression persistante durant navigation, état fini/échec, retrait individuel/nettoyer terminés ; pas de faux succès partiel |
| Index projet | `indexer/embedder.py`, `indexer/indexer.py`, `tools/index_tools.py` | Embeddings sans Python, indexation asynchrone, exclusions, progression, recherche sémantique ; modifier/supprimer fichier puis rechercher |
| Connaissances | `indexer/knowledge.py`, `tools/index_tools.py`, `sidebar.py` | Sources, ajouter/rechercher/retirer documents, migration du texte existant ; aucune dépendance Chroma Python |
| Plugins | `plugins/loader.py`, `settings.py::_tab_tools` | Global/projet, découverte, erreurs isolées, outils validés ; port JS et diagnostic explicite des anciens .py |
| MCP | `mcp_client/adapter.py`, `app/storage.py`, `settings.py` | Définitions stdio commande/args/env, liste outils/schémas, appels, erreurs isolées, arrêt ; serveur factice et aucun lancement à l'ouverture settings |
| Outils fichiers | `tools/crud_tools.py` | create/view/read/edit/delete file, grep file/codebase, list/create/delete dir, glob ; confinement et retours d'erreur testés |
| Outils shell/web | `tools/shell_exec.py`, `web_fetch.py`, `internet_search.py` | Commandes Windows dans bon cwd, processus serveurs suivis, timeout/stop, fetch, recherche Tavily/DDG ; sorties plafonnées et permissions |
| Outils Git | `tools/git_tools.py` | status/diff/staged/log/blame/branches/add/commit/push/fetch+ff merge/checkout/create branch/stash/pop ; arguments malveillants rejetés |
| Outils mémoire | `tools/memory_tools.py` | save/read/forget, portée globale/projet, suppression par entrée entière, pas de faits vides ; fichiers temporaires |
| Sessions/données | `context/persistence.py`, `app/storage.py`, `context/session_log.py` | Charger formats existants, sessions et métadonnées, rétention/migration, journal ; migrations sauvegardées et atomiques |

## Écarts déjà confirmés dans le prototype Electron

- `electron/main.cjs::startBackend` lance `python -m ...desktop.backend`.
- Le bouton settings du renderer n'ouvre que les paramètres projet.
- Le bouton commandes se contente de donner le focus au composer.
- L'initialisation affiche un message de conseil au lieu d'initialiser le projet.
- L'ouverture dossier utilise `prompt`, pas le dialogue natif Electron.
- L'index devient « prêt » après chargement d'historique sans preuve d'indexation.
- L'export est du texte, pas les trois formats de l'ancienne interface.

## Écarts historiques à ne pas recopier comme des fonctions achevées

- `_open_knowledge_import` affiche une notification ; ce gestionnaire seul
  n'effectue aucun import. Le nouveau parcours doit réellement importer/indexer.
- Les plugins Python personnalisés et les serveurs MCP Python ne deviennent pas
  JavaScript en changeant de fenêtre : traitement explicite requis.
- Une jauge caractères/4 est une estimation, pas un comptage exact de tokens.

## Règle de clôture

Pour chaque ligne : indiquer fichiers nouveaux, test automatisé exécuté, résultat,
et preuve UI lorsque la fonction possède une entrée UI. Ne cocher aucune ligne sur
la seule présence d'un écran ou sur `node --check`. La fin exige aussi un paquet
Windows testé sans Python, pas simplement `npm start` sur le poste développeur.
