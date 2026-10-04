# Bascule finale : l'app Electron seule, l'app Python retirée

Date : 2026-10-04. Statut : conception validée section par section ; non implémentée.

## Contexte

La migration NiceGUI → Electron (`docs/superpowers/specs/2026-09-14-electron-autonomous-design.md`)
est livrée lot par lot ; deux audits indépendants (2026-09-27, 2026-10-01) et l'audit du
cœur agent (2026-10-03) ont comblé les écarts. Les deux lanceurs de la racine
(`app_launcher.bat`, `app_launcher.ps1`) lancent déjà l'app Electron. Restent dans le dépôt :
l'app Python (`openagenticskyzer/`, 65 fichiers suivis), sa suite de tests (`tests/`, 28),
`pyproject.toml`, `requirements.txt`, `scratchpad_base_context_bar.py`, et `install.bat`
(installeur Python, déjà supprimé dans le répertoire de travail de l'utilisateur, non commité).

Décisions de l'utilisateur (2026-10-04) :
- le code Python est **retiré de master, avec une étiquette git** `python-final` ;
- ses modifications Python non commitées (tentative abandonnée « fenêtre native » :
  `agent.py --app` vers `desktop/electron_launcher`, NiceGUI `native=True`, deux gardes
  ChromaDB, dossier non suivi `openagenticskyzer/desktop/`) sont **sauvées sur une branche** ;
- le **mode ligne de commande** (`openagent "tâche"`), qui n'existe qu'en Python, est
  **abandonné** : récupérable via `python-final`, aucun CLI Node dans ce lot ;
- approche **A** : `electron/` reste le dossier de l'app ; la racine devient une enveloppe.

## Contrat de livraison

### 1. Mise à l'abri (avant tout retrait)

1. Branche `archive/native-desktop-attempt`, créée depuis le commit courant de master,
   contenant UN commit avec exactement : `openagenticskyzer/agent.py`,
   `openagenticskyzer/app/main.py`, `openagenticskyzer/app/components/sidebar.py`,
   `openagenticskyzer/indexer/knowledge.py` (leurs modifications non commitées) et le
   dossier `openagenticskyzer/desktop/` (non suivi). Poussée sur `origin`. master n'est pas
   modifié par cette étape. Les autres changements non commités de l'utilisateur (plans
   renommés « OK … », `docs/superpowers/plans/liste logique à suivre.txt`, retouche de
   `docs/superpowers/specs/2026-09-14-electron-autonomous-design.md`, plans non suivis)
   restent dans le répertoire de travail, non commités, intacts.
2. Après le commit d'archive, le répertoire de travail revient sur master ; les fichiers
   Python archivés y retrouvent leur version de master (ils seront retirés à l'étape 2).
   Vérification : `git diff archive/native-desktop-attempt~1 archive/native-desktop-attempt
   --stat` liste exactement ces fichiers, et le contenu archivé est identique (octet pour
   octet) à celui du répertoire de travail avant l'opération.
3. Étiquette annotée `python-final` sur le commit de master qui contient encore l'app
   Python complète (le commit courant, avant le retrait), poussée sur `origin`.

### 2. Retrait (un commit sur master)

`git rm -r` de : `openagenticskyzer/`, `tests/` (suite Python), `pyproject.toml`,
`requirements.txt`, `scratchpad_base_context_bar.py`, `install.bat`. Rien d'autre.

Non touchés : `electron/`, `docs/` (historique), `tasks/`, `.claude`, `.gitignore`
(ses entrées Python évitent qu'un `.venv` local soit commité), `superpowers.lnk`,
`ollama meilleur modèle.txt`, les lanceurs, et tout fichier non suivi
(`.venv`, `openagentic_ai/`, `openagenticskyzer.egg-info`, `.pytest_cache`) — listés dans
le bilan comme supprimables par l'utilisateur. Les données `~/.openagent` ne sont jamais
touchées.

### 3. Documentation

- `README.md` réécrit en français : ce qu'est l'app (application de bureau Windows, agent
  de code dans le dossier ouvert, clés de l'utilisateur ou modèle `.gguf` local) ;
  installation (installeur `openagent-Setup-<version>.exe` de GitHub Releases, par
  utilisateur sans admin, mises à jour automatiques, avertissement SmartScreen expliqué :
  installeur non signé) ; développement (`cd electron`, `npm ci`, `npm run
  renderer:build`, `npm start` ou `app_launcher.bat`, tests `node
  --experimental-strip-types --test tests/all.mts`) ; publication (procédure du bilan du
  lot installeur) ; fonctions à jour ; une ligne : l'ancienne app Python et son CLI sont
  conservés sous l'étiquette `python-final`.
- `CONTRIBUTING.md` réécrit pour Node : prérequis (Node 24, git ≥ 2.44), installation,
  tests, règles (TDD, tests réels sans mocks, un commit par modification vérifiée) ; le
  dépôt cité est `JLSkyzer/openagenticskyzer` (et non `HcodeQ/openagentic-ai`).
- Aucune affirmation non vérifiée : chaque commande documentée est réellement lancée une
  fois ; les fonctions listées existent dans le code.

### 4. Suivi

- `tasks/todo.md`, section « Migration 2026-09-14-electron-autonomous » (lignes 9–15) :
  une case n'est cochée que si une preuve existe ; chaque case reçoit une ligne qui
  renvoie au lot (bilan) qui l'a prouvée. Une case sans preuve reste ouverte avec ce
  qui manque.
- Bilan du lot à la fin de `tasks/todo.md`.

## Vérification

- `git grep` dans `electron/` : aucune dépendance au code Python retiré (mentions
  attendues seulement : détection des projets Python par l'analyseur, tests qui prouvent
  l'absence de Python).
- Suite complète `tests/all.mts` verte ; `tsc` (cœur : 5 erreurs préexistantes ;
  renderer : 0) ; `package:win` + `test:package` (l'app empaquetée ne requiert aucun
  Python). Tout test qui ouvre une fenêtre est lancé **une seule fois** (préférence de
  l'utilisateur).
- Après push : `git ls-remote --tags origin python-final` et
  `git ls-remote --heads origin archive/native-desktop-attempt` répondent.

## Hors scope (explicitement)

Remonter l'app à la racine du dépôt ; nettoyage des docs historiques ; CLI Node ;
suppression des fichiers locaux non suivis (laissée à l'utilisateur).
