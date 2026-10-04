# Clôture de la migration : données Python sûres, trois écarts de parité comblés

Date : 2026-10-04. Statut : conception validée section par section ; non implémentée.

## Contexte

Deux vérifications en lecture seule (2026-10-04) :

- **Reprise des données Python**, sur une copie du dossier de données réel (supprimée
  ensuite, aucun contenu affiché) : réglages globaux et de projet, connexion (`.env` du
  projet), conversations (`<projet>/.openagent/chat_history.json`) se chargent correctement ;
  chaque première écriture garde une copie `.pre-electron.bak`. Quatre risques relevés :
  - **R1 (grave)** : `folders.json` contient chaque projet deux fois — l'entrée écrite par
    Python (`C:/…`, barres obliques) et l'entrée Electron (`C:\…`, chemin réel). `recordOpened`
    ne déduplique que sur la chaîne exacte : l'entrée Python garde sa date d'origine pour
    toujours. `cleanupOldFolders` (au démarrage) supprime alors `conversations.json` et
    `chat_history.json` du projet dès que cette vieille entrée dépasse la rétention, même si
    le projet a été ouvert la veille. Reproduit sur la copie. Sur les données réelles de
    l'utilisateur, l'échéance tombait au 2026-10-14 ; ses deux historiques ont été copiés le
    2026-10-04 dans `~/.openagent/backup-2026-10-04/` (copies vérifiées identiques).
  - **R2 (grave)** : la rétention supprime définitivement (`rm`), y compris l'ancien
    `chat_history.json` — la rétention Python ne supprimait jamais ce fichier.
  - **R3 (moyen, lu dans le code)** : les messages Python de rôle `ai` / `human` ne sont pas
    normalisés au chargement d'un projet ; l'écran n'affiche que `assistant` : les réponses
    de l'IA d'une ancienne conversation sont invisibles jusqu'au prochain envoi.
  - **R4 (latent)** : `migrateDataDir` ne déplace que les fichiers de premier niveau
    (`knowledge/`, `tools/`, cache d'embeddings restent derrière) et le processus principal
    ignore la redirection : le coffre des connexions resterait dans l'ancien dossier.
- **Matrice de parité** (`docs/superpowers/plans/2026-09-14-electron-parity.md`, 38 lignes),
  vérifiée ligne par ligne (implémentation et test réel) : 23 prouvées, 5 décisions
  délibérées (catalogue de modèles → `.gguf` intégré, 2026-09-27), 10 partielles dont trois
  **vrais écarts** :
  - **ligne 1** : fermer la fenêtre quitte l'app (`main.cjs`), alors que l'app Python restait
    dans la zone de notification ; un commentaire du code affirme le contraire ;
  - **ligne 32** : les anciens plugins `.py` sont ignorés en silence, au lieu d'être signalés
    comme à porter ;
  - **ligne 33** : ouvrir l'onglet Outils (`plugin-list`) démarre tous les serveurs MCP
    configurés, ce que la matrice interdit ; un test asserte même ce démarrage.

Décision utilisateur (2026-10-04) : ce lot couvre R1–R4 et les trois vrais écarts, puis la
clôture du suivi ; les tests manquants des autres lignes partielles restent listés.

## Contrat de livraison

### R1 — Historique des dossiers sans doublons

- À la lecture de `folders.json`, chaque entrée est ramenée à une clé canonique : le chemin
  réel (`realpath`) s'il existe, sinon le chemin normalisé (séparateurs `\`, casse
  ignorée sous Windows). Les entrées de même clé sont fusionnées en gardant le chemin réel
  et la date `last_used` **la plus récente**.
- Si la fusion change quelque chose, le fichier est réécrit une fois, normalisé (la copie
  `.pre-electron.bak` existante de JsonStore s'applique ; elle n'est jamais écrasée).
- `recordOpened` déduplique avec la même clé canonique.
- `cleanupOldFolders` ne voit plus que des entrées fusionnées.

### R2 — La rétention archive au lieu d'effacer

- Un projet au-delà de la rétention voit ses fichiers d'historique (`conversations.json`,
  `chat_history.json`) **déplacés** dans
  `<dossier de données>/retention-archive/<AAAA-MM-JJ>/<nom du projet>-<8 premiers
  caractères du SHA-256 du chemin canonique>/`. Jamais `rm`.
- Un déplacement qui échoue laisse le fichier en place (rien n'est perdu) et est journalisé.
- Rien n'efface `retention-archive/` automatiquement.
- Réglages › Contexte : une phrase sous le choix de rétention dit que l'historique est
  archivé dans le dossier de données, pas supprimé.

### R3 — Rôles Python normalisés au chargement

- `ai` → `assistant`, `human` → `user`, à la lecture d'une conversation (là où le worker
  sert l'historique à l'écran : activation d'un dossier, chargement d'une branche), pour
  que l'écran et la requête au modèle voient les mêmes rôles. Le fichier n'est pas réécrit
  à la lecture.

### R4 — Migration complète du dossier de données

- `migrateDataDir` déplace tout le contenu, sous-dossiers compris (copie vérifiée puis
  suppression de la source, comme aujourd'hui pour les fichiers).
- Le processus principal résout le dossier de données comme le worker (même redirection),
  pour que le coffre des connexions suive.

### Écart 1 — Fermer envoie dans la zone de notification

- La croix masque la fenêtre ; l'app, le worker et l'icône restent actifs.
- « Ouvrir » (menu de l'icône) ou un clic sur l'icône réaffiche la fenêtre ; relancer l'app
  quand elle tourne réaffiche la fenêtre (instance unique existante).
- Quittent réellement : « Quitter » du menu de l'icône, « Redémarrer maintenant » (mise à
  jour), l'arrêt de la session Windows. Le chemin d'arrêt propre existant (worker arrêté,
  puis quitter) est inchangé.
- Le commentaire faux de `main.cjs` est corrigé.

### Écart 2 — Plugins `.py` signalés

- Un fichier `.py` dans un dossier de plugins (`<données>/tools`, `<projet>/tools`,
  `<projet>/.openagent/tools`) n'est jamais exécuté et apparaît dans les erreurs de
  l'onglet Outils : `Plugin Python non pris en charge : <nom>.py — à réécrire en .mjs`.
- Les règles de confiance des dossiers de projet s'appliquent comme pour les `.mjs`.

### Écart 3 — L'onglet Outils ne démarre pas les serveurs MCP

- `plugin-list` liste les serveurs MCP configurés **sans les démarrer** : un serveur déjà
  démarré par un tour affiche ses outils (mémorisés depuis ce tour) ; les autres affichent
  `non démarré — ses outils seront chargés au prochain message`.
- La découverte reste faite au moment où un tour a besoin des outils.
- Les serveurs MCP démarrés s'arrêtent quand l'app quitte (testé ; corrigé si le test
  échoue).

### Clôture du suivi

- `tasks/todo.md`, section « Migration 2026-09-14-electron-autonomous » : chaque case cochée
  avec sa preuve ou réécrite selon les décisions de l'utilisateur ; la case modèles devient
  « Modèles locaux `.gguf` intégrés, index/BDC, extensions et MCP sans Python (catalogue
  Hugging Face, Ollama, LM Studio abandonnés le 2026-09-27) ».
- Le rapport de la matrice ligne par ligne est versé dans
  `docs/superpowers/specs/2026-10-04-parity-matrix-audit.md` (références de code seulement).
  Le rapport sur les données n'est **pas** versé : il cite des chemins personnels et le dépôt
  est public ; la spec en garde le résumé.
- L'en-tête « CONCEPTION, NON LIVRÉE » devient « LIVRÉE » seulement si toutes les cases sont
  prouvées à la fin du lot ; sinon il dit exactement ce qui reste.

## Tests

Réels, sans mocks, RED d'abord ; tout test qui ouvre une fenêtre est lancé **une seule
fois** (préférence de l'utilisateur).

- R1 : `folders.json` avec `C:/a/b` (ancien) et `C:\a\b` (récent) → une seule entrée, date
  récente ; `recordOpened('C:/a/b')` ne crée pas de doublon ; nettoyage à rétention 30 → rien
  touché ; une entrée réellement expirée → nettoyée.
- R2 : projet expiré → fichiers dans `retention-archive/…`, contenu identique à l'octet,
  plus rien à l'emplacement d'origine, aucun fichier supprimé ; échec de déplacement simulé
  par un vrai verrou ou un chemin d'archive impossible → fichier resté en place.
- R3 : conversation au format Python (`ai`) → les messages servis par le worker ont le rôle
  `assistant` ; preuve dans une vraie fenêtre (la réponse est affichée).
- R4 : dossier de données avec `knowledge/`, `tools/` et sous-dossiers → tout migré ;
  le coffre (processus principal) lu depuis le nouveau dossier.
- Écart 1 : vraie fenêtre : fermer → processus et worker vivants, fenêtre masquée ;
  « Ouvrir » → visible ; « Quitter » → processus terminé proprement. Les tests existants qui
  fermaient la fenêtre en attendant la fin du processus sont adaptés.
- Écart 2 : un vrai `.py` dans `<données>/tools` → erreur listée, jamais chargé.
- Écart 3 : un vrai serveur MCP de test qui écrit un fichier témoin à son démarrage :
  `plugin-list` → aucun témoin ; après un tour → témoin et outils listés ; le test existant
  qui assertait le démarrage est inversé ; quitter → processus MCP terminé.
- Suite complète, `tsc` (cœur : 5 erreurs préexistantes ; renderer : 0), `package:win` +
  `test:package`.

## Hors scope (explicitement)

Les tests manquants des 7 autres lignes partielles de la matrice (Shift+Entrée, couleur
d'accent, `search_ask`, modification d'un fichier indexé, etc.) — listés dans le bilan ;
vidage automatique de `retention-archive/` ; notification « l'app tourne toujours » à la
première fermeture.
