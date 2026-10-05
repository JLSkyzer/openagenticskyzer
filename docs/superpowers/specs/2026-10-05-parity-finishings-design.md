# Finitions de parité : les 7 dernières lignes de la matrice, et l'index sans secrets

Date : 2026-10-05. Statut : conception validée section par section ; non implémentée.

## Contexte

L'audit ligne à ligne (`docs/superpowers/specs/2026-10-04-parity-matrix-audit.md`) laisse 7
lignes partielles : 2, 6, 7, 14, 16, 18, 30. La migration est marquée « LIVRÉE SAUF » ces
lignes (`tasks/todo.md`). Ce lot les ferme. Il inclut, sur décision de l'utilisateur
(2026-10-04), un défaut de sécurité relevé ligne 30 : l'index sémantique n'applique ni les
motifs ignorés du projet ni le filtre des fichiers secrets des outils fichiers ; un
`secrets.json` est indexé et son contenu devient lisible par le modèle via `semantic_search`.

## Contrat de livraison

### Ligne 2 — Ouvrir un dossier en tapant son chemin

- Barre latérale : sous « 📂 Ouvrir un dossier », un champ « Chemin du dossier » et un bouton
  « Ouvrir » (Entrée valide aussi).
- Un chemin vide, relatif, inexistant ou qui n'est pas un dossier est refusé par un message
  clair (toast), rien n'est activé. Un chemin valide passe par le même `activate_folder` que le
  dialogue natif (historique, restauration, confiance).
- Les tests assertent aussi le nom, le chemin et la date affichés dans l'historique.

### Ligne 6 — Cartes d'outil complètes, y compris après rechargement

- **Détail** dans l'en-tête de la carte, tiré des arguments de l'appel : `path` pour les
  outils fichiers, `command` pour `run_command`, `query` / `url` pour la recherche et le web ;
  rien pour les autres. Tronqué à 120 caractères.
- **Diff d'édition** : `edit_file` renvoie, après son message de succès, un diff unifié de la
  modification, borné à 60 lignes et 4 000 caractères (au-delà : `[diff tronqué]`). Le rendu
  coloré existant (`looksLikeDiff`) l'affiche ; le modèle le reçoit aussi.
- **Rechargement** : chaque résultat d'outil enregistré garde `name` et `category` (posés par
  la boucle de l'agent, qui connaît l'outil). Pour une conversation enregistrée avant ce lot,
  le nom est retrouvé dans le `tool_calls` de l'assistant qui précède ; la catégorie inconnue
  donne un badge neutre. Le nom, le badge et le détail ne disparaissent plus à la réouverture.
- Ces champs ajoutés ne partent jamais vers le fournisseur (la requête n'envoie que les champs
  du format OpenAI).

### Ligne 30 et sécurité — L'index ne voit plus les fichiers secrets ni ignorés

- L'indexation applique le **même filtre que les outils fichiers** : fichiers secrets (la
  liste utilisée par `read_file` / `grep_codebase`) et `ignored_patterns` du projet.
- Les morceaux déjà indexés de ces fichiers sont purgés à la prochaine indexation.
- `semantic_search` filtre aussi à la lecture : un résultat dont le fichier est secret ou
  ignoré n'est jamais rendu, même avant la réindexation.

### Lignes 7, 14, 16, 18, 30 — preuves manquantes (tests seulement, sauf défaut trouvé)

- **7** (`chat-visual.cjs`) : Shift+Entrée ajoute une ligne et n'envoie rien (aucune requête au
  faux serveur) ; deux Entrée rapides, ou Envoyer pendant un tour, ne produisent qu'une requête.
- **14** (`export-visual.cjs`) : dossier rendu inaccessible, export lancé depuis le menu ⬇ →
  toast « Échec de l'export », aucun fichier écrit.
- **16** (`theme-visual.cjs`) : accent `#ff0000` choisi dans les réglages → appliqué à
  `--accent`, enregistré, présent après rechargement.
- **18** (worker) : `search_ask: true` → un outil réseau (`fetch_url`) demande la permission et
  n'est pas appelé avant la décision ; `false` (défaut) → passe sans demande.
- **30** (index) : indexer, modifier un fichier, réindexer → la recherche trouve le nouveau
  contenu, plus l'ancien.

Si un test révèle un vrai défaut, il est corrigé dans ce lot.

## Tests

Réels, sans mocks, RED d'abord pour toute fonction nouvelle. Tout test qui ouvre une fenêtre
est lancé **une seule fois** (préférence de l'utilisateur) ; un échec est rapporté, pas relancé
en boucle. Les données réelles de l'utilisateur ne sont jamais touchées (dossiers temporaires,
`OPENAGENT_HOME` isolé).

- Ligne 2 : chemin valide → dossier actif, en tête d'historique ; chemins invalides → refus,
  rien d'activé.
- Ligne 6 : détail affiché pour `create_file`, `run_command`, une recherche ; `edit_file` →
  diff dans le résultat et coloré à l'écran ; rechargement → nom, badge, détail présents ;
  ancienne conversation sans `name` → nom retrouvé, badge neutre ; la requête suivante ne
  contient ni `name` ni `category` dans les messages `tool`.
- Sécurité : un `secrets.json` et un fichier ignoré du projet ne sont jamais indexés ni
  rendus par `semantic_search` ; un index existant qui les contient est purgé et filtré.
- Lignes 7, 14, 16, 18, 30 comme ci-dessus.
- Suite complète, `tsc` (cœur : 5 erreurs préexistantes ; renderer : 0), `package:win` +
  `test:package` ; tests visuels touchés (`sidebar`, `chat`, `export`, `theme`,
  `index-status`) une fois chacun.

## Clôture

- Matrice de parité : chaque ligne fermée reçoit sa preuve (test nommé) dans
  `tasks/todo.md` ; l'en-tête devient « LIVRÉE » si toutes les lignes sont prouvées, sinon il
  dit exactement ce qui reste.
- Bilan, leçons, notes BDC proposées à l'utilisateur, push.

## Hors scope (explicitement)

Résidus de la revue précédente (deux migrations d'affilée, redémarrage pendant une mise à jour
prête ou une migration, export qui démarre les serveurs MCP, « Toujours » lié à la source de
l'outil) ; modèles locaux HTTP (audit M4/M10).
