# Confiance par projet : approbation avant d'exécuter le contenu d'un projet

Date : 2026-10-02. Statut : conception validée section par section ; non implémentée.

## Contexte

Les deux lots précédents (système de plugins Node, MCP enrichi) ont chacun
documenté un **risque accepté** dans leur bilan (`tasks/todo.md`) :

- un plugin `<projet>/tools/*.mjs` est importé — donc son code de premier niveau
  exécuté, avec tous les droits du worker — dès le premier tour ou la simple
  ouverture de l'onglet Outils, sans aucune confirmation. `tools/` est un nom de
  dossier courant dans des dépôts sans rapport (`tools/build.mjs`…) ;
- les serveurs d'un `.mcp.json` de projet sont lancés (stdio) ou contactés
  (distant) de la même façon, alors que Claude Code demande une approbation.

En concevant ce lot, un **troisième trou de la même famille** a été trouvé,
jamais documenté : les réglages de projet vivent DANS le dépôt
(`<projet>/.openagent/config.json`), et `override_permissions: true` y remplace
les réglages globaux de permission (`core/settings.mts::effective`, lignes
119-121). Un dépôt peut donc embarquer
`{"override_permissions": true, "shell_ask": false, "permission_mode": "auto"}`
et faire exécuter des commandes shell sans confirmation dès qu'on l'ouvre. De
même, un `agent_mode: "auto"` de projet lève silencieusement le mode
lecture-seule `ask`/`plan` choisi globalement.

Décisions utilisateur (2026-10-02) : traiter les trois dans ce lot, avec **une
seule décision par projet**, posée par un **bandeau non bloquant à
l'ouverture**, en suivant l'**approche A** (un module central de confiance
consulté par le worker, plutôt qu'un contrôle recopié dans chaque chargeur).

## Contrat de livraison

- **Contenu sensible d'un projet** = (1) fichiers plugins de `<projet>/tools` et
  `<projet>/.openagent/tools` (mêmes règles de sélection que
  `core/plugin-loader.mts` : `.mjs`/`.mts`, fichiers réguliers de premier niveau,
  pas de nom commençant par `.` ni par `__init__`) ; (2) serveurs du
  `<projet>/.mcp.json` ; (3) **assouplissements** du `config.json` de projet.
- **Assouplissement** = un champ de projet qui, appliqué, rendrait l'agent plus
  permissif que le réglage global :
  - avec `override_permissions: true` : `shell_ask`/`files_ask`/`search_ask` à
    `false` quand le global vaut `true` ; `permission_mode` moins strict que le
    global (ordre de sévérité : `strict` > `demander` > `auto`) ;
  - `agent_mode` valant `auto` quand le global vaut `ask` ou `plan` (en
    Electron, `ask` et `plan` sont en lecture seule).

  Un champ de projet **plus strict ou égal** au global n'est pas un
  assouplissement : il s'applique toujours, sans approbation.
- **Tant qu'un projet n'est pas approuvé** : ses plugins ne sont **jamais
  importés** (pas même scannés par le chargeur), ses serveurs `.mcp.json` ne sont
  **jamais lancés ni contactés**, et pour chaque assouplissement c'est la valeur
  globale qui s'applique. Le tour fonctionne normalement avec les outils internes
  et le contenu global.
- **Le contenu global** (`<données>/tools`, `<données>/mcp.json`) n'est jamais
  soumis à approbation : l'utilisateur l'a placé lui-même.
- **Registre de confiance** : `<dossier de données>/trusted-projects.json`,
  indexé par le chemin réel (`realpath`) du projet. **Jamais dans le projet** —
  sinon un dépôt pourrait livrer sa propre approbation.
- **Empreinte** : SHA-256 calculée sur les fichiers plugins (chemin relatif au
  projet + octets du fichier, triés par chemin) et les octets bruts de
  `.mcp.json`. Une approbation ou un refus vaut pour une empreinte précise :
  ajout, modification ou suppression d'un plugin, ou modification de
  `.mcp.json`, et la question est reposée.
- **Une seule décision visible par projet**, mais deux parties dans le registre :
  - `content` (plugins + `.mcp.json`) : `decision` `trusted` | `ignored`,
    `fingerprint`, `decided_at` ; ne change que par une décision prise dans le
    bandeau ou l'onglet Outils ;
  - `approved_relaxations` : les **valeurs** d'assouplissement approuvées
    (ex. `{ "shell_ask": false }`). « Faire confiance » y ajoute tous les
    assouplissements actuels du projet. Une écriture faite par l'app elle-même
    — le « Toujours » d'une demande de permission (`permission-decision`), et
    `save-project-settings` — y ajoute **uniquement les champs qu'elle vient
    d'écrire**, jamais ceux que le dépôt contenait déjà.

  - `ignored_relaxations` : les valeurs d'assouplissement refusées par
    « Ignorer », pour que le bandeau ne revienne pas à chaque ouverture tant que
    ces valeurs ne changent pas.

  Raison : avec une empreinte unique, le « Toujours » de l'utilisateur (qui écrit
  lui-même `override_permissions: true, files_ask: false`) ferait soit reposer
  la question et resterait sans effet, soit approuverait d'office des plugins
  sans rapport.
- **Un assouplissement s'applique** si et seulement si sa valeur actuelle dans le
  `config.json` de projet est égale à la valeur approuvée pour ce champ. Il est
  **en attente** si sa valeur actuelle n'est ni approuvée ni refusée.
- **Projet sans plugin ni `.mcp.json`** (assouplissements seuls) : l'empreinte
  vaut `null` et la partie `content` est sans objet ; la décision ne porte que
  sur les assouplissements.
- **États** renvoyés par la confiance d'un projet :
  - `none` : aucun contenu sensible — rien n'est affiché (cas de la plupart des
    projets) ;
  - `pending` : plugins/`.mcp.json` jamais décidés ou empreinte changée depuis
    la décision, ou au moins un assouplissement en attente ;
  - `trusted` : `content` approuvé pour l'empreinte actuelle (ou sans objet) et
    tous les assouplissements actuels approuvés ;
  - `ignored` : rien en attente, et au moins une partie refusée (`content`
    refusé pour l'empreinte actuelle, ou un assouplissement refusé).

  Les deux parties sont appliquées indépendamment : un projet `pending` à cause
  d'un nouvel assouplissement garde ses plugins approuvés si leur empreinte n'a
  pas changé.
- **UI** :
  - bandeau `ProjectTrustBanner` en haut de la zone de chat, uniquement en état
    `pending`, qui liste en clair ce que le projet apporte (chemins des plugins,
    serveurs avec leur commande ou URL, chaque assouplissement avec sa valeur
    projet et sa valeur globale), avec **[Faire confiance]** et **[Ignorer]** ;
    formulation distincte quand un contenu déjà approuvé a changé ;
  - « Ignorer » est mémorisé pour l'empreinte : pas de rappel à chaque ouverture ;
  - onglet Outils : ligne « Confiance du projet » avec l'état et
    [Faire confiance] / [Retirer la confiance] ; plugins d'un projet non approuvé
    affichés « non chargés — projet non approuvé », serveurs `.mcp.json` grisés
    « non approuvé ».
  - l'état est relu à l'activation d'un dossier et à la fin de chaque tour.

## Architecture

- **`core/project-trust.mts`** (nouveau, lecture seule — n'importe ni n'exécute
  jamais rien du projet) :
  - `inventoryProject(folder, global)` → plugins (chemins relatifs), serveurs
    MCP tels qu'écrits (`readProjectMcpConfig(folder, { expandEnv: false })`),
    assouplissements `{ champ: { project, global } }` ;
  - `contentFingerprint(folder)` → SHA-256 décrit ci-dessus (`null` si aucun
    plugin ni `.mcp.json`) ;
  - `TrustStore(home)` : lecture/écriture de `trusted-projects.json` via
    `JsonStore` (écriture atomique, sauvegarde) ; `decide(folder, decision,
    { fingerprint, relaxations })` (« Faire confiance » approuve, « Ignorer »
    refuse l'empreinte ET les valeurs d'assouplissement actuelles),
    `approveRelaxations(folder, fields)`, `revoke(folder)` (efface tout) ;
  - `projectTrust(folder, home, global)` → `{ state, inventory, contentTrusted,
    approvedRelaxations }`.
- **`core/plugin-loader.mts`** : `loadPlugins(folder, home, { includeProject })`
  — `includeProject: false` ne parcourt que `<données>/tools`.
- **`core/settings.mts`** : `effective(folder, { approvedRelaxations })` —
  applique les champs de projet plus stricts toujours, et un assouplissement
  seulement s'il figure (même valeur) dans `approvedRelaxations`. Sans ce
  paramètre, aucun assouplissement ne s'applique (sûr par défaut).
- **`worker.mjs`** :
  - `registerTools`, `plugin-list`, `mcp-list` et l'export calculent la confiance
    une fois, puis : plugins de projet seulement si `contentTrusted`, serveurs
    `.mcp.json` dans la fusion seulement si `contentTrusted`,
    `settings.effective` avec les assouplissements approuvés. La confiance est
    recalculée à **chaque** tour : un plugin ajouté pendant la session (par
    `git pull`, ou par l'agent lui-même via `create_file`) n'est jamais chargé
    sans nouvelle approbation ;
  - nouvelles opérations `project-trust` `{folder}` (état + inventaire
    d'affichage, valeurs `env`/`headers` masquées par `redactSecrets`) et
    `trust-project` `{folder, decision: 'trusted' | 'ignored' | 'revoke'}` —
    ajoutées aux listes autorisées de `worker.mjs` (`ops`) ET de `main.cjs`
    (`allowed`) ;
  - `permission-decision` (« Toujours ») et `save-project-settings` appellent
    `approveRelaxations` pour les seuls champs écrits.
- **Renderer** : `bridge.ts` (`getProjectTrust`, `decideProjectTrust`), nouveau
  `ProjectTrustBanner.tsx` dans `ChatView.tsx`, ligne de confiance et états
  « non approuvé » dans `ToolsTab.tsx`.

## Erreurs

Toujours vers « non approuvé », jamais vers « approuvé » :

- `trusted-projects.json` absent → rien n'est approuvé ; illisible ou corrompu →
  rien n'est approuvé, erreur journalisée, fichier non réécrit à l'aveugle (la
  prochaine décision le réécrit, `JsonStore` gardant une sauvegarde) ;
- fichier plugin illisible pendant le calcul d'empreinte, ou `realpath` du projet
  impossible → `pending` ;
- le contrôle n'interrompt jamais un tour : il le prive seulement du contenu non
  approuvé.

## Tests

Tous réels, aucun mock, RED d'abord.

- **Rien n'est exécuté avant approbation** : un plugin de test dont le code de
  premier niveau écrit un fichier témoin, et un serveur MCP stdio de test qui en
  écrit un au démarrage ; le témoin n'existe PAS après l'inventaire, après un
  vrai tour d'agent, ni après `plugin-list`/`mcp-list` ; après approbation, il
  apparaît.
- **Empreinte** : change à l'ajout, la modification, la suppression d'un plugin
  et à la modification de `.mcp.json` ; le contenu modifié n'est plus chargé
  avant une nouvelle approbation.
- **Assouplissements** : un `config.json` livré avec `shell_ask: false` est
  ignoré tant que non approuvé (un vrai tour demande toujours confirmation) ; un
  durcissement de projet s'applique immédiatement ; le « Toujours » de
  l'utilisateur fonctionne aussitôt, sans bandeau, et n'approuve que le champ
  écrit ; `agent_mode: auto` livré par le dépôt avec un global `ask` est ignoré.
- **Registre** : absent, corrompu → rien n'est approuvé ; indexé par chemin
  réel ; jamais écrit dans le projet.
- **Electron réel** : le bandeau apparaît avec le vrai contenu listé ;
  « Faire confiance » fait apparaître le plugin dans l'onglet Outils ;
  « Ignorer » survit à un rechargement ; « Retirer la confiance » fait
  réapparaître le bandeau.
- **Tests existants à adapter** : les tests de plugins de projet et de
  `.mcp.json` de projet (`worker-plugin.test.mts`, `worker-mcp.test.mts`,
  `mcp-visual.cjs`, le test visuel des plugins) supposent un chargement
  immédiat ; ils approuvent désormais d'abord le projet via `trust-project`.
  C'est attendu : leur comportement d'origine est précisément le trou fermé ici.

## Hors scope (explicitement, pas un oubli)

- Texte venu du projet (`custom_prompt`, `OPENAGENT.md`, `.openagent/memory.md`) :
  toujours lu sans approbation. Injection de prompt possible, mais sans capacité
  propre — ce qu'il peut provoquer reste borné par les permissions, désormais
  protégées.
- Modules auxiliaires importés par un plugin : non couverts par l'empreinte
  (seuls les fichiers d'entrée le sont) — même limite que le cache de modules
  actuel.
- Remplacement d'un fichier entre son hachage et son import : suppose déjà un
  accès en écriture local à cet instant précis.
- Une commande shell déjà autorisée peut toujours tout faire, y compris modifier
  le registre de confiance : ce lot ne met pas le shell en bac à sable.
- `ignored_patterns` de projet, et contenu global : non concernés.
