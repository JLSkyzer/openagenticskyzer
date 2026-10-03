# Cœur agent : écarts réels avec Python corrigés

Date : 2026-10-03. Statut : conception validée section par section ; non implémentée.

## Contexte

Un audit en lecture seule (2026-10-03) a comparé ligne à ligne le cœur LangGraph Python
(`openagenticskyzer/graph/nodes.py` et ce qu'il appelle, version commitée) au moteur
Node (`electron/core/agent.mts`, `provider.mts`, `worker.mjs` et modules voisins). Il a
relevé 23 écarts : 5 graves, 12 moyens, 6 faibles. Les 5 graves ont été revérifiés à la
lecture du code avant cette conception. Ce lot corrige les 5 graves et 8 moyens
retenus par l'utilisateur (« 5 graves + moyens utiles », plus M3).

Décision utilisateur (2026-10-03) sur les permissions : en mode « demander », les
écritures **demandent par défaut**, et « Toujours » ne vaut que pour l'outil, dans le
projet, jusqu'à la fermeture de l'app.

## Contrat de livraison

### Moteur de conversation

**H1 — Limite de sortie séparée du budget de contexte.**
- `max_tokens` envoyé au fournisseur suit le barème Python (`utils/utils.py:663-791`) :
  16 384 pour `together`, `mistral`, `gemini`, `openrouter` ; 8 192 pour `groq`,
  `lmstudio`, `llamacpp` ; **non envoyé** pour `ollama`. Le moteur GGUF intégré reçoit
  8 192 : il lui faut une borne (voir `D:\BDC`, « Un moteur d'inférence local n'a plus
  de serveur distant pour borner la génération »).
- `reserved_tokens` ne sert plus qu'au budget de contexte (son libellé : « Espace
  toujours gardé libre pour la génération »).
- `finish_reason: "length"` n'est plus une erreur :
  - le texte reçu est gardé, suivi de `\n\n[Réponse tronquée : limite de sortie atteinte]` ;
  - chaque appel d'outil de cette réponse est **non exécuté** et reçoit le résultat
    `Erreur : arguments tronqués par la limite de sortie — découpe le travail en appels
    plus petits` ; le tour continue (le modèle peut réessayer) ;
  - toute autre fin anormale (`content_filter`, inconnue) reste une erreur.

**H2 — Nombre d'appels au modèle par tour.** Défaut 100 (au lieu de 24), validation
jusqu'à 150. Message à la limite : « Limite de tours atteinte (N appels au modèle). La
génération a été arrêtée — réponds « continue » pour reprendre. »

**H3 — Ce qui est envoyé au modèle.** La conversation enregistrée et affichée ne change
pas ; seule la requête au fournisseur est construite autrement.
- **Tours précédents** (avant le dernier message utilisateur) : seuls les messages
  `user` et le **texte** des messages `assistant` partent ; les `tool_calls`, les
  messages `tool` et les assistants sans texte sont omis. Les pièces jointes d'un tour
  précédent ne sont pas réexpansées : elles deviennent une ligne
  `[pièce jointe : <nom>]` dans le texte du message.
- **Tour en cours** : tout part (appels, résultats, pièces jointes du dernier message
  utilisateur).
- **Budget** : `fenêtre de contexte − reserved_tokens`, la fenêtre étant `max_tokens`
  des réglages s'il est défini, sinon la table `CONTEXT_WINDOWS` déjà utilisée par la
  jauge (`renderer-src/src/state/context.ts`), et pour le GGUF intégré la taille de
  contexte du moteur. Estimation : 4 caractères par jeton, sur tout ce qui part (texte,
  arguments, résultats). Si la requête dépasse le budget, les résultats d'outils les
  plus anciens **du tour en cours** sont remplacés, un par un, par
  `[sortie de <outil> retirée pour tenir dans le contexte : <n> caractères]`, jusqu'à
  tenir. Si elle dépasse encore (historique trop long), on n'envoie pas : erreur claire
  « Contexte plein : compacte ou efface la conversation ».
- Une seule source pour la table des fenêtres et l'estimation, utilisée par le worker et
  par la jauge (si le renderer ne peut pas importer le module partagé, copie documentée
  plus un test qui vérifie l'égalité des deux tables).

**H4 — Stop au milieu d'un appel d'outil.** À l'enregistrement après un arrêt ou une
erreur, chaque `tool_call` sans résultat reçoit un message `tool`
`Interrompu par l'utilisateur` (ou `Interrompu : <erreur>`), dans l'ordre des appels.
Avec H3, ces appels ne repartent de toute façon plus vers le fournisseur. Corrige aussi
L6 (un ancien appel aux arguments invalides cassait un passage vers le GGUF).

**M8 — Nouvelles tentatives et délai.**
- Sur 408, 409, 429, 5xx ou erreur réseau **avant le premier octet du flux** : jusqu'à
  2 nouvelles tentatives, délai `Retry-After` s'il est donné (plafonné à 30 s), sinon
  1 s puis 3 s. Un arrêt de l'utilisateur interrompt l'attente.
- Le plafond fixe de 300 s par appel devient un délai **d'inactivité** de 120 s (aucun
  octet reçu). Une expiration est une erreur « Le fournisseur ne répond plus (120 s) »,
  et le texte déjà reçu est conservé comme pour un arrêt.

**M9 — Erreurs du fournisseur lisibles.** `Erreur du provider (<code>) : <message>`,
le message étant lu dans le corps (`error.message` JSON, sinon texte brut), réduit à
500 caractères, la clé d'API de la connexion remplacée par `***` si elle y figure. Même
traitement pour un morceau d'erreur dans le flux.

### Permissions (H5)

- Défaut global `files_ask: true`. Une valeur déjà enregistrée (globale ou projet) est
  respectée. `search_ask` reste `false` (Python ne demandait pas pour le web).
- « Toujours » sur un outil `write`, `network` ou `extension` est mémorisé comme celui du
  shell aujourd'hui : en mémoire du worker, clé dossier + outil, jusqu'à la fermeture de
  l'app. Il n'écrit plus rien dans la config du projet. Les « Toujours » déjà écrits par
  les versions précédentes restent (décisions passées, pas de migration silencieuse).
- Bandeau : le bouton devient « Toujours (cette session) ».
- Réglages : l'interrupteur « Écriture / suppression de fichiers » devient
  « Écritures : fichiers, git, mémoire ».
- Inchangés : modes `auto` et `strict`, règle de confiance par projet (un projet qui
  assouplit `files_ask` doit être approuvé).

### Prompt et outils

**M1 — Arguments invalides.**
- Le refus nomme le champ et la règle :
  `Arguments invalides pour <outil> : <champ> <raison>` (ex. « `timeout` doit être un
  entier entre 1 et 600 »). JSON illisible : `Arguments invalides pour <outil> : JSON
  illisible`.
- Conversion souple avant validation : chaîne d'entier → entier, chaîne de nombre →
  nombre, `"true"`/`"false"` → booléen, quand le schéma attend ce type.
- Clé non déclarée : ignorée (retirée avant validation), comme Python. Clé obligatoire
  manquante : refus avec son nom.

**M2 — Fichiers et dossiers.**
- `create_file` crée les dossiers parents manquants, sous les mêmes gardes que
  l'écriture elle-même (dans le projet, pas à travers une jonction, pas dans un chemin
  ignoré ou protégé).
- `create_dir` est récursif.
- Écraser reste refusé ; le message dit : `le fichier existe : utilise edit_file, ou
  delete_file puis create_file`.
- Le message de garde Next.js de `shell-tool.mts` demande une action possible
  (`edit_file` sur la page existante).

**M3 — `read_file` honnête.** Si la sortie ne couvre pas tout le fichier (limite de
lignes ou de caractères), elle commence par `[Lignes X–Y sur N]` et finit par
`[Tronqué : relis avec offset=<Y+1>]`. Les limites actuelles (1000 lignes par défaut,
50 000 caractères) ne changent pas.

**M6 — Modes.**
- La liste d'outils du prompt système est construite depuis les outils **réellement
  envoyés** au modèle.
- Consigne de mode ajoutée au prompt :
  - `ask` : « Mode question : réponds et explique sans rien modifier. »
  - `plan` : « Mode plan : produis un plan détaillé, étape par étape, sans rien
    modifier ; l'utilisateur passera en mode agent pour l'appliquer. »
  - `auto` : aucune consigne supplémentaire.

**M7 — Windows.** Si `process.platform === 'win32'`, le prompt ajoute : « Les commandes
de run_command passent par cmd.exe : n'utilise pas cat, grep, head, tail, ls -la,
touch ; utilise type, findstr, dir, et `curl -o nul`. »

**M12 — Identifiants GGUF.** Les appels d'outils du moteur intégré reçoivent
`local-<uuid>` (au lieu d'un compteur remis à zéro à chaque lancement).

## Tests

Réels, aucun mock, RED d'abord : vrai serveur HTTP de test compatible OpenAI (celui des
tests existants du fournisseur), vrais fichiers, vrai worker, vrai moteur GGUF quand
c'est le sujet.

- H1 : le corps envoyé contient le bon `max_tokens` par fournisseur (absent pour
  ollama) ; une réponse `length` avec texte → tour terminé, texte + mention gardés ; une
  réponse `length` avec appel d'outil → outil non exécuté (fichier absent), résultat
  d'erreur renvoyé au modèle, tour poursuivi.
- H2 : un serveur qui appelle un outil 30 fois puis répond → le tour aboutit ; la
  validation refuse 151.
- H3 : la requête capturée d'un 2ᵉ tour ne contient ni `tool_calls` ni `tool` du 1ᵉʳ, et
  une pièce jointe du 1ᵉʳ tour y figure comme `[pièce jointe : …]` ; dépassement de
  budget → le plus ancien résultat du tour en cours est remplacé ; historique seul
  au-delà du budget → erreur « Contexte plein », aucune requête envoyée.
- H4 : Stop pendant une demande de permission → transcript enregistré avec un `tool`
  « Interrompu par l'utilisateur » apparié ; le tour suivant part et aboutit.
- M8 : 503 puis 200 → succès, 2 requêtes reçues ; 429 avec `Retry-After: 1` → attente
  respectée ; 503 trois fois → erreur ; serveur muet au-delà du délai → expiration (délai
  injectable pour le test) avec texte partiel conservé.
- M9 : 400 `{"error":{"message":"context length exceeded"}}` → message affiché ; la clé
  présente dans le corps est masquée.
- H5 : réglages par défaut, mode « demander » : `create_file` déclenche une demande et
  rien n'est écrit avant la décision ; « Toujours » sur `create_file` n'autorise pas
  `git_commit` ; après redémarrage du worker, `create_file` redemande ; la config du
  projet est inchangée ; un `files_ask: false` enregistré est respecté. Preuve Electron
  réelle du bandeau « Toujours (cette session) » et du nouveau libellé.
- M1 : `{"timeout":"120"}` exécuté ; clé en trop ignorée ; type faux → message nommant
  le champ, visible dans la requête suivante au modèle.
- M2 : `create_file a/b/c.txt` dans un projet vide ; refus à travers une jonction et
  dans un chemin ignoré ; `create_dir` récursif ; message d'écrasement.
- M3 : fichier de 2500 lignes → en-tête et marque ; fichier court → sortie inchangée.
- M6/M7 : prompt capturé en ask, plan, auto : outils listés = outils envoyés, consigne
  présente ; ligne Windows présente sous win32.
- M12 : deux moteurs GGUF successifs (deux workers) → identifiants distincts.
- Suite complète, `tsc` (core : 5 erreurs préexistantes seulement ; renderer : 0),
  `package:win` + `test:package`.

## Hors scope (explicitement)

- M4 (appels d'outils écrits en texte par un modèle HTTP local), M5 (recherche web forcée
  pour les modèles locaux), M10 (fusion du prompt système pour LM Studio), M11
  (démarrage automatique d'Ollama / LM Studio / llama.cpp — rejoint le refus des
  serveurs externes), L1–L5. Ils restent listés dans le bilan.
- Détecteur de boucle, modes ask/plan en lecture seule, `analyze_project_and_init`
  comme outil agent : décisions déjà documentées.
- Pas de réglage utilisateur pour la limite de sortie ou le nombre d'appels.
