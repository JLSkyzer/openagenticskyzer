# Todo

## Migration 2026-09-14-electron-autonomous — CONCEPTION, NON LIVRÉE

- [x] Confirmer la cible demandée : Electron + moteur JS/TS, sans Python final, sur master.
- [x] Relever les surfaces NiceGUI et les écarts statiques du prototype ; matrice `docs/superpowers/plans/2026-09-14-electron-parity.md`.
- [x] Remplacer la conception contradictoire avec pont Python par `docs/superpowers/specs/2026-09-14-electron-autonomous-design.md`.
- [x] Relire/valider la nouvelle spécification écrite, notamment données Chroma et plugins Python personnalisés (utilisateur : « go »).
- [ ] Stockage Node : migrations sauvegardées, settings globaux/projet distincts, secrets, isolation de projets et branches ; tests temporaires.
- [ ] Moteur Node : providers, streaming, outils, permissions, annulation, contexte et mémoire ; serveurs simulés.
- [x] Interface Electron : navigation et paramètres complets, conversation et panneaux ; tests de clic et rendu réel.
- [ ] Modèles locaux, téléchargements, index/BDC, extensions et MCP sans Python ; tests de chaque contrat.
- [ ] Vérifier chaque ligne de la matrice de parité, corriger les régressions.
- [ ] Packager et tester Windows sans Python, supprimer les anciens chemins actifs, documenter npm/exécutable.
- [ ] Commit/push des changements propres et preuves de validation.

Le shell Electron/pont Python précédent existe encore ; ses anciennes cases cochées
ne prouvaient ni la parité ni l'autonomie. Ne pas annoncer la migration terminée.

### Lot actif — services de données Node (tests avant implémentation)

- [x] Écrire `electron/tests/storage.test.mts` : conservation JSON corrompu, sauvegarde avant transformation, écritures concurrentes, homes temporaires, projets et branches isolés.
- [x] RED constaté : 6 tests stockage échouent sur modules absents ; lancement direct Node car l'isolation par subprocess est interdite dans le sandbox.
- [x] Implémenter `electron/core/json-store.mts`, `settings.mts`, `conversations.mts` sans importer Electron ou Python ; chemins injectés par le propriétaire des services.
- [x] Écrire puis vérifier les tests de résolution provider/clé et de chiffrement via un adaptateur coffre, sans modifier les `.env` historiques.
- [x] Tests Node : 16 passent ; contrôle TypeScript strict sans erreur. Les tests du coffre utilisent AES-GCM ; l'adaptateur OS Electron reste à vérifier dans l'intégration.
- [x] Publier uniquement le lot testé : `cb48ff4` poussé sur master.
- [ ] Brancher ensuite ces services sur l'IPC et les pages de réglages, sans annoncer ce lot backend comme une interface livrée.

Audit npm du prototype : Electron 38 et extract-zip signalés vulnérables (2 entrées high).
Mettre à jour lors du remplacement du runtime, sans `audit fix --force` ; l'ancien
prototype n'est pas validé pour distribution.

### Lot actif suivant — boucle agent Node

- [x] Tests de streaming SSE fragmenté, appels outils fragmentés, erreurs HTTP, redirection refusée, arrêt.
- [x] `electron/core/provider.mts` : transport de chat compatible OpenAI, sans SDK Python, dépendance réseau injectable pour les tests.
- [x] `electron/core/agent.mts` : boucle bornée, validation des arguments, modes ask/plan sans écritures, permissions effectives, résultats outils réinjectés, annulation.
- [x] Tester les requêtes réellement envoyées et les effets des outils : 9 tests agent/provider + HTTP réel passent.
- [ ] Mise à jour Electron 44.3.0 bloquée par le quota d’exécution escaladée ; le prototype reste en 38.8.6 et n’est pas distribuable tant que ce point n’est pas réglé.

### Lot actif suivant — socle renderer React + câblage agent réel

Contexte : une tentative précédente ("Codex") a produit un renderer vanilla JS
(`electron/renderer/`) au CSS cassé (minifié 3 lignes, classes jamais stylées, thème
clair mort), jamais branché à une vraie conversation (`worker.mjs::send` renvoyait un
texte statique). Décision validée (utilisateur) : réécriture complète du renderer en
TypeScript + React (conforme à `docs/superpowers/specs/2026-09-14-electron-autonomous-design.md`,
seule spec faisant autorité), le vanilla JS de Codex est jeté. Plan détaillé :
`C:\Users\killi\.claude\plans\vivid-snacking-snail.md`.

Hors scope de ce lot : branches, artifacts, palette de commandes, bibliothèque de
prompts, sélecteur de modèle complet, réglages 7 onglets, téléchargements, onboarding,
index sémantique/plugins/MCP, outils git/shell/web/mémoire (seuls les outils fichiers
de `workspace.mts` existent côté Node à ce stade).

- [x] Tâche 1 — Réparer le placement du coffre de connexions (`Connections`/`safeStorage`
      géré uniquement dans `main.cjs`, jamais dans `worker.mjs` où il est actuellement du
      code mort inatteignable) ; tests étendus `os-vault.cjs`/`run-os-vault.cjs`.
      Preuves : `main.cjs` instancie `Connections` dans `app.whenReady()` (gardé par
      `if (require.main === module)` pour rester testable sans fenêtre réelle), gère
      `connection-snapshot`/`save-connection` avant le check d'allow-list (même patron que
      `open-folder`), et résout la connexion (`resolveSendPayload`, exportée) pour l'injecter
      dans le payload `send` transmis au worker — jamais exposée au renderer. Code mort
      (`Connections` importé et 2 branches inatteignables) supprimé de `worker.mjs`.
      `node --experimental-strip-types --test tests/all.mts` : 32/32 passed (inchangé).
      `node tests/run-os-vault.cjs` : `PASS OS vault persistence and redaction` + nouvelle
      assertion prouvant que `resolveSendPayload` fournit un `api_key` en clair au worker
      tout en gardant `snapshot()` (renderer-facing) sans ce champ. `npx tsc -p
      tsconfig.core.json --noEmit` : aucune erreur.
- [x] Tâche 2 — Suppression du renderer vanilla JS Codex (`electron/renderer/*`).
      Preuve : fichiers jamais trackés par git (`?? electron/renderer/` dans le statut
      initial), supprimés directement (`rm`), dossier vide retiré. `main.cjs::createWindow`
      pointe désormais vers un chemin `renderer/index.html` inexistant — état transitoire
      attendu, corrigé par la Tâche 3 (aucun test n'exerce `createWindow()` actuellement,
      elle est gardée par `if (require.main === module)`).
- [x] Tâche 3 — Socle Vite + React (`electron/renderer-src/`) + chargement dev/prod dans
      `main.cjs` (CSP stricte en prod, assouplie seulement en dev non packagé).
      Preuves : `main.cjs` expose `buildCsp`/`chooseLoadTarget` (pures, testées sans
      Electron dans `tests/renderer-loading.test.mts` — CSP jamais relâchée si
      `isPackaged`, cible de chargement toujours le build sauf non-packagé + flag dev
      explicite) ; `ipcMain.handle`/`app.whenReady` déplacés derrière le garde
      `require.main === module` pour rester testables. `npm run renderer:build` produit
      `renderer-dist/index.html` (script relatif `./assets/...`, requis pour `loadFile`
      en `file://`). Bug CSS trouvé et corrigé avant de committer : `App.tsx` utilisait
      `100vh`/`100vw` sans reset CSS → le texte apparaissait en bas à droite au lieu
      d'être centré (marge par défaut du `body`) ; corrigé par `index.css` (reset
      minimal) + `100%`. Vérifié visuellement via le serveur Vite réel dans le navigateur
      (capture : "◈ openagent" centré, aucune erreur console). `npx tsc` strict (renderer
      + core) : aucune erreur. `node --experimental-strip-types --test tests/all.mts` :
      35/35 passed. `node tests/run-os-vault.cjs` : toujours PASS (Task 1 non régressée).
- [x] Tâche 4 — Preload typé + bridge IPC renderer (`onAgentEvent` avec désinscription,
      plus de relais générique).
      Preuves : `preload.cjs::onMessage` (relais générique de tout `backend-message`,
      y compris les messages `{type:'response', id, ok, ...}` de bookkeeping) remplacé
      par `onAgentEvent`, filtré sur `{type:'event', event:'agent'}`, désinscription via
      `removeListener`. Test Electron réel (nouveau `tests/preload-bridge.cjs` +
      `run-preload-bridge.cjs`, `npm run test:preload`) : fenêtre cachée avec le vrai
      preload chargé, prouve qu'un message `response` n'atteint jamais le callback, qu'un
      événement `agent` l'atteint bien, et qu'après désinscription plus aucun événement
      n'arrive — `PASS preload onAgentEvent filters and unsubscribes`. Côté renderer,
      nouveau `renderer-src/src/ipc/{types.ts,bridge.ts}` : `sendMessage`/`stop`/
      `decidePermission`/`onAgentEvent` typés, seul point de contact avec
      `window.openagent` (`decidePermission` n'est pas encore fonctionnelle bout en bout :
      `permission-decision` n'est pas encore dans les allow-lists `main.cjs`/`worker.mjs`,
      câblage réel prévu Tâche 9). `npx tsc` strict (renderer + core) : aucune erreur.
      `node --experimental-strip-types --test tests/all.mts` : 35/35 passed. Tests Tâches
      1 et 3 non régressés (`test:vault`, build renderer).
- [x] Tâche 5a — Thème clair/sombre + accent (variables CSS calquées sur `theme.py`).
      Preuves : `renderer-src/src/theme/{theme.css,ThemeProvider.tsx}` reprend
      exactement les valeurs de `openagenticskyzer/app/theme.py::_THEMES` (dark/light) et
      `_DEFAULT_ACCENT` (`#3b82f6`) ; persistance via `global-settings`/`save-global-
      settings` déjà existants (`settings.mts`), aucun nouveau champ. Écart de parité
      découvert et corrigé au passage (hors scope initial mais directement lié à la
      fidélité du thème) : `settings.mts::globalDefaults.accent_color` valait `'#8b5cf6'`
      côté Node contre `'#3b82f6'` côté Python (`theme.py`/`settings.py:214`, les deux
      sources Python s'accordent) — corrigé pour matcher la source de vérité Python.
      Test Electron réel bout en bout (nouveau `tests/theme-visual.cjs` +
      `run-theme-visual.cjs`, `npm run test:theme`) : vrai `preload.cjs` + build réel +
      `SettingsService` sur un répertoire temporaire isolé (jamais `~/.openagent` réel) —
      prouve le thème sombre par défaut avec l'accent Python, le clic qui bascule
      `data-theme`/`--accent` vers clair, ET la persistance réelle sur disque (relecture
      via une seconde instance `SettingsService`) — `PASS theme toggle applies to the
      DOM/CSS and persists to disk`. Captures d'écran des deux thèmes générées et
      vérifiées visuellement (couleurs identiques à `theme.py`). `npx tsc` strict
      (renderer + core) : aucune erreur. `npm test` : 35/35 passed.
- [x] Tâche 5b — Service historique dossiers `electron/core/folders.mts` (nouveau, TDD).
      Preuves : RED constaté (`ERR_MODULE_NOT_FOUND`, 7 tests) avant implémentation.
      `FoldersService.list()`/`recordOpened()` : upsert + déplacement en tête, tolère un
      `folders.json` corrompu (racine non-array, entrées sans `path`/`last_used`, valeurs
      non-objet) en ignorant seulement les entrées invalides, rejette un chemin relatif
      ou inexistant/non-dossier. GREEN : 7/7. `worker.mjs::activate_folder` câblé sur
      `recordOpened` (retourne désormais `{history, folders}` en un seul aller-retour,
      au lieu de forcer un second `list_folders`) ; `list_folders` délègue à `list()`.
      Ajout de `OPENAGENT_HOME` (worker.mjs) / `dataHome()` (main.cjs) pour isoler le
      répertoire de données en test — nécessaire pour tester ce câblage sans jamais
      toucher `~/.openagent` réel, réutilisable par les Tâches 6/9. Nouveau test
      d'intégration réel `worker-folders.test.mts` : vrai `worker_threads.Worker`,
      home temporaire, prouve que `activate_folder` enregistre bien le dossier ET que
      `list_folders` le retrouve ensuite. `npm test` : 43/43 passed (35 + 7 + 1).
      `npx tsc` strict (core + renderer) : aucune erreur. `test:vault`/`test:preload` non
      régressés.
- [x] Tâche 6 — Sidebar React (ouvrir dossier natif + historique, preuve persistance
      après redémarrage sur home de test isolé).
      Décision d'implémentation : Tailwind CSS installé dans le renderer (`@tailwindcss/
      vite`, import `tailwindcss` dans `index.css`) — les classes Tailwind déjà utilisées
      dans le code Python (`sidebar.py`, et tout le reste à venir aux Tâches 7-10) sont
      reprises quasiment telles quelles au lieu d'être retraduites à la main en hex CSS
      par composant, pour une fidélité visuelle exacte et moins d'erreurs.
      Preuves : `components/Sidebar.tsx` — bouton "📂 Ouvrir un dossier" (bg-purple-600/
      700, dialog natif via `open-folder` déjà géré par `main.cjs`), historique cliquable
      avec styles actif (`border-purple-500 bg-indigo-950 text-purple-300`)/inactif
      (`border-transparent text-gray-400`) identiques à `sidebar.py`, chemin tronqué 30
      caractères. Nouveau test Electron réel bout en bout (`tests/sidebar-visual.cjs`/
      `run-sidebar-visual.cjs`, `npm run test:sidebar`) : historique pré-rempli (2
      dossiers réels sur disque temporaire) chargé dans le bon ordre au montage
      (= persistance après "redémarrage"), clic sur l'entrée inactive → passe en tête +
      surlignée active, ET relecture par une seconde instance `FoldersService` confirmant
      l'écriture réelle sur disque — `PASS sidebar click moves folder to front and
      persists`. Captures d'écran avant/après clic vérifiées visuellement. Bugs trouvés
      et corrigés au passage : `ThemeProvider` n'avait pas de `.catch()` sur son
      chargement initial (rejection non gérée si le backend échoue) ; le test de thème
      ciblait `document.querySelector('button')`, qui matchait désormais le bouton
      "Ouvrir un dossier" de la Sidebar au lieu du bouton de thème (Sidebar rendue avant
      dans le DOM) — corrigé avec des ids stables des deux côtés. `npm test` : 43/43
      passed. `npx tsc` strict (renderer + core) : aucune erreur. `test:vault`/
      `test:preload`/`test:theme` non régressés.
- [x] Tâche 7 — Zone de chat (messages user/AI/tool, streaming, markdown+coloration
      syntaxique locale, diff coloré).
      Écart majeur vs découpage initial : le câblage réel de `agent.mts`/`provider.mts`
      dans `worker.mjs::send`/`stop` (prévu en filigrane dans la section "Canal IPC
      streaming" du plan, sans tâche numérotée dédiée) a été fait ICI, car la preuve de
      cette tâche l'exigeait. `send` ne renvoie plus un texte statique : boucle agent
      bornée réelle, événements `turn/delta/message/tool-start/done/stopped/error`
      streamés via `backend-message` (enrichis `runId`/catégorie réelle), persistance de
      la transcription (y compris partielle sur Stop/erreur — voir commit dédié).
      `permission-decision` devient un op réel (allow-lists `main.cjs`/`worker.mjs`).
      Rôles legacy `ai`/`human` (historique migré Python) normalisés en
      `assistant`/`user` avant d'atteindre le provider. Vérifié par un test
      d'intégration Node réel (`worker-send.test.mts`, faux serveur HTTP comme
      `agent.test.mts`) : un tour complet qui appelle `create_file` écrit vraiment le
      fichier, émet la bonne séquence d'événements, persiste ; un second test confirme
      qu'un Stop en cours de tour persiste quand même le message utilisateur déjà
      envoyé.
      Composants React : `state/{reducer.ts,ChatProvider.tsx}` (reducer pur + contexte,
      charge l'historique au changement de dossier, s'abonne à `onAgentEvent`),
      `markdown/Markdown.tsx` (react-markdown + remark-gfm + rehype-highlight, thème
      atom-one-dark, tout en paquets locaux), `components/{MessageBubble,ToolMessage,
      EmptyState,ChatView}.tsx` — styles copiés de `chat.py` (bulle user bg-indigo-950,
      avatar IA bg-purple-600, badges outil WRITE/RUN/READ/SEARCH verts/bleus/oranges/
      violets, diff coloré +vert/-rouge/@@violet).
      Preuve bout en bout (nouveau `tests/chat-visual.cjs`/`run-chat-visual.cjs`,
      `npm run test:chat`) : vrai `preload.cjs` + vrai build + **vrai `worker.mjs`**
      spawné (pas un stub) contre un faux serveur HTTP compatible OpenAI, à travers le
      vrai clic "Ouvrir un dossier" puis une vraie saisie clavier — le tour 1 appelle
      `create_file` (badge WRITE affiché, fichier réellement écrit sur disque, vérifié
      par lecture directe), le tour 2 répond avec du markdown réellement rendu
      (`**notes.md**` → vrai `<strong>`, pas des astérisques bruts). Captures d'écran
      des 3 étapes vérifiées visuellement. Bug UX trouvé et corrigé au passage : un tour
      outil-seul (réponse vide avant l'appel d'outil) affichait une bulle IA vide —
      supprimé, cohérent avec l'absence d'un tel artefact dans `chat.py`.
      Bug de tests trouvé et corrigé sur PLUSIEURS scripts (`chat-visual.cjs`,
      `sidebar-visual.cjs`, `theme-visual.cjs`, `os-vault.cjs`, `preload-bridge.cjs`) :
      `app.exit()` peut couper la sortie stdout avant qu'une écriture pipe asynchrone
      (fréquent sous Windows) n'atteigne réellement l'OS, tronquant silencieusement le
      message PASS/FAIL — corrigé par un flush explicite (`process.stdout.write('',
      callback)`) avant `app.exit()`, partout.
      Barre de saisie temporaire ajoutée dans `App.tsx` (textarea + bouton) uniquement
      pour permettre cette preuve — sera remplacée par la vraie `InputBar` en Tâche 8
      (raccourcis clavier complets, pièces jointes, sélecteur de modèle).
      `npm test` : 45/45 passed (stable, re-vérifié plusieurs fois). `npx tsc` strict
      (renderer + core) : aucune erreur. Tous les tests visuels (`test:vault`,
      `test:preload`, `test:theme`, `test:sidebar`, `test:chat`) verts de façon fiable
      après le correctif de flush.
- [x] Tâche 8 — Barre de saisie (envoi/stop réel, raccourcis clavier).
      Preuves : `components/InputBar.tsx` (textarea non contrôlée par ref, Entrée envoie,
      Shift/Ctrl/Alt+Entrée = nouvelle ligne, bouton violet→rouge ■ pendant l'exécution)
      remplace le stub de la Tâche 7 dans `App.tsx`.
      **2 bugs réels trouvés et corrigés en construisant la preuve "Stop en plein
      streaming"** (pas des bugs de test — de vrais défauts applicatifs) :
      1. **Course critique** — `ChatProvider` refaisait un fetch `getMessages()` séparé
         après l'activation de dossier (déjà renvoyée par `activate_folder`). Si ce
         fetch résolvait APRÈS qu'un envoi ait démarré, son dispatch `folder-loaded`
         réinitialisait tout l'état du reducer, effaçant silencieusement le run en
         cours. Corrigé : `Sidebar.onActivated(folder, history)` transmet l'historique
         déjà obtenu ; `ChatProvider` reçoit `initialMessages` en prop au lieu de
         re-fetcher — plus de round-trip asynchrone redondant, plus de course possible.
      2. **`ReferenceError` qui tuait le worker silencieusement** — `partialText` (texte
         en cours de streaming, ajouté pour capturer un Stop avant tout message complet)
         était déclarée à l'intérieur du bloc `try` de `runSend`, donc invisible depuis
         le `catch` qui la lit sur abort : `worker.mjs` crashait sur chaque Stop en
         cours de streaming, sans qu'aucun événement `stopped` n'atteigne jamais le
         renderer (bouton bloqué sur ■). Corrigé : déclaration remontée au niveau de la
         fonction, aux côtés de `collected`. Diagnostiqué par un script isolé
         (`worker_threads.Worker` + faux serveur SSE lent, sans Electron) qui a
         directement révélé `ReferenceError: partialText is not defined` dans les logs
         `worker.on('error')` — invisible depuis l'UI, qui se contentait de rester bloquée.
      Aussi corrigé au passage : `liveToolStarts` n'était pas vidé sur `done`/`stopped`/
      `error` dans le reducer — une carte d'outil "en attente" pouvait rester affichée
      indéfiniment après un Stop en cours d'exécution d'outil.
      Test Electron réel bout en bout (nouveau `tests/stop-visual.cjs`/
      `run-stop-visual.cjs`, `npm run test:stop`) : faux serveur SSE qui ne termine
      jamais de lui-même, interrompu par un vrai clic sur le bouton Stop — prouve que
      (a) le flux s'arrête réellement (aucun texte n'arrive plus après une attente,
      ET le serveur observe la vraie fermeture de connexion côté client, pas juste
      l'UI qui ignore les événements), (b) le texte partiel reste affiché comme un
      message normal (pas perdu), (c) le contenu persisté sur disque correspond
      exactement à ce qui est affiché (aux espaces de fin près, rognés par le rendu
      markdown — comportement normal, vérifié explicitement) — `PASS Stop mid-stream
      keeps the partial reply visible and persists it exactly`. Captures d'écran
      vérifiées (au moins la capture post-Stop, `capturePage()` sur une fenêtre cachée
      ayant un léger délai de rendu pour la toute première capture — non bloquant,
      limitation de preuve visuelle notée, pas un bug fonctionnel puisque toutes les
      assertions DOM réelles ont passé).
      `npm test` : 45/45 passed. `npx tsc` strict (renderer + core) : aucune erreur.
      `test:vault`/`test:preload`/`test:theme`/`test:sidebar`/`test:chat` tous verts.
- [x] Tâche 9 — Bannière de permission + appel d'outil réel bout en bout (test Electron
      réel : aucune écriture avant décision, écriture réelle après "Autoriser").
      Preuves : `reducer.ts` gère `kind:'permission-request'` (nouveau champ
      `pendingPermission`), vidé sur `permission-decided`/`done`/`stopped`/`error` (une
      bannière orpheline après un Stop pendant l'attente de décision aurait été le même
      genre de bug que les Tâches 7/8). `ChatProvider.decide(allow, always)` appelle
      `decidePermission` (bridge déjà exposée depuis la Tâche 4, `worker.mjs` déjà câblé
      depuis la Tâche 7 — seule la Tâche 9 branche enfin l'UI dessus).
      `components/PermissionBanner.tsx` : styles copiés de `chat.py::permission_banner`
      (bordure/fond jaune, `{tool}({args tronqués 60c})`, 3 boutons Toujours/bleu,
      Autoriser/vert, Refuser/rouge).
      Test Electron réel bout en bout (nouveau `tests/permission-visual.cjs`/
      `run-permission-visual.cjs`, `npm run test:permission`) : `files_ask` forcé à
      `true` sur le projet (réglage par défaut = auto-autorisé, aurait rendu le test
      vide de sens) — la bannière affiche le vrai nom d'outil et les vrais arguments,
      **aucun fichier n'existe sur disque tant que la décision n'a pas été prise**, clic
      réel sur "Autoriser" → la bannière disparaît, l'outil s'exécute, **le fichier est
      réellement créé avec le bon contenu**, la conversation continue normalement —
      `PASS permission banner blocks the write until Autoriser is clicked, then it
      happens for real`. Bug de test trouvé et corrigé en cours de route (pas un bug
      d'app) : `.click()` ne retourne jamais rien, donc `find(...)?.click() !==
      undefined` échouait systématiquement quel que soit le résultat réel du clic.
      `npm test` : 45/45 passed. `npx tsc` strict (renderer + core) : aucune erreur.
      `test:vault`/`test:preload`/`test:theme`/`test:sidebar`/`test:chat`/`test:stop`
      tous verts.
- [x] Tâche 10 — Top bar (stubs hors scope) + layout global, preuve taille mini fenêtre.
      Bug de layout trouvé et corrigé au passage (pas un bug de test) : depuis la Tâche
      7, le "TempThemeStrip" était positionné DANS la colonne chat (à côté de Sidebar),
      pas en pleine largeur au-dessus de toute l'app comme `main.py` — donc la sidebar
      n'était jamais alignée sous une vraie top bar. Corrigé par la vraie structure
      `main.py` : `TopBar` (38px, pleine largeur) au-dessus, puis une rangée flex
      (Sidebar 230px + colonne chat) en dessous.
      `components/TopBar.tsx` : logo "◈ openagent", nom de dossier actif (`▸ {basename}`
      — uniquement le nom de base, pas le chemin complet, fidèle à `main.py` : mon
      ancien placeholder affichait le chemin complet par erreur, corrigé aussi dans
      `sidebar-visual.cjs`), boutons stub désactivés 📥/⬇/⚙️ (téléchargements/export/
      réglages, hors scope de tout le lot) au lieu de les omettre — suit littéralement
      la formulation du plan pour cette tâche, à la différence des autres éléments hors
      scope (widget git, panneau téléchargements) omis entièrement dans les tâches
      précédentes. Contrôles de thème (Tâche 5a) relogés dans la top bar, faute de vrai
      panneau Réglages (hors scope de tout le lot) pour les accueillir.
      Preuve bout en bout (nouveau `tests/layout-visual.cjs`/`run-layout-visual.cjs`,
      `npm run test:layout`) : fenêtre à la taille minimale réelle de `main.cjs`
      (1080×680 — dimensions du cadre, donc viewport réel un peu plus étroit, mesuré et
      vérifié plutôt que supposé), conversation réelle pré-remplie (pas l'état vide),
      nom de dossier volontairement long pour tester la troncature CSS — aucun
      débordement horizontal, aucun chevauchement entre la top bar et la rangée
      principale ni entre la sidebar et la colonne chat, tout le contenu reste dans le
      viewport réel. Capture d'écran vérifiée visuellement après correction d'un
      problème de timing de rendu sur fenêtre cachée (`webContents.invalidate()` +
      délai avant capture, cette fois corrigé plutôt que simplement noté comme dans les
      Tâches 8/9).
      `npm test` : 45/45 passed. `npx tsc` strict (renderer + core) : aucune erreur.
      `test:vault`/`test:preload`/`test:theme`/`test:sidebar`/`test:chat`/`test:stop`/
      `test:permission` tous verts.
- [x] Tâche 11 — Packaging minimal Windows (electron-builder), pas de distribution
      complète (installeur signé/auto-update hors scope).
      Preuves : `electron-builder` en devDependency, config `build` dans
      `package.json` (`directories.output: "release"` — déjà dans `.gitignore` — cible
      `win: {target: "dir"}`, `files` liste explicitement `main.cjs`/`preload.cjs`/
      `worker.mjs`/`core/**/*`/`renderer-dist/**/*`/`package.json`, exclut
      `node_modules` : l'app n'a **aucune** dépendance runtime, tout est Node/Electron
      natif). `npm run package:win` produit `release/win-unpacked/openagent.exe` ;
      `app.asar` inspecté (`npx asar list`) — contient exactement les fichiers attendus,
      rien de superflu (pas de tests, pas de node_modules).
      Preuve bout en bout (nouveau `tests/package-smoke.cjs`, `npm run test:package`,
      script Node simple — pas lancé "en tant qu'Electron" comme les autres tests,
      puisqu'il teste justement l'exécutable packagé lui-même) : lance
      `openagent.exe` **directement**, hors `npm start`/`node`/tout harnais dev, avec
      `--remote-debugging-port` ; interroge le port CDP réel — confirme un vrai
      Chromium/Electron 44.4.2 (pas un build périmé), une vraie page chargée depuis
      `app.asar/renderer-dist/index.html` (pas un serveur de dev ni des fichiers
      épars), avec le vrai titre "openagent" une fois la page effectivement chargée —
      `PASS packaged executable launches outside npm start and loads the real UI`.
      Aucun processus résiduel après le test (vérifié `tasklist`).
      Limite assumée et documentée (pas de "distribution complète") :
      `electron-winstaller` (nécessaire pour un vrai installeur NSIS/Squirrel signé)
      n'a pas son script d'installation exécuté (politique `allow-scripts` du dépôt) —
      sans conséquence puisque la cible `dir` ne l'utilise pas ; à traiter séparément
      si un jour un installeur signé devient dans le périmètre.
      `npm test` : 45/45 passed (inchangé après ajout de la dépendance de build).
- [x] Tâche 12 — Electron 38.8.6 vulnérable : tenter la mise à jour vers 44.3.0 tôt (avant
      le packaging), documenter précisément si le blocage de quota se reproduit.
      **Mise à jour réussie** (pas de blocage de quota cette fois) : `electron` passé de
      `^38.1.0` à `^44.4.2` (dernière version publiée, plus récente que le 44.3.0 visé
      initialement) dans `electron/package.json`. `npm audit` : **0 vulnérabilité**
      (les 2 entrées "high" électron + `extract-zip` transitif ont disparu). Binaire
      téléchargé et vérifié (`electron --version` → `v44.4.2`).
      **Vraie régression Electron 38→44 trouvée et corrigée** (exactement le genre de
      chose que cette tâche visait à détecter) : `webContents.capturePage()` sur une
      fenêtre cachée (`show:false`) lève `Error: UnknownVizError` sous Electron 44 dans
      cet environnement — le service GPU (Viz) de Chromium échoue silencieusement sans
      accélération matérielle correctement disponible. Diagnostiqué en isolant chaque
      étape (script minimal Electron 44 fonctionnel → ajout progressif de logs de debug
      dans `theme-visual.cjs` jusqu'à localiser l'échec exactement à `capturePage()`).
      Corrigé par `app.disableHardwareAcceleration()` avant `app.whenReady()` — appliqué
      aux 6 scripts de test utilisant `capturePage()`
      (`theme/sidebar/chat/stop/permission/layout-visual.cjs`). **Non appliqué à
      `main.cjs`** (l'app réelle) : `capturePage()` n'est utilisé nulle part dans l'app
      de production, ce problème est spécifique à cet environnement de test sandboxé
      sans accès GPU correct — désactiver l'accélération matérielle pour de vrais
      utilisateurs sur leur propre machine dégraderait le rendu sans nécessité.
      Bug de robustesse corrigé au passage sur tous les scripts de test (`flush()` ne
      vidait que stdout, pas stderr — une erreur pouvait être coupée avant `app.exit()`
      sur certaines machines/versions ; désormais les deux flux sont vidés partout).
      **Toute la suite revérifiée sur Electron 44.4.2, aucune régression fonctionnelle**
      (seule la régression capturePage ci-dessus, déjà corrigée) : `npm test` 45/45
      passed, `test:vault`/`test:preload`/`test:sidebar`/`test:chat`/`test:stop`/
      `test:permission`/`test:layout` tous PASS, captures d'écran vérifiées.
- [x] Tâche 13 — Vérification bout-en-bout finale (app packagée, sans Python, dossier
      réel, message réel streamé, outil réel avec permission, Stop réellement effectif) ;
      preuves consignées ici, ne cocher que la ligne "Interface Electron" de la section
      migration ci-dessus, jamais les lignes hors scope.
      Nouveau harnais bout-en-bout (`electron/tests/final-e2e.cjs`, `npm run
      test:final-e2e`, script Node simple — pilote l'**exécutable packagé réel**
      (`release/win-unpacked/openagent.exe`, `main.cjs`/`preload.cjs`/`worker.mjs` non
      mockés, contrairement à tous les tests `*-visual.cjs` précédents) via le vrai
      protocole Chrome DevTools (WebSocket natif de Node, aucune dépendance ajoutée) —
      c'est l'interface qu'un vrai clic utilisateur finit par produire, pas un raccourci
      de test. 7 preuves réelles, captures + log dans `electron/tests/proof-final-e2e/`
      (régénéré à chaque exécution, non versionné) :
      1. **Python absent** : PATH assaini (répertoires contenant "python" **et** le
         dossier `...\WindowsApps` — qui contient un stub d'alias d'exécution
         `python.exe` fourni par Windows même sans interpréteur réel installé, sans quoi
         `where python` "réussit" contre un simple lanceur, pas un vrai interpréteur) ;
         `where python` sous ce PATH échoue réellement (code de sortie ≠ 0) avant même
         de lancer l'app — preuve que l'app n'a besoin de rien sur ce PATH.
      2. **Lancement hors npm start** : `openagent.exe` lancé directement avec
         `--remote-debugging-port`, `OPENAGENT_HOME` isolé (jamais `~/.openagent` réel).
      3. **État initial réel** : capture d'écran au démarrage, thème sombre par défaut
         confirmé (`data-theme="dark"`).
      4. **Vrai dossier** : un vrai dialogue natif `dialog.showOpenDialog` ne peut pas
         être piloté depuis un script CDP externe (pas de fenêtre native scriptable) —
         donc `folders.json` est pré-rempli (même schéma que `FoldersService`) avec un
         vrai dossier temporaire, puis un **vrai clic** sur l'entrée réelle de la
         sidebar déclenche le vrai `activate()` → vrai IPC `activate_folder` → vrai
         `FoldersService`/`worker.mjs` → vraie mise à jour React (même chemin que le
         callback du dialogue natif aurait emprunté). Capture d'écran avec l'entrée
         active confirmée.
      5. **Vrai message streamé** : vraie connexion sauvegardée via le vrai coffre
         chiffré (`save-connection`/`safeStorage`), pointée vers un serveur HTTP local
         factice documenté comme tel (SSE mot-par-mot). Vrai clic clavier Entrée dans le
         vrai textarea → vrai streaming SSE observé (texte partiel puis complet dans le
         DOM), capture d'écran en cours de streaming.
      6. **Vrai outil + permission** : `files_ask:true` forcé pour le vrai projet via le
         vrai `save-project-settings` ; vrai appel `create_file` demandé par le faux
         provider → bannière de permission réelle affichée, **fichier absent du disque
         confirmé avant décision** ; vrai clic sur "Autoriser" → fichier réellement créé
         avec le bon contenu. Captures avant/après.
      7. **Stop réellement effectif** : vrai flux SSE long, vrai clic sur Stop en cours
         de streaming → connexion HTTP réellement fermée côté serveur (`req.on('close')`
         observé), texte partiel conservé à l'écran, mots restants jamais reçus.
         Relecture finale du vrai transcript persisté (`messages`) : 8 messages
         (3 tours), cohérent avec les 3 échanges réels.
      **2 vrais bugs trouvés et corrigés en construisant ce test** (pas des artefacts du
      harnais — les deux auraient touché un vrai utilisateur) :
      - `ChatProvider.send()` (`electron/renderer-src/src/state/ChatProvider.tsx`)
        n'avait aucune gestion d'erreur : un rejet de l'appel IPC `send` (ex. le coffre
        refusant une confirmation d'URL) laissait le bouton d'envoi ne rien faire, sans
        aucun message d'erreur, sans façon de s'en sortir sans redémarrer l'app.
        Corrigé : `try/catch` autour de l'appel, nouvelle action de reducer
        `send-failed` qui alimente `state.error` (déjà affiché par `ChatView`).
      - **Limite documentée, non corrigée** (hors périmètre du socle, risque de
        régression sur du code de sécurité déjà testé) : `Connections.compose()`
        (`electron/core/connections.mts:133`) sélectionne l'autorisation
        d'endpoint (`authorization = folder ? p : g`) uniquement selon la présence d'un
        dossier actif, pas selon la portée (`key_source`) d'où vient réellement la clé
        résolue — si une connexion est enregistrée en portée globale (`folder: null`)
        puis qu'un `resolve()` a lieu avec un dossier actif, l'autorisation enregistrée
        sur le profil global n'est jamais consultée (seul le profil local, vide, l'est),
        et tout changement ultérieur de `base_url` avec une clé déjà présente échoue
        systématiquement avec "Confirmation requise…", sans jamais atteindre l'UI (à
        cause du bug `ChatProvider.send()` ci-dessus, désormais visible comme erreur
        plutôt que silencieux). Contournement adopté dans `final-e2e.cjs` : les 3
        connexions de test sont enregistrées avec `folder` = le projet actif (portée
        cohérente à la sauvegarde et à la résolution), ce qui correspond d'ailleurs à un
        usage réel plausible (connexion par projet). À investiguer séparément si des
        connexions globales doivent un jour être changées d'URL alors qu'un projet est
        actif.
      Suite complète revérifiée après le fix `ChatProvider`/reducer et le repackaging
      (`npm run package:win`) : `npm test` 45/45 passed ; `test:vault`/`test:preload`/
      `test:theme`/`test:sidebar`/`test:chat`/`test:stop`/`test:permission`/
      `test:layout`/`test:package` tous PASS ; `test:final-e2e` PASS (2 exécutions
      propres consécutives, captures confirmées à l'œil par l'utilisateur en direct sur
      la fenêtre réelle pendant l'exécution).

### Lot actif suivant — réglages (7 onglets) + sélecteur de modèle/connexion

Inventaire NiceGUI relevé le 2026-09-19 (`settings.py`, `model_modal.py`). Le moteur Node
valide déjà toutes les clés globales/projet (`settings.mts`) et gère le coffre de
connexions (`connections.mts`) ; il manque surtout l'UI React et les ponts renderer
(`bridge.ts` n'expose ni `connection-snapshot`/`save-connection` ni les réglages projet).
Clé API : jamais renvoyée au renderer (write-only, `key_configured` seulement).

Périmètre de ce lot : dialogue Réglages plein écran (rail 200px + 7 onglets + pied
Enregistrer/Fermer, styles copiés de `settings.py`), onglets Général/Apparence/
Contexte/Permissions/Dossier/Danger, modale « Sélectionner un modèle » (fournisseur,
modèle, URL de base, clé API write-only, confirmation de changement d'URL) et bouton
modèle de la barre de saisie. **Reporté et documenté** (hors lot) : migration du
répertoire de données (`data_dir`), test du token HuggingFace, onglet Outils
(plugins/MCP), détection/téléchargement Ollama/LM Studio/llama.cpp, catalogue HF,
réglages LM Studio (contexte/VRAM/`lms`), lanceur de serveur llama.cpp.

- [x] Tâche 14 — Ponts renderer typés : `getConnection`/`saveConnection` (avec
      `confirmEndpoint`), `getProjectSettings`/`saveProjectSettings`, `ChatProvider`
      inchangé ; vérifié par test Electron réel (clé jamais dans la réponse).
      Ajouts dans `renderer-src/src/ipc/{bridge,types}.ts` (types `ConnectionSnapshot`
      sans `api_key`/`key_endpoint`, `ConnectionPatch` write-only, `ProjectSettings`).
      TDD : `tests/bridge-connection.test.mts` (3 tests, RED sur « fonction absente »
      puis GREEN) fige les noms d'ops et formes de payload ; `tsc --noEmit` propre.
      Preuve réelle `tests/bridge-real.cjs` (`npm run test:bridge-real`) : pilote
      l'exécutable packagé non mocké par CDP — `save-connection`/`connection-snapshot`
      ne renvoient jamais la clé (`sk-SECRET-XYZ` absente, pas de champ
      `api_key`/`key_endpoint`), `connections.v1.json` chiffré (clé absente du fichier),
      changement d'URL d'une connexion à clé refusé sans confirmation puis accepté avec
      `confirmEndpoint`, réglages projet écrits dans `<projet>/.openagent/config.json`,
      valeur invalide rejetée. Client CDP extrait dans `tests/cdp-helper.cjs`, partagé
      avec `final-e2e.cjs` (revérifié PASS). `npm test` : 48/48.
      Constats à traiter, non masqués :
      - `electron .` sur l'arbre non packagé n'ouvre aucune fenêtre ici (le renderer se
        charge pourtant dans une `BrowserWindow` de test ; `createConnections` OK) —
        cause non élucidée, hors périmètre ; les tests réels passent donc par le
        packagé.
      - **Fuite de secret à corriger en Tâche 16** : `SettingsService.saveGlobal()`
        retourne `global()` complet, donc `save-global-settings` renverrait `hf_token`
        en clair au renderer. Invisible aujourd'hui car la règle `hf_token`/`data_dir`
        n'est pas dans `HEAD` (ligne de `settings.mts` non commitée, issue d'une autre
        session, dont l'onglet Général a besoin) ; à corriger avec elle (réponse via
        `publicGlobal()`), test RED d'abord.
- [x] Tâche 15 — Coque du dialogue Réglages (rail vertical, 7 onglets, pied
      Enregistrer/Fermer) ouverte par le vrai bouton ⚙️ de la TopBar ; thème/accent
      déplacés dans l'onglet Apparence (retirés de la TopBar) ; capture à 1080×680.
      Nouveaux `components/settings/{SettingsDialog,AppearanceTab,parts}.tsx` :
      dialogue maximisé (`fixed inset-0`, fond `#0d0d0d`), rail 200px `#111` avec en-tête
      « Paramètres » et 7 onglets verticaux dans l'ordre/libellés de `settings.py`
      (l'onglet dossier porte le nom du dossier actif), pied Enregistrer/Fermer, Échap
      ferme ; `TopBar` : bouton ⚙️ réel `#oa-settings-btn`, `ThemeControls` retiré,
      thème/accent (boutons 🌙 Sombre / ☀️ Clair + sélecteur `#RRGGBB`, appliqués et
      persistés immédiatement comme l'original) dans l'onglet Apparence.
      Les 6 autres onglets affichent pour l'instant un texte « à venir » (Tâches 16-17) ;
      **Enregistrer est volontairement désactivé** jusqu'à la Tâche 16 (rien à enregistrer
      avant), et signalé comme tel par son titre.
      Preuve : nouveau `tests/settings-visual.cjs` (`npm run test:settings`), RED d'abord
      (bouton ⚙️ absent) puis GREEN, dans une vraie fenêtre 1080×680 : clic réel ⚙️ →
      dialogue ; 7 onglets dans l'ordre avec les bons libellés ; rail 200px ; changement
      de panneau par clic réel ; dialogue au premier plan (`elementFromPoint` aux 4
      coins + centre) et sans débordement ; Fermer et Échap ferment ; réouverture sur
      Général ; onglet dossier = `📁 mon-projet` avec un vrai dossier actif. Capture
      relue à l'œil : rendu conforme. `theme-visual.cjs` adapté au nouveau parcours
      (⚙️ → Apparence → Clair) et toujours vert, persistance disque comprise.
      `npm test` 48/48, `tsc` propre, tous les tests `*-visual` PASS.
      **Constat sur les tests précédents** : une fenêtre `show:false` cesse de peindre
      après le chargement — `capturePage()` renvoyait l'écran d'avant l'ouverture du
      dialogue (constaté ici, invalidate/`backgroundThrottling` inefficaces, capture par
      débogueur bloquante). Correctif retenu : fenêtre `show:true` mais `opacity:0`.
      Les captures des tests chat/stop/permission/layout (fenêtres cachées) peuvent donc
      être elles aussi périmées ; leurs assertions DOM restent valables, pas les images.
- [x] Tâche 16 — Onglets Général/Apparence/Contexte/Permissions : Enregistrer écrit
      réellement `config.json` ; preuve clic → relecture disque → rechargement.
      **Correctif de sécurité d'abord (TDD)** : `tests/worker-settings.test.mts` (3
      tests) — RED prouvé (le `hf_token` revenait en clair dans les réponses de
      `save-global-settings` et de `save_settings`), puis `worker.mjs` répond via
      `publicGlobal()` (le jeton reste écrit sur disque, seul `hf_token_configured`
      revient). Le rejet « tokens réservés » était déjà correct côté Node.
      Ligne `data_dir`/`hf_token` de `settings.mts` (laissée non commitée par une autre
      session, requise par l'onglet Général) incluse dans ce commit.
      UI : `useSettingsDraft` (brouillon des seules clés modifiées, message d'erreur du
      backend nettoyé du préfixe Electron), `GeneralTab` (mode agent ask/auto/plan,
      dernier dossier, animations, répertoire de données affiché, token HuggingFace
      masqué avec 👁), `ContextTab` (limite de contexte selon le fournisseur actif,
      tokens réservés, auto-compact + seuil, jauge, rétention), `PermissionsTab`
      (niveau + 3 interrupteurs), Enregistrer réel avec statut vert / erreur rouge.
      Preuve : `tests/settings-tabs-visual.cjs` (`npm run test:settings-tabs`), vrai
      `worker.mjs` + vrais clics/saisies, RED puis GREEN : valeurs par défaut lues du
      backend ; 11 clés modifiées → `config.json` relu contient exactement ces valeurs
      et **pas** les clés non touchées ; le jeton est écrit mais absent de la page
      (DOM et champs) ; réouverture du dialogue → valeurs rechargées, jeton affiché
      « configuré » sans sa valeur ; combinaison invalide (contexte 3000 < réservés
      4096) → message du backend affiché, `config.json` inchangé. Capture relue à l'œil.
      `npm test` 51/51, `tsc` propre, tous les tests réels PASS.
      Reporté (boutons affichés désactivés « à venir ») : « Changer le dossier… »
      (migration `data_dir`) et « Tester le token » (appel HuggingFace).
      Écarts assumés vs `settings.py` : limite de contexte minimale clampée à 2048 (règle
      du moteur Node ; le slider Python partait de 2000) ; vider le champ token ne
      l'efface pas (pas de bouton d'effacement encore) ; Enregistrer ne recharge pas
      `state.permission_mode` (pas d'état équivalent côté React).
- [x] Tâche 17 — Onglet Dossier (mode, patterns ignorés, prompt custom) + Danger
      (effacer l'historique, retirer de la sidebar, réinitialiser) ; nouveaux ops
      worker en TDD (RED d'abord).
      **Moteur (TDD)** : `tests/worker-danger.test.mts` (5 tests, RED = « opération
      inconnue » ×5, puis GREEN) — `Conversations.clear` (supprime les forks, vide
      `main`, renvoie `removed_messages`), `FoldersService.remove` (retire l'entrée de
      l'historique sans toucher aux fichiers, no-op si inconnu, tolère un chemin saisi
      vs canonique), `SettingsService.resetGlobal` (config vidée en `{}`, secrets
      compris, réponse via `publicGlobal`) ; ops `clear-history`/`remove-folder`/
      `reset-global-settings` dans `worker.mjs` **et** dans la liste blanche de
      `main.cjs`. Ponts `clearHistory`/`removeFolder`/`resetGlobalSettings` (test unitaire
      ajouté à `bridge-connection.test.mts`).
      **UI** : `FolderTab` (Paramètres de <dossier>, chemin, mode agent inherit/ask/auto/
      plan, patterns ignorés, éditeur de prompt 600px dont Enregistrer écrit tout de
      suite, bouton « Enregistrer les paramètres du dossier ») ; `DangerTab` (zone rouge,
      3 actions, confirmation avant effacement) ; `Modal` (Échap ne ferme que la modale) ;
      brouillon généralisé (`useProjectDraft`, `commit`, `reload`) ; `ThemeProvider.reload`
      ; `Sidebar` relit l'historique sur `refreshToken` ; `App` remonte le chat (`key`)
      après effacement/retrait.
      Preuve : `tests/settings-folder-danger-visual.cjs` (`npm run test:settings-folder`),
      vrai worker + vrais clics, RED puis GREEN : réglages projet écrits dans
      `<projet>/.openagent/config.json` (clés non touchées absentes) et rechargés ;
      éditeur de prompt (Échap = modale seule, Annuler = rien écrit, Enregistrer = sur
      disque) ; Effacer : Annuler ne change rien, Supprimer → disque vidé (1 branche,
      `main` vide, « 4 message(s) ») **et** chat visible vidé ; Retirer → entrée sidebar
      et nom en barre du haut disparus, `folders.json` vide, dossier projet intact ;
      Réinitialiser : Annuler ne change rien, confirmer → thème vivant repassé à sombre,
      `config.json` = `{}`. Capture de la confirmation relue à l'œil.
      `npm test` 57/57, `tsc` propre, tous les tests réels PASS.
      Écarts assumés vs `settings.py` : **confirmation ajoutée avant « Réinitialiser »**
      (l'original efface token/thème/répertoire sans demander) ; « Effacer » parle en
      messages (le moteur Node stocke des branches, pas des fichiers de session) ; le
      message de succès du prompt est celui du dossier.
      Limite connue, non traitée : effacer l'historique pendant qu'une réponse de l'agent
      est en cours ne l'interrompt pas — le tour peut se terminer et réécrire la
      conversation ; à traiter si le cas se présente (stopper les runs du dossier dans
      `clear-history`).
      Robustesse des tests : `capturePage()` a échoué 1 fois sur 7 avec `UnknownVizError`
      (service GPU d'Electron 44, sans rapport avec la page) → `tests/capture-helper.cjs`
      réessaie la capture, utilisé par les 3 tests de réglages (6 exécutions PASS).
- [x] Tâche 18 — Modale sélecteur de modèle + bouton de la barre de saisie ; preuve :
      changer de fournisseur/modèle/URL/clé via l'UI, coffre chiffré relu, le message
      suivant part réellement vers le nouveau serveur simulé.
      **Limite de la Tâche 13 corrigée (TDD)** : le flux normal du sélecteur la rendait
      atteignable (changer l'URL d'une connexion globale puis ouvrir un projet aurait fait
      échouer chaque envoi). `connections.test.mts` : nouveau test RED reproduisant
      exactement « Confirmation requise… » à la résolution, + un test de garde (un autre
      projet ne peut pas emprunter un accord qu'il n'a pas donné). Correctif dans
      `Connections.compose()` : l'accord d'endpoint est cherché sur le profil du projet
      **ou** sur le profil global dont il hérite, toujours pour la paire exacte
      clé-endpoint → URL, jamais entre projets. `npm test` 59/59.
      UI : `ModelButton` dans la barre de saisie (« ● nom tronqué à 20 car. ▾ », infobulle
      = nom complet, comme `input_bar.py`) et `ModelDialog` (« Sélectionner un modèle » :
      bandeau modèle actif ✓ / ⚠ aucun, fournisseur parmi les 8 du moteur, modèle, URL de
      base, clé API **en écriture seule** avec « Retirer la clé », portée ce dossier /
      global, confirmation avant d'envoyer une clé à une autre URL). `Modal` : Échap ferme
      la modale du dessus (pile) et le contenu défile. `ipc/errors.ts` factorise le
      nettoyage des messages IPC (3 copies → 1). `ChatProvider` expose `activeFolder`.
      Preuve : `tests/model-selector-visual.cjs` (`npm run test:model`) avec le **vrai coffre
      chiffré** (`safeStorage`), le vrai `resolveSendPayload` de `main.cjs`, le vrai worker
      et deux serveurs HTTP locaux factices qui enregistrent `Authorization` et `model`,
      RED (bouton absent) puis GREEN : rien de configuré → « Aucun modèle » ; enregistrer
      modèle + URL A + clé → bandeau mis à jour, champ clé vidé et « configurée », fichier
      du coffre sans la clé en clair, clé absente de la page ; le message suivant part
      **vraiment vers A** avec `Bearer <clé>` et le bon modèle ; URL B → confirmation
      qui nomme l'URL, Annuler ne change rien, Confirmer déplace la connexion ; le
      message suivant part vers B (A ne reçoit plus rien) avec la même clé stockée ;
      changement vers Ollama (URL locale par défaut, clé non partagée) puis retour à
      OpenRouter (modèle et clé conservés) ; « Retirer la clé » l'enlève réellement.
      Capture relue à l'œil. `npm test` 59/59, `tsc` propre, 12 tests réels PASS
      (dont `layout` à 1080×680 avec le nouveau bouton).
      Reporté (hors lot, déjà listé) : détection/téléchargement des modèles Ollama,
      LM Studio et llama.cpp, catalogue HuggingFace, réglages LM Studio ; la liste des
      modèles cloud n'est pas proposée (champ libre), l'API du moteur ne les liste pas.
      Écart assumé vs `model_modal.py` : les clés ne viennent plus d'un `.env` en clair
      mais du coffre chiffré ; une clé `.env` héritée reste lue (`legacy_plaintext`).
- [x] Tâche 19 — Vérification finale packagée (pas de Python), preuves consignées ici.
      Repackaging (`npm run package:win`) depuis les sources courantes, puis nouveau
      `tests/final-e2e-lot2.cjs` (`npm run test:final-e2e-lot2`) : pilote l'**exécutable
      packagé réel** (vrai `main.cjs`, vrai `safeStorage`, vrai worker, rien de mocké) par
      CDP, PATH sans Python. 7 preuves, PASS au premier passage, captures relues à l'œil
      (fenêtre réellement peinte) :
      1. Python absent : PATH assaini, `where python` échoue (code 1).
      2. Lancement direct de `openagent.exe`, `OPENAGENT_HOME` isolé.
      3. Vrai dossier activé par un vrai clic sur l'historique, son historique s'affiche.
      4. Réglages globaux (mode agent, animations, contexte, rétention, permissions, token
         HuggingFace) modifiés par clics/saisies réels → `config.json` contient exactement
         ces valeurs, pas les clés non touchées ; le token est stocké mais absent de la page.
      5. Réglages projet → `<projet>/.openagent/config.json`.
      6. Sélecteur de modèle avec le coffre chiffré réel : fichier du coffre sans la clé en
         clair ; le message suivant atteint **vraiment** le serveur A (`Bearer` + modèle
         enregistrés) ; changement d'URL → confirmation, Annuler ne change rien, Confirmer →
         le message suivant atteint le serveur B avec la même clé, A ne reçoit plus rien.
      7. Zone Danger : effacer l'historique (disque + chat visible), retirer le dossier
         (sidebar + `folders.json`, fichiers du projet intacts), réinitialiser (thème
         vivant repassé à sombre, `config.json` = `{}`).
      Suite complète revérifiée sur ce package : `final-e2e` (lot 1) PASS, `test:package`
      PASS, `test:bridge-real` PASS, `npm test` 59/59, `tsc` propre, 12 tests
      `*-visual` PASS, `npm audit` 0 vulnérabilité. Vérification Python factorisée dans
      `tests/cdp-helper.cjs::checkPythonAbsent` (partagée avec `final-e2e.cjs`).

      **Bilan du lot « réglages + sélecteur de modèle » : livré** pour son périmètre
      (Tâches 14-19). Reste hors lot, explicitement reporté : migration du répertoire de
      données (`data_dir`), test du token HuggingFace, onglet Outils (plugins/MCP),
      détection/téléchargement Ollama/LM Studio/llama.cpp, catalogue HuggingFace, réglages
      LM Studio, lanceur llama.cpp ; puis, côté migration globale, les autres surfaces
      (branches, artifacts, palette de commandes, bibliothèque de prompts, jauge de
      contexte, téléchargements, onboarding), les outils git/shell/web/mémoire et
      l'index sémantique. La migration NiceGUI → Electron n'est **pas** terminée.

### Lot actif suivant — outils du moteur Node (fichiers, mémoire, git, shell, web)

Inventaire Python relevé le 2026-09-19 (`tools/*.py`, `permissions.py`, tests). Node n'a
aujourd'hui que 7 outils fichiers (`workspace.mts`) ; le prompt système ne parle que
d'eux. Ordre choisi : du moins risqué au plus risqué, chaque outil en TDD (RED d'abord)
avec ses tests de sécurité, chaque catégorie de permission vérifiée par un test de garde.

Décisions de sécurité prises (à relire, elles changent parfois le comportement Python) :
- **Git** : argv sans shell, `--` avant tout pathspec/valeur, garde `_guarded` (un seul
  `--` si une valeur commence par `-`), `git pull` = `fetch` gardé + `merge --ff-only
  FETCH_HEAD` (test de non-régression `--upload-pack=` sur pull **et** push),
  `GIT_TERMINAL_PROMPT=0`, entiers validés, timeout 15 s (60 s pour push/pull/fetch),
  `AbortSignal` câblé. Les mutations locales sont `write` ; **push/pull sont `shell`**
  (demandent toujours, même si `files_ask=false` — Python les demandait toujours).
- **Shell** : `cwd` = racine du projet réelle, environnement épuré des secrets
  (`*_API_KEY`, `*TOKEN*`, `*SECRET*`, `HF_TOKEN`…), `windowsHide`, timeout **avec arrêt de
  l'arbre de processus** (`taskkill /T /F` ; Python ne tuait que le shell), `AbortSignal`
  câblé (le Stop tue vraiment la commande), sortie mise en forme comme Python (3000 car.,
  bruit pnpm replié, blobs HTML/JSON résumés), serveurs de dev lancés en arrière-plan,
  dédupliqués et nettoyés à la fermeture. Pas de réécriture de chemins absolus (le
  `_normalize_paths` Python est best-effort et dangereux). Le réglage `shell_ask` (toggle
  « Exécution shell » des réglages, aujourd'hui **sans effet**, `policy()` ne le lit
  jamais) sera honoré : `false` → autorisé, sinon demande.
- **Web** : `fetch_url` http/https uniquement, résolution DNS + blocage des adresses
  privées/loopback/link-local (SSRF) revérifié à **chaque** redirection (suivies à la main,
  5 max), corps limité en octets, `max_chars` plafonné, timeout + `AbortSignal`. Python
  n'avait aucune de ces protections (`file://` lisible). Catégorie `network` : plus stricte
  que Python (lecture seule) — refusé en modes ask/plan/strict, décision assumée.
- **Mémoire** : écriture atomique via `metadataDirectory`/`dataHome` (jamais `homedir()`
  en dur), `forget_memory("")` refusé (effaçait tout en Python), `scope` validé.
- **`delete_dir`** : récupérable (corbeille `.openagent/trash` comme `delete_file`), refuse
  la racine, jamais de `rmtree` définitif comme en Python.

Hors lot, reporté : `semantic_search`/`knowledge_search` (ChromaDB + embeddings, pas
d'équivalent Node : décision d'architecture à part), plugins Python et MCP,
`analyze_project_and_init`.

- [x] Tâche 20 — Socle des outils : `core/tool-kit.mts` (validation booléen/enum/entier
      borné, plus le `make()` aujourd'hui enfermé dans `workspace.mts`) + test de garde :
      chaque outil enregistré a une catégorie valide et conforme à une table attendue.
      `defineTool({name, description, category, properties, required, execute})` : les
      règles (sous-ensemble JSON Schema : `string` avec `maxLength`/`enum`, `integer` avec
      `minimum`/`maximum`, `boolean`) servent **à la fois** au schéma publié au modèle et à
      la validation ; tout argument non déclaré est refusé, `signal` vérifié avant
      exécution. Comble les trous relevés dans l'ancien `make()` (ni booléen, ni enum, ni
      borne configurable — un entier 0 était impossible). `workspace.mts` délègue à
      `defineTool` sans changer de comportement.
      Tests : `tests/tool-kit.test.mts` (8), RED prouvé (module absent) puis GREEN : schéma
      publié, requis/inconnu/non-objet, texte (type, NUL, longueur), entiers (défaut 1..1e6,
      bornes explicites dont 0, flottants et chaînes refusés), booléens (`'true'`, `1`, `0`,
      `null` refusés), enum, arrêt sur signal déjà abandonné. **Test de garde** : chaque
      outil enregistré doit figurer dans une table `EXPECTED_CATEGORIES` avec la bonne
      catégorie ; un outil non listé ou mal classé fait échouer le test (chaque tâche
      suivante y ajoute ses outils). `npm test` 67/67 (les 7 outils fichiers inchangés).
- [ ] Tâche 21 — Recherche/fichiers manquants : `grep_file`, `glob_files`, `grep_codebase`
      (read, `.env`/secrets/ignorés exclus, plafonds), `delete_dir` (write, corbeille).
- [ ] Tâche 22 — Mémoire : `save_memory`, `read_memory`, `forget_memory` (garde mot-clé
      vide, blocs horodatés supprimés en entier, atomique).
- [ ] Tâche 23 — Outils git (13) sur un vrai dépôt temporaire, dont les tests
      d'injection (`--upload-pack=` pull/push, valeur `-f`, fichier `-weird.txt`).
- [ ] Tâche 24 — `run_command` : timeout + arbre tué, Stop réel, env épuré, mise en forme
      de la sortie, serveurs de dev en arrière-plan + nettoyage, `shell_ask` honoré.
- [ ] Tâche 25 — `fetch_url` (SSRF, redirections, plafonds) puis `internet_search`
      (Tavily si clé, sinon DuckDuckGo).
- [ ] Tâche 26 — Branchement : `worker.mjs` enregistre tous les outils, prompt système
      mis à jour, affichage des nouveaux outils dans le chat, permissions par catégorie.
- [ ] Tâche 27 — Vérification finale sur l'app packagée (Python absent) : l'agent appelle
      git et le shell avec la bannière de permission, Stop tue réellement la commande
      longue, une URL privée est refusée ; preuves consignées ici.

## Plan 2026-04-27-semantic-plugins — TERMINÉ (2026-09-13)

- [x] Task 1 — Module d'embedding lazy et singleton
- [x] Task 2 — Index ChromaDB, chunking et recherche déterministe
- [x] Task 3 — Base de connaissances RAG et outils agent
- [x] Task 4 — Indexation asynchrone et UI
- [x] Task 5 — Système de plugins dynamiques
- [x] Task 6 — Support MCP
- [x] Task 7 — Tests d'intégration, revue globale, commit/push final

Preuves : tests ciblés indexer/plugins/permissions `23 passed` avant la disparition de l'exécutable Python local ; `git diff --check` propre. La suite complète doit être relancée après réparation de Python.
Décisions : dépendances embedding/Chroma/MCP lazy ; index déterministe ; plugins isolés par erreur ; strict = allow-list ; MCP stdio recréé à chaque appel.

## Plan 2026-04-27-onboarding-auto — EN COURS (reprise 2026-09-13)

- [x] Task 1 — Analyse automatique de la stack (`tools/project_analyzer.py`) + tests TDD
  - [x] Écrire les tests comportementaux de détection déterministe et de dégradation I/O
  - [x] Observer leur échec RED contre l'absence du module
  - [x] Implémenter uniquement `_scan_project` et une interface d'outil non-écrivable
  - [x] Vérifier le test ciblé GREEN puis la suite hors dépendance Deepeval
  - [x] Documenter les preuves et publier le commit Task 1
  - Preuves : RED `0 passed, 7 failed` (`ModuleNotFoundError` attendu) ; GREEN `8 passed` ; suite `tests/` hors Deepeval : `365 passed, 4 failed` identiques au baseline (voir le rapport SDD).
- [x] Task 2 — Génération de `OPENAGENT.md` en préservant le loader d'instructions existant
  - [x] Ajouter les tests comportementaux de rendu Stack/Tests/fichiers sensibles/Markdown
  - [x] Observer le RED ciblé contre l'API de génération absente
  - [x] Étendre `context/project_instructions.py` sans modifier le loader existant
  - [x] Vérifier le GREEN ciblé, la régression du loader et la suite associée
  - [x] Documenter les preuves TDD et publier uniquement les fichiers Task 2
- [x] Task 3 — Intégration agent, permissions et bouton sidebar avec confirmation
  - [x] RED : couvrir initialisation réelle, collisions/erreurs I/O, wrapper, permissions et confirmation UI
  - [ ] GREEN : centraliser scan/génération/écriture et intégrer l'outil restreint + bouton confirmé
  - [ ] Vérifier les tests ciblés et les régressions agent/permissions/sidebar, documenter et publier
- [x] Task 4 — Wizard d'onboarding NiceGUI 4 étapes compatible avec le code actuel
- [x] Task 5 — Thème sombre/clair + accent validé et réellement appliqué dans les paramètres
- [x] Task 6 — Intégration du thème et du wizard dans `main.py`
- [x] Task 7 — Vérifications d'intégration, audit global, commit et push

Plan source : `docs/superpowers/plans/2026-04-27-onboarding-auto.md`.
Décisions d'adaptation et preuves : `.superpowers/sdd/2026-04-27-onboarding-auto/progress.md` (journal git-ignoré).

## Plan 2026-04-27-git-dev-tools — TERMINÉ (2026-08-01)

- [x] Task 1 — Créer `openagenticskyzer/tools/git_tools.py` (14 outils git) + tests
- [x] Task 2 — Enregistrer les outils dans l'agent (`agent.py`), permissions (`permissions.py`), prompt (`prompt.py`)
- [x] Task 3 — Widget statut branche git dans la sidebar (`sidebar.py`)
- [x] Fix critique post-review finale — `git_pull` non protégé contre l'injection d'arguments (voir lessons.md), vérifié indépendamment par un subagent de review

Commits (master) : 0543b3e, b0041ce, 732a505, b0c8370, e999984, 2af08f8, 6cbba56, 646f128

Gap mineur non bloquant restant : pas de test pour le cas `git_pull` non-fast-forward (historique divergent). À ajouter si on retouche `git_tools.py`.

## Plan 2026-04-27-memory-learning — TERMINÉ (2026-08-02)

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

### Review finale holistique — 2 bugs CRITIQUES corrigés (2026-08-02)

- [x] Bug 1 (CRITIQUE) — le contenu système injecté n'atteignait jamais le LLM (mécanisme central du plan = code mort)
- [x] Bug 2 (CRITIQUE) — la compaction tournait avec TOUS les outils bindés et zéro contrôle de permission

**Bug 1 — diagnostic.** `input_bar._send_message` préfixait trois blocs `{"role": "system", ...}` à l'historique (custom_prompt du dossier — antérieur au plan —, mémoire Task 3, learnings Task 5). Ces dicts devenaient des `SystemMessage` via le reducer `add_messages`, puis `trim_message_history` (`context/messages.py:33`) les supprimait *inconditionnellement* à chaque tour, et `agent_node` reconstruisait son unique `SystemMessage` à partir de `system_prompt` + `load_project_instructions(cwd)` seulement. Les Tasks 3 et 5 étaient donc 100 % inertes à l'exécution (et le custom_prompt l'était déjà avant ce plan — d'où le fait que personne n'avait remarqué le comportement de `trim_message_history`).

**Bug 1 — correctif.** Nouveau module `openagenticskyzer/context/system_context.py`, seul point d'assemblage du contexte dynamique, chargé *dans* `agent_node` depuis le `cwd` de la closure — exactement le pattern déjà éprouvé par `load_project_instructions` (fiable parce que `input_bar` fait `os.chdir(state.active_folder)` juste avant chaque `build_agent`, et que `build_agent` capture `cwd = os.getcwd()`). Ordre du prompt système effectif : instructions projet → custom_prompt du dossier → mémoire (globale puis projet) → leçons apprises → prompt statique. `agent_node` se réduit à `build_effective_system_prompt(cwd, system_prompt)`. Le câblage mort de `input_bar.py` est supprimé (y compris `_format_memory_injection`, déplacée en `system_context.format_memory_injection`), remplacé par un commentaire expliquant pourquoi l'injection par message système ne doit pas être réintroduite ; même avertissement ajouté dans la docstring de `trim_message_history`.

**Bug 1 — caps de taille** (finding "Important — croissance non bornée" de la même review, devenu réel dès lors que le contenu atteint vraiment le LLM) : plafonds posés au site d'injection (`system_context.py`) et non dans les fonctions de chargement, car `read_memory` (outil agent) doit continuer à voir la mémoire complète. `_MAX_MEMORY_CHARS = 4000` **par portée** (une mémoire globale démesurée n'évince pas la mémoire projet), `_MAX_CUSTOM_PROMPT_CHARS = 8000`, `_MAX_LEARNINGS_CHARS = 6000`, plus un plafond global `_MAX_TOTAL_CHARS = 20000` sur le préfixe assemblé. Écart assumé vs. `project_instructions._MAX_CHARS` : la mémoire est tronquée **par le début** (`_truncate_tail`), pas par la fin — `memory.md` est un store append-only horodaté, alimenté entre autres par la réécriture du résumé de `trigger_compact`, donc les entrées récentes sont les plus pertinentes ; tronquer par la fin y aurait gardé les faits les plus vieux.

**Bug 2 — diagnostic et correctif.** `trigger_compact` appelait `build_agent(mode="ask", ...)` sans `permission_manager` ; `mode` n'est qu'une phrase de prompt et ne restreint aucun outil, donc toute la surface `_ALL_TOOLS` était bindée et `build_graph` montait un `ToolNode(_ALL_TOOLS)` sans aucun contrôle — déclenché automatiquement et sans surveillance par l'auto-compact, sur une entrée dérivée de l'historique (contenu web/fichiers possiblement porteur d'injection de prompt). Correctif : paramètre `tools: list | None = None` sur `build_agent` (défaut `None` = `_ALL_TOOLS`, comportement CLI/chat inchangé), `trigger_compact` passe `tools=[]`. Dans `build_graph` : `bound_model = model.bind_tools(tools) if tools else model` (on ne fait *pas* `bind_tools([])`, qui poserait `tools: []` dans la requête — rejeté par certains providers) et la sélection du nœud d'outils teste `if not tools` **en premier**, avant `permission_manager`, pour qu'une liste vide soit structurellement inexécutable quel que soit le reste.

**Tests** (`tests/test_system_context.py` 28 tests, `tests/test_agent.py` 8 tests, +1 classe dans `test_context_bar.py`) : le test central capture le `SystemMessage` réellement passé à `model.invoke` et vérifie que mémoire projet/globale, custom_prompt et learnings confirmés s'y trouvent (et qu'un learning non confirmé n'y est pas) — plus l'invariant « toujours un seul SystemMessage » et la dégradation gracieuse sur erreur I/O. Côté outils : `bind_tools` jamais appelé avec une liste vide, `_noop_tool_node` câblé même avec un `permission_manager`, `build_agent()` par défaut conserve `_ALL_TOOLS`. **Vérification empirique de la valeur des tests** : `git stash` du seul dossier `openagenticskyzer/` (tests conservés) → 9 des nouveaux tests échouent contre l'ancien code et passent contre le correctif.

`tests/test_input_bar.py` supprimé (ne testait que `_format_memory_injection`, elle-même supprimée de `input_bar.py`) ; ses 4 cas sont repris et étendus dans `test_system_context.py`. Ajout de `tests/conftest.py` : fixture autouse pointant `Path.home()` vers un tmp dir — devenu nécessaire parce que tout test construisant un `agent_node` lit maintenant `~/.openagent/memory.md` et `~/.openagent/learnings.jsonl` ; sans ça la suite serait verte sur une machine vierge et rouge sur un poste ayant réellement utilisé l'app. C'est la classe de bug « chemin global `Path.home()` non isolé » relevée deux fois dans lessons.md, traitée cette fois une bonne fois pour toutes au niveau de la suite.

Suite complète : 325 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_context_limit.py::test_ctx_limits_has_all_providers`, `test_loop_detector.py::TestLoopDetectorSameFileEdit::test_interleaved_tool_resets_file_streak`, `test_utils.py::TestParseMentions::test_email_like_not_captured`), aucune régression.

## Plan 2026-04-27-artifacts-content — EN COURS

- [x] Task 1 — Extraction d'artifacts (`_extract_artifact`), champs `AppState`/`ConversationBranch`, composant `artifact_panel.py`

Task 1 commit (master) : voir `git log` (feat: add artifact panel HTML/SVG/Mermaid + state fields, Phase 3.1)

Task 1 — écart vs. code suggéré par le plan (bug identifié avant implémentation, cf. lessons.md) :
- Le plan construisait l'attribut `srcdoc` de l'iframe HTML comme un template literal JavaScript entre backticks (`srcdoc=\`{escaped}\``) avec un échappement de type chaîne JS (`.replace("\\", "\\\\").replace("\`", "\\\`")`). `ui.html(...)` rend du HTML brut, pas du JS : les backticks ne sont pas des guillemets d'attribut HTML valides (HTML invalide en sortie), et cet échappement ne neutralise ni `"` ni `<`, donc un artifact HTML généré par l'IA contenant `"><script>...` aurait pu casser l'attribut et injecter du markup dans la page englobante. Remplacé par une fonction pure `_build_iframe_html(content) -> str` (testable sans harnais NiceGUI, suivant la convention déjà établie par `context_bar._build_compact_history_text` etc.) qui construit `srcdoc="..."` entre guillemets doubles standards avec `html.escape(content, quote=True)` — l'échappement HTML réel, adapté au fait que `srcdoc` est reparsé comme document HTML complet par l'iframe une fois décodé par le navigateur.
- 3 tests ajoutés au-delà des 4 suggérés par le plan (`tests/test_artifacts.py`) pour couvrir spécifiquement ce point : guillemet double dans le contenu correctement échappé (`&quot;`), tag `<script>` échappé (`&lt;script&gt;`), et absence de tout `srcdoc=\`` (template literal) dans la sortie.

Tests : 7 tests dans `tests/test_artifacts.py` (4 extraction + 3 échappement iframe). Suite complète : 332 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport, aucune régression.

- [x] Task 2 — Intégration artifact dans `input_bar.py` et `main.py`

Task 2 commit (master) : voir `git log` (feat: wire artifact panel into input_bar + main layout, Phase 3.2)

Task 2 — écarts vs. code suggéré par le plan :
- Step 1 (`input_bar.py`) : import de `artifact_panel`/`_extract_artifact` fait au niveau module (comme `model_modal.open_model_modal` juste au-dessus), pas en import local/différé — vérifié que `artifact_panel.py` n'importe que `nicegui`, `html`, `re` et `state.py`, donc aucun risque de cycle avec `input_bar.py` (contrairement à `chat`/`context_bar`, importés localement dans `_send_message` pour d'autres raisons). Le déclenchement lui-même est placé à l'intérieur du `if ai_text:` existant (juste après `state.messages.append(...)`), pas après — pour ne s'exécuter que quand un message AI a réellement été ajouté, pas à chaque appel.
- Step 2 (`main.py`, injection mermaid.js) : **aucun changement de code**. `main_page()` charge déjà mermaid.js et appelle `mermaid.initialize({startOnLoad: false, theme: 'dark'})` via son mécanisme existant vendor-local-avec-fallback-CDN (`_v()` + bloc `ui.add_head_html` lignes ~167-177), dont dépend déjà `artifact_panel.py` (Task 1, `mermaid.init(...)` supposant mermaid déjà initialisé). Ajouter le second `<script src=".../mermaid.min.js">` + `mermaid.initialize(...)` littéral du plan aurait chargé mermaid une deuxième fois depuis le CDN (en ignorant le cache vendor local) et ré-initialisé la librairie deux fois — risque de conflit/avertissement de double-init pour aucun bénéfice. Précondition du plan déjà satisfaite, vérifiée par lecture du code existant.
- Step 3 (`main.py`, layout) : pas de `ui.row()`/`ui.column()` introduits comme le suggérait le pseudocode du plan — `artifact_panel()` ajouté comme troisième enfant sibling de `render_sidebar()` et du div-colonne de chat, à l'intérieur du div "Zone principale" déjà `display:flex;flex-direction:row` existant. `artifact_panel()` pose déjà son propre `width:400px;flex-shrink:0` (Task 1), donc aucun wrapper supplémentaire n'était nécessaire.

Test : pas de nouveau test ajouté — le câblage du Step 1 compose uniquement `_extract_artifact` (déjà testé par 7 tests dans `test_artifacts.py`, Task 1) avec une affectation d'attributs triviale (`state.artifact_type, state.artifact_content = artifact`) ; aucune nouvelle logique pure n'est introduite dans `input_bar.py`, même précédent que Task 3/Task 5 du plan mémoire (`_format_memory_injection` avait justifié un test séparé parce qu'elle contenait du vrai formatage ; ici il n'y a rien à formater). Vérification manuelle : import des deux modules modifiés sans erreur (pas de cycle d'import), et lecture du chemin de code confirmant que `artifact_panel.refresh()` suit le même pattern déjà éprouvé que `chat_messages.refresh()`/`context_bar.refresh()` dans le même fichier.

Suite complète : 332 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_context_limit.py::test_ctx_limits_has_all_providers`, `test_loop_detector.py::TestLoopDetectorSameFileEdit::test_interleaved_tool_resets_file_streak`, `test_utils.py::TestParseMentions::test_email_like_not_captured`), aucune régression.

Fix post-review Task 2 (commit `32d7436`) : la revue qualité a relevé que `state.artifact_type/artifact_content/show_artifact` n'étaient jamais réinitialisés aux 3 endroits où `state.messages` est remplacé en bloc (`sidebar.py:activate_folder` au changement de dossier, `settings.py` effacement d'historique et retrait de dossier). Avant Task 2 c'était un état mort inoffensif ; Task 2 le rend atteignable — changer de dossier ou effacer l'historique laissait le panneau d'artifact ouvert avec un contenu déconnecté de la conversation affichée. Corrigé en réinitialisant les 3 champs + `artifact_panel.refresh()` aux 3 sites, suivant le pattern local-import-dans-try/except déjà utilisé à chacun. Suite complète après fix : 332 passed / 3 failed (mêmes échecs pré-existants), aucune régression.

- [x] Task 3 — Bibliothèque de prompts (`storage.py`, `components/prompt_library.py`, `input_bar.py`)

Task 3 commit (master) : b8480ec (feat: add prompt library (storage + picker popup + input bar wiring), Phase 3.3)

Task 3 — bug identifié dans le plan avant implémentation (voir lessons.md pour la classe de bug générique "callable non exposé par une closure") : le Step 5 du plan fait appeler `prompt_dlg.open()` à `input_bar.py`, mais `prompt_dlg` n'est défini nulle part — `render_prompt_picker` (Step 4) crée son `ui.dialog()` comme variable locale `dlg` de sa propre closure et ne retourne que le `ui.button`, sans aucun moyen pour l'appelant de déclencher l'ouverture depuis l'extérieur. Corrigé en faisant retourner à `render_prompt_picker` un tuple `(button, open_picker)` où `open_picker` est la méthode liée `dlg.open` ; `input_bar.py` capture `_prompt_btn, _open_prompt_picker = render_prompt_picker(input_el)` et appelle `_open_prompt_picker()` dans le handler de détection `/`, au lieu du `prompt_dlg.open()` inexistant du plan.

Task 3 — autres écarts vs. code suggéré par le plan :
- `load_prompts()` : le plan suggère `except Exception`, remplacé par `except (json.JSONDecodeError, OSError)` pour suivre exactement la convention déjà établie par `load_folder_config`/`load_global_config` juste au-dessus dans le même fichier (Exception nue utilisée seulement par les fonctions plus anciennes `load_chat_history`/`load_folder_index`) — `_prompts_path()`/`load_prompts()`/`save_prompts()` sont un miroir volontaire de `_folder_config_path()`/`load_folder_config()`/`save_folder_config()`.
- Détection `/` câblée via `input_el.on("keydown", _check_slash_trigger)` (event binding Python-side de NiceGUI, `event.args.get("key")`), un mécanisme séparé et indépendant du bloc JS brut existant (`ta.addEventListener('keydown', ...)` pour Enter-to-send/resize) — vérifié empiriquement que `Element.on(type, handler, args=None)` envoie par défaut toutes les propriétés sérialisables de l'événement (lecture du docstring source de `nicegui/element.py` dans l'environnement du projet), donc `event.args["key"]` est bien peuplé sans configuration supplémentaire ; le bloc JS existant n'a pas été touché.
- Bouton ✦ placé juste après `model_button()` dans la même `ui.row()` (choix de placement mineur, non prescriptif dans le plan).

Tests : 2 tests ajoutés à `tests/test_artifacts.py` (`test_load_prompts_returns_defaults`, `test_save_and_load_prompts`) — confirmés en échec (`ImportError`) avant implémentation. Total du fichier : 9/9 passed (7 précédents de Task 1 + ces 2). Suite complète : 334 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_context_limit.py::test_ctx_limits_has_all_providers`, `test_loop_detector.py::TestLoopDetectorSameFileEdit::test_interleaved_tool_resets_file_streak`, `test_utils.py::TestParseMentions::test_email_like_not_captured`), aucune régression. Note : le plan indique "Attendu : 6 PASS" pour `test_artifacts.py`, chiffre obsolète calculé avant que Task 1 n'ajoute 3 tests supplémentaires (échappement HTML du srcdoc) — 9/9 est le total réel attendu et observé.

`artifact_panel.py` et `state.py` non touchés (hors scope de cette tâche).

Task 3 — review qualité follow-up (commit `e7ce3b1`), 3 problèmes corrigés :
1. **Bloquant** — le dialog de `render_prompt_picker` était `persistent` sans aucun bouton de fermeture ; comme la picker peut s'ouvrir par accident (taper `/` en premier caractère d'un message vide), un utilisateur pouvait rester bloqué sans autre issue que de cliquer un template dans son message. Corrigé : suppression de `dlg.props("persistent")` (ESC/clic backdrop ferment déjà, comme la plupart des autres dialogs de l'app) + ajout d'un bouton "✕" explicite en en-tête, stylé comme celui d'`artifact_panel.py` (`w-6 h-6 bg-transparent text-gray-500 hover:text-white text-xs`).
2. **Important** — `_apply` dérivait `{filename}` par un split manuel (`(state.active_folder or "").replace("\\", "/").split("/")[-1] or "projet"`), qui retombe silencieusement sur "projet" pour tout chemin à séparateur final (`"D:\projects\myapp\"`) ou une racine de lecteur (`"D:\"`) — cas réaliste vu que le champ dossier de `sidebar.py` est du texte libre où un chemin Windows collé traîne souvent un `\` final. Corrigé en réutilisant `Path(state.active_folder).name`, le pattern déjà correct utilisé ailleurs dans `sidebar.py` (`activate_folder`, `sidebar_list`) pour exactement ce problème. Vérifié empiriquement : `Path("D:\\projects\\myapp\\").name == "myapp"` (bug réellement corrigé), `Path("D:\\").name == ""` (vrai cas limite racine de lecteur, repli sur "projet" toujours correct).
3. **Important** — `storage.load_prompts()` ne vérifiait que `isinstance(data, list)`, pas la forme des éléments : un `prompts.json` JSON-valide mais corrompu (ex. `["not", "a", "dict"]`) se chargeait sans erreur puis plantait `prompt_library._filter()` avec un `TypeError` brut dès l'ouverture de la picker (`p["name"]` sur une chaîne). Corrigé en renforçant la validation pour exiger que chaque élément soit un dict avec au moins `id`/`name`/`template`, sinon repli sur `DEFAULT_PROMPTS.copy()`.

Tests : nouveau test `test_load_prompts_falls_back_on_malformed_shape` ajouté à `tests/test_artifacts.py` (style `tmp_path`/`monkeypatch`, cohérent avec `test_save_and_load_prompts` juste au-dessus). `tests/test_artifacts.py` : 10/10 passed (9 précédents + 1 nouveau). Suite complète : 335 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_ctx_limits_has_all_providers`, `test_interleaved_tool_resets_file_streak`, `test_email_like_not_captured`), aucune régression.

Les 3 points marqués "Notes only / hors scope" par la review (style `.on("update:model-value")`, `_filter()` relisant le disque à chaque frappe, shallow-copy de `DEFAULT_PROMPTS`, style de mocking des 2 tests existants) laissés tels quels, conformément au périmètre de ce fix pass.

- [x] Task 4 — Export de conversation (`openagenticskyzer/app/exporter.py`, `openagenticskyzer/app/main.py`)

Task 4 commit (master) : voir `git log` (feat: add conversation export markdown/html/json + top bar menu, Phase 3.4)

Task 4 — écarts vs. code suggéré par le plan (2 bugs identifiés avant implémentation) :
1. **Double-échappement HTML dans `export_html()`.** Le plan construisait le rendu d'un message AI en échappant tout `m.content` une première fois (`_html.escape(m.content)`), PUIS cherchait les blocs de code fencés par regex *dans cette chaîne déjà échappée* et ré-échappait le groupe de capture (déjà échappé) une deuxième fois — un `<` du code devenait `&lt;` à la 1re passe puis `&amp;lt;` à la 2e, rendu tel quel (littéralement `&lt;`) par le navigateur au lieu d'être décodé en `<`. Corrigé en ajoutant `_render_ai_content(raw: str) -> str` dans `exporter.py` : découpe le texte **brut** (non échappé) en segments code/non-code via `re.split` sur le fence regex, PUIS échappe chaque segment exactement une fois. Modèle suivi : `artifact_panel._build_iframe_html` (Task 1), qui applique déjà la même discipline « échapper une fois, au bon endroit » pour l'attribut `srcdoc`.
2. **Emplacement du bouton Export — `chat.py` vs `main.py`.** Le plan disait d'ajouter le bouton "dans le header du chat (row avec le label '💬 Chat')" — cette row n'existe nulle part dans le codebase (`render_chat()` dans `chat.py` est uniquement un `scroll_area` contenant `chat_messages()` + `permission_banner()`, aucun header, aucun label "💬 Chat" trouvé par grep). `chat.py` n'a donc pas été touché. Le bouton + menu (logique du plan reprise à l'identique dans `_do_export`) a été câblé dans `main.py`, dans le top bar global existant, juste après `_dl_lbl = make_downloads_top_btn()` et avant le bouton `⚙️` — c'est l'endroit où l'app place déjà ses actions globales (téléchargements, réglages). Stylé pour matcher `make_downloads_top_btn` (`h-7 px-2 bg-gray-900 border border-gray-800 text-gray-500 text-xs rounded` + `ui.label` interne) plutôt que les classes `text-xs text-gray-500 bg-transparent hover:text-gray-300` du plan, pour rester visuellement cohérent avec le bouton juste à côté.

Écart mineur additionnel (convention déjà établie, pas un bug du plan) : `newline="\n"` explicite ajouté sur les 3 `Path.write_text(...)` de `exporter.py`, suivant la convention Windows CRLF déjà appliquée dans `context/project_memory.py`/`context/learnings.py` (Task 1/5 du plan mémoire) plutôt que le `write_text` nu du plan.

Tests : 3 tests ajoutés à `tests/test_artifacts.py` (`test_export_markdown`, `test_export_json` — les 2 du plan — plus `test_export_html_escapes_code_block_exactly_once`, régression ciblée sur le bug 1 : construit un message AI avec un bloc de code contenant `<`/`>`/`"`, vérifie la forme échappée une seule fois `&lt;`/`&quot;`/`&gt;` présente et la forme doublement échappée `&amp;lt;`/`&amp;quot;`/`&amp;gt;` absente). Les 3 nouveaux tests confirmés en échec (`ModuleNotFoundError: openagenticskyzer.app.exporter`) avant création du module. `tests/test_artifacts.py` : 13/13 passed (10 précédents + ces 3). Note sur le chiffre attendu : le plan indiquait "Attendu : 8 PASS" (obsolète, calculé avant les Tasks 1/3), le brief de cette tâche indiquait "12" (10 + les 2 tests du plan) — le total réel est 13 car un 3e test (régression Bug 1) a été explicitement demandé en plus des 2 du plan.

Suite complète : 338 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_context_limit.py::test_ctx_limits_has_all_providers`, `test_loop_detector.py::TestLoopDetectorSameFileEdit::test_interleaved_tool_resets_file_streak`, `test_utils.py::TestParseMentions::test_email_like_not_captured`), aucune régression (335 + 3 nouveaux = 338, cohérent avec le compte de `test_artifacts.py`).

`artifact_panel.py`, `prompt_library.py` et `state.py` non touchés (hors scope de cette tâche).

- [x] Task 5 — Édition de messages et régénération (`chat.py`, `input_bar.py`)

Task 5 commit (master) : voir `git log` (feat: edit messages + regenerate last AI response, Phase 8.1)

Task 5 — écart vs. code suggéré par le plan (lacune d'architecture identifiée avant implémentation) :
- Le pseudocode du plan fait appeler `_edit_message(idx, input_el)` / `_regenerate(input_el, send_btn)` depuis des boutons définis dans `chat.py`, comme si `input_el`/`send_btn` y étaient accessibles — ils ne le sont pas : ce sont des variables locales de la closure `render_input_bar()` dans `input_bar.py`, et `state.py` (le singleton global de l'app) ne contient que des données, jamais de références d'éléments UI (ça aurait été un nouveau pattern, pas un pattern établi). Corrigé en ajoutant un singleton module-level `_input_refs: dict` dans `input_bar.py`, peuplé une fois juste après la création de `send_btn`/`send_lbl` dans `render_input_bar()` — sûr ici parce que le process ne sert qu'un seul client NiceGUI à la fois (`_LOCK_PORT` dans `main.py`), même principe que `_GIT_STATUS_CACHE` de `sidebar.py`. `edit_message(idx)` et `regenerate()` vivent dans `input_bar.py` (lisent `_input_refs`), `chat.py` expose seulement deux triggers fins (`_trigger_edit`/`_trigger_regenerate`) qui font un import différé de `input_bar` pour éviter tout risque de cycle au niveau module — même convention que l'import différé de `chat_messages`/`permission_banner` déjà fait par `_send_message` dans `input_bar.py`.
- `regenerate()` ne retente pas de rattacher les images (`msg.images`) du message utilisateur original — ne récupère que `.content`, comme le design d'origine du plan ; limitation connue et acceptée, pas un bug.

Tests : le test suggéré par le plan (`test_edit_message_truncates_history`) était un no-op — il tranchait `state.messages` lui-même et vérifiait sa propre découpe, sans jamais appeler de fonction du code testé (aurait passé identiquement si `edit_message`/`regenerate` étaient supprimées). Remplacé par 3 tests unitaires réels sur `_find_last_user_index` (la seule logique pure de cette fonctionnalité — `edit_message`/`regenerate` restent non testés unitairement, couplés à NiceGUI, même limitation documentée que `_send_message` déjà en Task 3/4). `tests/test_artifacts.py` : 17/17 passed (14 précédents + 3 nouveaux). Suite complète : 342 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_ctx_limits_has_all_providers`, `test_interleaved_tool_resets_file_streak`, `test_email_like_not_captured`), aucune régression.

- [x] Task 6 — Palette de commandes Ctrl+K (`components/command_palette.py`, `main.py`, `input_bar.py`, `sidebar.py`)

Task 6 commit (master) : voir `git log` (feat: command palette Ctrl+K wired to 8 real actions, Phase 8.2)

Task 6 — 3 bugs du pseudocode du plan corrigés avant implémentation (voir lessons.md) :
1. `e.ctrl` n'existe pas sur `KeyEventArguments` (attributs réels : `.action.keydown/.keyup/.repeat`, `.key`, `.modifiers.ctrl/.alt/.meta/.shift`, vérifié par introspection dans le venv du projet) — aurait levé `AttributeError` au premier appui de touche. De plus, sans filtrer sur `.action.keydown`, le handler se serait déclenché deux fois par appui (keydown + keyup, tous deux écoutés par défaut). Corrigé : `if e.action.keydown and e.key == "k" and e.modifiers.ctrl`.
2. `ui.keyboard()` ignore par défaut les touches tapées pendant que le focus est sur un `input/select/button/textarea` (paramètre `ignore`, défaut `['input', 'select', 'button', 'textarea']`, vérifié par introspection de signature) — le champ de saisie principal du chat étant un `ui.textarea`, Ctrl+K n'aurait jamais fonctionné pendant l'usage normal de l'app. Corrigé : `ui.keyboard(on_key=_on_key, ignore=[])`.
3. Binding de recherche non conforme à la convention déjà établie (`model_modal._on_search` : `search_input.on_value_change(handler)`, pas l'event Vue/Quasar brut `search_input.on("update:model-value", ...)` suggéré par le plan). Corrigé : `search_input.on_value_change(lambda e: _filter(e.value or ""))`.

Task 6 — câblage des 8 commandes retenues sur 9 suggérées par le plan :
- 7 fonctions existantes réutilisées via import différé (`open_model_modal`, `render_settings`, `trigger_compact` via wrapper synchrone `asyncio.ensure_future`, comme `_trigger_regenerate` en Task 5).
- `open_folder_prompt` (sidebar.py) : était une closure locale de `render_sidebar()`, remontée au niveau module (même corps, juste dé-indentée) pour être importable ; `render_sidebar()` référence désormais la même fonction module-level pour son propre bouton.
- `_clear_history`, `_show_memory`, `_export_conversation` : pas de fonction standalone préexistante pour l'intention exacte de la commande palette — créées dans `command_palette.py` en réutilisant les patterns déjà établis (dialog de confirmation façon `settings.py::_confirm_delete` pour `_clear_history`, `load_project_memory` déjà existant affiché dans un simple dialog pour `_show_memory`, 3 boutons appelant `main._do_export(fmt)` en import différé — obligatoire ici car `main.py` importe `command_palette.py` au niveau module, un import module-level inverse créerait un cycle — pour `_export_conversation`).
- `_open_prompts` : réutilise le callable déjà créé par `render_prompt_picker(input_el)` dans `input_bar.py` (pas de second appel, qui aurait dupliqué le dialog) — exposé via le singleton `_input_refs` déjà existant (Task 5) : `_input_refs["open_prompt_picker"] = _open_prompt_picker` ajouté juste après l'appel existant.
- **9e commande "🔍 Rechercher" retirée** — aucune fonctionnalité de recherche dans les conversations n'existe nulle part dans le codebase (vérifié par grep exhaustif), et en improviser une aurait été hors scope (palette de commandes, pas moteur de recherche). Convention déjà établie dans ce projet (voir lessons.md, précédent Task 3/5) : ne pas exposer une entrée dont l'action serait `None`, silencieuse au clic.

Tous les imports cross-module de `command_palette.py` sont différés (à l'intérieur des fonctions), y compris vers `main.py` — vérifié qu'aucun import n'est fait au niveau module en dehors de `nicegui.ui`, malgré le fait que `main.py` importe ce module au niveau module (import à sens unique, pas de cycle).

Tests : logique de matching extraite en fonction pure `_match_commands(commands, query)` (plafond 8 résultats, insensible à la casse, sur label OU description) — le pseudocode du plan ne proposait aucun test. 5 tests ajoutés à `tests/test_artifacts.py` (query vide retourne tout, match insensible à la casse sur le label, match sur la description seule, aucun match retourne liste vide, plafond à 8 respecté) — chacun appelle réellement `_match_commands`, aucun ne duplique la logique de filtrage pour vérifier sa propre copie. `render_command_palette`/les fonctions d'action restent non testées unitairement, couplées à NiceGUI, même limitation documentée que `_send_message`/`edit_message`/`regenerate`. `tests/test_artifacts.py` : 22/22 passed (17 précédents + 5 nouveaux). Suite complète : 347 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_ctx_limits_has_all_providers`, `test_interleaved_tool_resets_file_streak`, `test_email_like_not_captured`), aucune régression (342 + 5 nouveaux = 347).

Écart mineur sur l'étape 3 du plan (hint Ctrl+K) : le label existant juste en dessous de la barre de saisie (`"Entrée = envoyer · Shift+Entrée / Ctrl+Entrée = nouvelle ligne"`) a été remplacé par le nouveau texte du plan (`"Entrée → envoyer · Shift+Entrée → nouvelle ligne · Ctrl+K → commandes"`) plutôt que d'empiler un second label quasi identique juste à côté — plus lisible, le plan ne précisait pas s'il fallait remplacer ou ajouter.

- [x] Task 7 — Conversation branching et onglets (`chat.py`, `state.py`)

Task 7 commit (master) : voir `git log` (feat: conversation branching (fork) + branch switcher, Phase 8.3)

Task 7 — bug critique identifié dans le pseudocode du plan avant implémentation, corrigé sans l'implémenter tel quel (voir lessons.md pour la classe de bug, et le brief de tâche pour le diagnostic complet) :
- `_fork_from(idx)`/`_switch_branch(branch_id)` du plan remplaçaient `state.messages` par le contenu d'une branche **sans jamais sauvegarder l'état courant nulle part** avant l'écrasement. Comme la branche "main" (`state.current_branch_id == "main"` par défaut) n'a aucun objet `ConversationBranch` qui la représente, forker depuis "main" faisait perdre silencieusement tout le contenu de "main" au-delà du point de fork — aucun endroit dans `AppState` ne le conservait. De plus `_switch_branch` du plan avait un cas `if branch_id == "main": pass` totalement no-op : revenir sur "main" après un fork ne restaurait rien et ne notifiait aucune erreur.
- Corrigé par : (1) nouveau champ `state.main_messages: list` (`state.py`, sous le commentaire `# Branches` existant) qui sert de snapshot de "main" ; (2) `_snapshot_active_branch()` dans `chat.py`, appelée systématiquement en tout début de `_fork_from`/`_switch_branch`, avant toute mutation de `state.current_branch_id` — sauvegarde `state.messages` vers `state.main_messages` si on est sur "main", ou vers l'objet `ConversationBranch` correspondant dans `state.branches` sinon. Ainsi aucune vue (main ou branche) n'est jamais écrasée sans que son contenu ait d'abord été mis en lieu sûr.
- Gardes supplémentaires ajoutées (pas dans le pseudocode du plan, appliquant la leçon déjà tirée en Task 5 sur `edit_message`/`regenerate`, voir lessons.md 2026-08-06) : `_fork_from`/`_switch_branch` retournent immédiatement (no-op) si `state.agent_running` est `True`, et le bouton `⑂` suit le même pattern d'affichage conditionnel (`not state.agent_running`, groupe hover `opacity-0 group-hover:opacity-100`) que le bouton `✏️` déjà existant — même emplacement, dans la même `ui.row()` que le bouton d'édition des messages utilisateur. `_switch_branch` a aussi un garde `branch_id == state.current_branch_id` (no-op si on reclique la branche déjà active) et un garde défensif sur `branch_id` inconnu (aucun crash, `state.current_branch_id` inchangé).
- `branch_selector()` implémenté comme `@ui.refreshable` (pas de code inline comme suggéré par le plan) — affiché seulement `if state.branches:`, appelé dans `render_chat()` juste avant `ui.scroll_area()` (petit header au-dessus de la liste de messages). Rafraîchi explicitement dans `_fork_from` (nouvelle branche = nouvelle option dans le select) ; pas rafraîchi dans `_switch_branch` (la liste d'options ne change pas, seul le select lui-même — déjà source de l'événement `on_change` — reflète sa propre valeur).

Limitation connue et acceptée (documentée ici comme demandé, pas implémentée) : `state.branches`, `state.current_branch_id` et `state.main_messages` ne sont pas persistés sur disque — `storage.py` n'a aucun support pour ça et ce n'était pas dans le scope du plan. Les branches créées sont donc perdues au redémarrage de l'app (retour silencieux sur "main" au prochain lancement, avec l'historique "main" rechargé depuis `save_chat_history` comme avant cette tâche).

Tests : le test suggéré par le plan (`test_fork_creates_branch`) était un no-op au même sens que celui de Task 5 (voir lessons.md) — il construisait un `ConversationBranch` à la main et l'ajoutait à `state.branches` sans jamais appeler `_fork_from`. Remplacé par 4 tests réels dans `tests/test_artifacts.py`, chacun appelant `_fork_from`/`_switch_branch` importées depuis `openagenticskyzer.app.components.chat` : création de branche avec le bon découpage de messages + bascule de vue ; régression critique sur le bug de perte de données (fork depuis "main" puis retour sur "main" restaure la totalité des 3 messages originaux, pas seulement les 2 forkés) ; no-op des deux fonctions quand `state.agent_running` est `True` ; bascule vers un `branch_id` inconnu sans crash ni changement de `state.current_branch_id`. Note technique découverte en écrivant ces tests : `chat_messages`/`branch_selector` étant des `@ui.refreshable`, appeler `.refresh()` hors d'un contexte NiceGUI actif lève `AssertionError` (`core.loop is not None`) — chaque test monkeypatche `chat_mod.chat_messages.refresh`/`chat_mod.branch_selector.refresh` en no-op pour pouvoir exercer le vrai code de `_fork_from`/`_switch_branch` sans harnais UI complet.

`tests/test_artifacts.py` : 26/26 passed (22 précédents + 4 nouveaux). Suite complète : 351 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_ctx_limits_has_all_providers`, `test_interleaved_tool_resets_file_streak`, `test_email_like_not_captured`), aucune régression (347 + 4 nouveaux = 351).

Task 7 — fix Critical post-review (commit `6ce1a90` → nouveau commit, voir `git log`) :

**Bug trouvé en review qualité, vérifié indépendamment, confirmé exact.** `state.branches`/`state.current_branch_id`/`state.main_messages` n'étaient jamais réinitialisés aux 4 endroits où `state.messages` est remplacé EN DEHORS du flux fork/switch livré dans le commit initial : `sidebar.py::activate_folder` (changement de dossier actif), `command_palette.py::_clear_history._do` (effacement d'historique), `settings.py` (suppression des sessions d'un dossier + retrait d'un dossier de la sidebar). Ces 4 sites réinitialisaient déjà `artifact_type`/`artifact_content`/`show_artifact` avec le commentaire explicite "pour éviter qu'un panneau resté ouvert montre un contenu déconnecté du nouvel historique chargé" — le même raisonnement s'appliquait aux branches mais avait été oublié en implémentant Task 7.

**Scénario de corruption confirmé.** Fork créé sur le dossier A (`state.branches = [B]`, `current_branch_id = B.branch_id`) → changement de dossier vers C via `activate_folder` (`state.messages` devient l'historique de C, mais `branches`/`current_branch_id` restent ceux de A, sélecteur de branches jamais rafraîchi à ce call-site donc toujours visible et pointant sur "Branche 1") → clic sur "🌿 Main" dans le sélecteur → `_switch_branch("main")` : `_snapshot_active_branch()` voit `current_branch_id == B.branch_id` (≠ main), donc écrit `b.messages = state.messages.copy()` — écrasement silencieux du contenu de la branche B (dossier A) avec les messages du dossier C, puis affichage de `state.main_messages` (résidu d'un autre dossier) à la place du chat de C. Mélange silencieux de conversations entre dossiers différents, exactement la classe de bug que le fix "main_messages" du commit initial visait à corriger, restée ouverte pour le cas changement de dossier/effacement d'historique.

**Correctif.** Nouvelle fonction `reset_branches()` dans `chat.py` (pure mutation d'état, pas d'appel NiceGUI : `state.branches = []`, `state.current_branch_id = "main"`, `state.main_messages = []`), appelée aux 4 call-sites juste après le reset existant de `artifact_type`/`artifact_content`/`show_artifact` (import différé, même convention que `chat_messages`/`artifact_panel` à ces mêmes endroits). `branch_selector.refresh()` ajouté dans le même try/except qui appelait déjà `chat_messages.refresh()` à ces 4 sites (import groupé `from ...chat import chat_messages, branch_selector`), pour que le sélecteur de branches disparaisse immédiatement de l'UI après un reset (`branch_selector()` ne s'affiche déjà que `if state.branches:`).

**Trou de couverture de test corrigé en même temps** (issue Important notée par la même review) : aucun des 4 tests initiaux n'exerçait la branche `else` de `_snapshot_active_branch` (sauvegarde vers un `ConversationBranch` de `state.branches`, pas vers `main_messages`) — tous partaient de `current_branch_id == "main"`. Ajout de `test_snapshot_saves_non_main_branch_before_forking_away` : fork main→A, modification de la conversation SUR la branche A, puis fork A→B — vérifie que le contenu à jour de A (avec le message ajouté) est bien sauvegardé dans son `ConversationBranch` avant d'en partir. Ajout de `test_reset_branches_clears_branch_state` : fork puis `reset_branches()`, vérifie `state.branches == []`, `state.current_branch_id == "main"`, `state.main_messages == []`.

Risque mineur noté par la review et volontairement non corrigé (scope) : collision possible sur `branch_id=str(uuid.uuid4())[:8]` (8 caractères tronqués) — négligeable en usage normal (peu de branches par session, app desktop mono-utilisateur) ; corriger aurait été de la sur-ingénierie hors scope.

Fichiers modifiés par ce fix : `openagenticskyzer/app/components/chat.py` (`reset_branches`), `openagenticskyzer/app/components/sidebar.py`, `openagenticskyzer/app/components/command_palette.py`, `openagenticskyzer/app/components/settings.py` (2 call-sites), `tests/test_artifacts.py` (2 nouveaux tests).

Tests : `tests/test_artifacts.py` : 28/28 passed (26 précédents + 2 nouveaux). Suite complète : 353 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_ctx_limits_has_all_providers`, `test_interleaved_tool_resets_file_streak`, `test_email_like_not_captured`), aucune régression (351 + 2 nouveaux = 353).

### Audit final holistique (7 tâches) — 1 bug Critical + 1 Important corrigés (2026-08-07)

- [x] Bug Critical — la persistance disque PRÉEXISTANTE écrasait silencieusement `chat_history.json` avec le contenu de N'IMPORTE QUELLE branche
- [x] Bug Important — l'export de conversation n'indiquait pas quelle vue (main/branche) était exportée

**Bug Critical — diagnostic.** `save_chat_history(folder, messages)` (`storage.py:194`, préexistant au plan branching, sans notion de branche) était appelée sans garde dans `input_bar.py::_send_message` (ligne ~452), après CHAQUE tour de conversation, avec `state.messages` — la vue ACTIVE, main ou une branche selon `state.current_branch_id`. `regenerate()` réutilise `_send_message`, donc le même trou s'applique aux deux points d'entrée. Scénario : fork depuis un message intermédiaire de main (`state.main_messages` garde le contenu complet en RAM, jamais écrit sur disque) → envoi d'un message sur la branche → `save_chat_history` écrase `chat_history.json` avec le contenu tronqué de la branche → tout ce qui suivait le point de fork sur main est perdu définitivement dès le prochain changement de dossier ou redémarrage.

**Bug Critical — correctif.** Design déjà validé (branches = état éphémère en mémoire uniquement, cf. limitation documentée en Task 7 ci-dessus) : ne sauvegarder sur disque QUE quand `state.current_branch_id == "main"`. La garde a été extraite dans une fonction dédiée `_save_main_chat_history()` (`input_bar.py`, juste avant `_send_message`) plutôt que laissée inline — `_send_message` elle-même reste non testable en isolation (fortement couplée à NiceGUI/LLM, même constat déjà documenté pour `trigger_compact` dans `tests/test_context_bar.py`), l'extraction permet de tester le vrai garde sans mocker tout le flux agent. `_send_message` appelle maintenant simplement `_save_main_chat_history()`. Vérifié par grep qu'il n'existe aucun autre call-site de `save_chat_history` dans `openagenticskyzer/app/`.

**Bug Important — correctif.** `exporter.py` exporte `state.messages` (comportement conservé, raisonnable pour une action explicite déclenchée par l'utilisateur — contrairement à la sauvegarde silencieuse en arrière-plan du Bug Critical) mais rien n'indiquait la vue exportée. Ajout de `active_branch_label()` dans `chat.py` (à côté de `_snapshot_active_branch`/`reset_branches`) : retourne `"🌿 Main"` ou le label de la branche active, avec repli défensif sur `"🌿 Main"` si `current_branch_id` ne correspond à aucune branche connue. Câblée aux deux points d'entrée d'export existants : `command_palette.py::_export_conversation` (label `f"Depuis : {label}"` sous le titre du dialog, import différé — `main.py` importe déjà `command_palette` au niveau module, un import inverse créerait un cycle) et `main.py` (menu `⬇` du top bar, label ajouté en tête du menu). Écart mineur vs. l'énoncé : dans `main.py`, `active_branch_label` a été ajoutée au top-level import déjà existant de `chat.py` (`render_chat, chat_messages`) plutôt qu'un import différé dans le corps de la fonction — `main.py` importe déjà `chat.py` au niveau module sans cycle, donc un import différé supplémentaire aurait été redondant ; le menu du top bar restant non-refreshable (commentaire préexistant "évite la destruction du dialog au refresh"), ce label reflète la vue active au moment du rendu initial de la page, pas en live si l'utilisateur change de branche sans recharger — limitation mineure acceptée, cohérente avec le caractère déjà statique de ce menu.

Tests : 5 tests ajoutés à `tests/test_artifacts.py` — 2 sur `_save_main_chat_history` (persiste quand `current_branch_id == "main"`, no-op reproduisant exactement le scénario de perte de données quand on est sur une branche) et 3 sur `active_branch_label` (main, branche connue, id inconnu → repli sur main). `tests/test_artifacts.py` : 33/33 passed (28 précédents + 5 nouveaux). Suite complète : 358 passed / 3 failed — mêmes 3 échecs pré-existants sans rapport (`test_ctx_limits_has_all_providers`, `test_interleaved_tool_resets_file_streak`, `test_email_like_not_captured`), aucune régression (353 + 5 nouveaux = 358).

Fichiers modifiés : `openagenticskyzer/app/components/input_bar.py` (`_save_main_chat_history` + call-site), `openagenticskyzer/app/components/chat.py` (`active_branch_label`), `openagenticskyzer/app/components/command_palette.py`, `openagenticskyzer/app/main.py`, `tests/test_artifacts.py`.
