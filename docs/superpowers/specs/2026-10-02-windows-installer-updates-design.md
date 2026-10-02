# Installeur Windows et mises à jour automatiques

Date : 2026-10-02. Statut : conception validée section par section ; non implémentée.

## Contexte

Le packaging actuel (`electron/package.json`) produit seulement un dossier décompressé
(`electron-builder --win dir` → `release/win-unpacked/`), sans installeur, sans
signature ni mise à jour. Version actuelle : `0.2.0`. Le dépôt GitHub
`JLSkyzer/openagenticskyzer` est **public** (vérifié via `gh repo view`, 2026-10-02) :
l'app peut lire ses mises à jour sur GitHub Releases sans jeton embarqué.

Décisions utilisateur (2026-10-02) : mises à jour **téléchargées en arrière-plan puis
proposées** (rien ne redémarre sans clic) ; installation **par utilisateur sans droits
administrateur** ; **pas de certificat** de signature pour l'instant ; publication par
**build local → brouillon de release GitHub** ; approche **A** (`electron-updater` +
cible NSIS) ; un **test d'installation réelle exécuté une fois** en preuve finale.

## Contrat de livraison

### Installeur

- Cible electron-builder `nsis` (au lieu de `dir`) — produit aussi `release/win-unpacked/`,
  si bien que `npm run test:package` (test de fumée de l'exe décompressé) reste valable.
- `nsis` : `oneClick: true`, `perMachine: false` (installation dans
  `%LOCALAPPDATA%\Programs\openagent`, sans UAC), raccourcis menu Démarrer et bureau,
  `deleteAppDataOnUninstall: false`. Les données utilisateur (`~/.openagent` et le
  dossier de données Electron) ne sont jamais supprimées par la désinstallation.
- Fichiers produits : `openagent-Setup-<version>.exe`, son `.blockmap`, `latest.yml`.
- `electron-updater` en **dépendance d'exécution** ; lui et **chacune de ses
  dépendances d'exécution** ajoutés explicitement à `build.files` (electron-builder
  exclut tout fichier absent de `build.files` — voir `D:\BDC`, note « electron-builder
  exclut par défaut tout fichier absent de build.files »). La liste exacte est relevée
  avec `npm ls --omit=dev` et **prouvée** en chargeant le module depuis l'app packagée.
- Nouveau fichier du process principal `updater.cjs` également ajouté à `build.files`.

### Publication

- `build.publish` : fournisseur `github`, `owner: JLSkyzer`, `repo: openagenticskyzer`,
  `releaseType: draft`.
- `npm run package:win` construit l'installeur **sans publier**.
- `npm run release:win` (`scripts/release-win.cjs`) :
  1. refuse si l'arbre git a des changements non commités (dans `electron/` et la
     racine) ;
  2. refuse si une release ou un tag `v<version>` existe déjà sur GitHub ;
  3. lit le jeton par `gh auth token` et le passe **uniquement** à l'environnement du
     processus electron-builder (`GH_TOKEN`) — jamais écrit sur disque, jamais affiché
     ni journalisé ;
  4. construit et dépose installeur + `.blockmap` + `latest.yml` dans un **brouillon**.
- Les apps installées ne voient une version qu'une fois le brouillon **publié** — geste
  de l'utilisateur (l'agent ne publie qu'avec un accord explicite à chaque fois).
- `package.json` `version` fait foi ; une release = un numéro supérieur. Rétrogradation
  et préversions désactivées (`allowDowngrade: false`, `allowPrerelease: false`).

### Mise à jour dans l'app

- `updater.cjs` (process principal) n'est actif **que dans l'app packagée**
  (`app.isPackaged`), jamais en développement ni dans les tests, sauf la variable de test
  ci-dessous.
- `autoDownload: true`, `autoInstallOnAppQuit: true`. Vérification 10 s après l'ouverture
  de la fenêtre, puis toutes les 6 h. Téléchargement différentiel (`.blockmap`) quand
  possible.
- Statuts transmis au renderer par un canal dédié du preload (`onUpdateStatus`,
  désinscription renvoyée comme les autres abonnements) : `checking`, `available
  {version}`, `downloading {percent}`, `ready {version}`, `up-to-date`,
  `error {message}`. Le dernier statut et sa date sont conservés en mémoire pour
  l'affichage dans les réglages.
- Opérations gérées par le process principal (comme `connection-snapshot`) :
  `update-check` (vérification manuelle) et `update-install-now` (arrêt propre du worker
  par le même chemin que la fermeture actuelle, puis `quitAndInstall(true, true)` :
  installation silencieuse et relance).
- **Variable de test** `OPENAGENT_UPDATE_FEED` : redirige le flux vers un fournisseur
  `generic` **seulement si l'URL est `http://127.0.0.1:<port>/…` ou
  `http://localhost:<port>/…`** ; toute autre valeur est ignorée. Elle permet aussi
  d'activer l'updater dans `win-unpacked` lancé par les tests.

### Interface

- Bandeau discret « Version X prête — [Redémarrer maintenant] [Plus tard] ». « Plus
  tard » le masque pour la session (installation à la fermeture). « Redémarrer
  maintenant » est **désactivé pendant un tour d'agent** (mention « après le tour en
  cours »).
- Réglages › Général : version installée, bouton « Vérifier les mises à jour », dernier
  résultat avec sa date (« À jour », « Échec : … », « X prête »). En développement (non
  packagé) : « Mises à jour désactivées (version de développement) ».

## Erreurs

- Réseau absent, GitHub indisponible, `latest.yml` illisible, empreinte invalide : jamais
  bloquant, jamais de fenêtre d'erreur ; statut `error` journalisé et visible dans les
  réglages. Une empreinte SHA-512 qui ne correspond pas fait rejeter le fichier
  téléchargé (comportement d'`electron-updater`), jamais installer.
- `update-install-now` sans mise à jour prête : refusé avec un message clair.

## Sécurité

- Canal HTTPS vers GitHub ; intégrité de chaque installeur vérifiée par SHA-512
  (`latest.yml`). **Sans certificat, l'éditeur n'est pas vérifié** : la sécurité des
  mises à jour repose sur celle du compte GitHub `JLSkyzer` (quiconque peut publier une
  release sur ce dépôt peut livrer une mise à jour). Écrit tel quel dans le bilan.
- Premier lancement de l'installeur : Windows SmartScreen affichera un avertissement
  (installeur non signé). La signature pourra être ajoutée plus tard via les variables
  d'environnement d'electron-builder (`CSC_LINK`/`CSC_KEY_PASSWORD`) sans changer le
  code — non activée dans ce lot.
- Le jeton GitHub n'existe que dans l'environnement du processus de release.

## Tests

Réels, aucun mock, RED d'abord.

- Script de release : refus sur arbre sale, refus si `v<version>` existe (contre le vrai
  GitHub en lecture, ou un dépôt local de test pour l'arbre sale), jeton absent de toute
  sortie.
- Logique de l'updater (filtre de la variable de test, statuts, refus de
  `update-install-now` sans mise à jour prête), dans un vrai process Electron.
- **App packagée** : `electron-updater` se charge depuis `win-unpacked` (piège
  `build.files`).
- **Bout en bout sans installation** : versions N et N+1 construites ; N+1 servie par un
  serveur HTTP local ; `win-unpacked` de N lancé avec `OPENAGENT_UPDATE_FEED` → la vraie
  fenêtre affiche « N+1 prête », le fichier téléchargé correspond à l'empreinte de
  `latest.yml`. Arrêt avant installation.
- **Installation réelle, exécutée une seule fois** (preuve finale, sur accord donné le
  2026-10-02) : installe N en silencieux (`/S`), lance l'app, mise à jour vers N+1 par
  « Redémarrer maintenant » via le flux local, vérifie la version installée, puis
  désinstalle en silencieux et vérifie le nettoyage (dossier d'installation, entrée
  HKCU, raccourcis). Script conservé dans le dépôt, **jamais lancé par la suite normale**
  (script npm dédié, appelé seulement sur demande explicite).

## Hors scope (explicitement, pas un oubli)

- Signature du code (prévue, non activée).
- macOS et Linux.
- Intégration continue (GitHub Actions).
- Canal bêta / préversions.
- Publication automatique : le brouillon n'est jamais publié par le script.
