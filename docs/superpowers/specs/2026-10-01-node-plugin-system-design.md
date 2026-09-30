# Système de plugins Node pour openagent (Electron)

Date : 2026-10-01. Statut : conception validée par « oui » ; non implémentée.

## Contexte

Python (`openagenticskyzer/plugins/loader.py`) charge dynamiquement des outils
agent depuis des fichiers `.py` déposés par l'utilisateur, dans trois dossiers :
`~/.openagent/tools/`, `<projet>/tools/`, `<projet>/.openagent/tools/`. Chaque
fichier doit exporter une fonction `get_tools()` retournant une liste d'objets
outils (forme LangChain : `.name` + `.invoke()` appelable), et peut exposer un
hook optionnel `on_load(folder)`. Le chargement est isolé par fichier — une
erreur dans un plugin n'empêche pas les autres de charger. L'UI (`settings.py::
_tab_tools`) n'affiche qu'une liste en lecture seule (🧩 nom des plugins chargés,
⚠️ erreurs éventuelles) ; aucun ajout/suppression depuis l'interface, la gestion
se fait en déposant des fichiers.

Ce mécanisme n'a jamais été porté à Electron (code Python non exécutable dans
Node), et a été explicitement documenté comme limite assumée aux Tâches 86 et 97
de `tasks/todo.md`. Décision utilisateur (2026-10-01) : le remplacer par un
système de plugins natif Node, pas par un portage du mécanisme Python lui-même.

## Contrat de livraison

- Trois mêmes dossiers scannés que Python (global + projet/tools + projet/
  .openagent/tools), fichiers `.mjs` et `.mts` (l'extension unique `.py` de
  Python n'a pas de sens ici ; les deux formats déjà utilisés ailleurs dans ce
  dépôt — `.mts` pour `core/`, `.mjs` pour les fichiers racine — sont acceptés).
  `__init__.*` et fichiers cachés (commençant par `.`) ignorés, comme Python
  ignore `__init__.py`.
- Un plugin exporte une fonction `getTools()` (synchrone ou asynchrone)
  retournant un tableau de `ToolSpec` (`core/tool-kit.mts`, la même forme que
  les outils internes du projet : `name`, `description`, `category`,
  `properties`, `required`, `execute`). Hook optionnel `onLoad(folder)`.
- La `category` déclarée par un plugin est **toujours ignorée et forcée à
  `'extension'`** par le loader — confirmation systématique avant exécution
  (sauf mode auto complet), exactement le même traitement que les outils MCP
  déjà existants. Un plugin ne peut jamais se faire passer pour `'read'` afin
  d'éviter cette confirmation.
- Chargement isolé par fichier : une erreur (syntaxe, exception à l'import,
  `getTools` absente ou ne retournant pas un tableau valide, un outil sans
  `name`/`execute`) est capturée, n'empêche pas le chargement des autres
  fichiers, et est renvoyée dans une liste d'erreurs séparée — même isolation
  que `mcp-client.mts::mcpTools`.
- Aucun bac à sable : un plugin s'exécute avec les pleins pouvoirs du
  processus worker Node, même niveau de confiance que les plugins Python
  actuels (le seul garde-fou réel est la catégorie `'extension'` forcée).
- UI en lecture seule dans `ToolsTab.tsx` : section « Plugins » listant les
  plugins chargés (🧩 nom) et les erreurs (⚠️ message), aucun ajout/suppression
  depuis l'interface — parité avec `settings.py::_tab_tools`.

## Architecture

Nouveau module pur `electron/core/plugin-loader.mts` :

```ts
export interface PluginLoadResult { tools: AgentTool[]; errors: string[] }
export async function loadPlugins(folder: string, home: string): Promise<PluginLoadResult>
```

- Résout les trois dossiers (`join(home, 'tools')`, `join(folder, 'tools')`,
  via `metadataDirectory(folder)` puis `tools` pour le troisième — respecte la
  protection anti-jonction déjà en place pour tout ce qui vit sous
  `.openagent/`), liste chaque dossier existant (`readdir`, trié, dossiers
  absents silencieusement ignorés — jamais une erreur bloquante).
- Pour chaque fichier `.mjs`/`.mts` (hors `__init__.*`/caché) : `import()`
  dynamique via une URL `file://` (même mécanisme que Node utilise déjà pour
  charger `.mts` à l'exécution dans ce projet — vérifié fonctionnel y compris
  packagé, Tâche 90), appelle `getTools()`, valide chaque entrée retournée
  (présence de `name`/`execute`, types corrects) avant de l'enregistrer via
  `defineTool` (catégorie forcée), exécute `onLoad(folder)` si présent.
- Toute exception (à l'import, dans `getTools()`, dans la validation) est
  capturée avec le nom du fichier et le message, ajoutée à `errors`, poursuite
  avec le fichier suivant.

Câblage dans `worker.mjs::registerTools` : `...await loadPlugins(folder,
dataHome).then(r => r.tools)` ajouté à la liste d'outils, à côté de
`mcpDiscovered` ; les erreurs vont dans `console.error` du worker (jamais dans
le chat), même traitement que les erreurs MCP déjà en place. Nouvel op worker
`plugin-list` (retourne `{tools: string[], errors: string[]}` pour l'affichage
UI, sans ré-exécuter les plugins à chaque appel — un simple appel à
`loadPlugins` suffit, il est rapide et sans effet de bord côté fichiers).

## Erreurs et validation

- Dossier absent → ignoré, pas une erreur.
- Fichier qui ne s'importe pas (syntaxe invalide, exception au niveau module)
  → erreur isolée, fichier ignoré.
- `getTools` absente ou non appelable → erreur explicite (« pas de fonction
  getTools() »), comme le message français déjà utilisé côté Python.
- `getTools()` ne retourne pas un tableau, ou un élément sans `name`/`execute`
  valide → erreur explicite, l'outil concerné n'est jamais enregistré même
  partiellement.
- Deux plugins qui déclarent le même `name` qu'un outil déjà enregistré (outil
  interne, MCP, ou un autre plugin) → refusé au niveau de `runAgent`, qui lève
  déjà « Nom outil invalide ou dupliqué » (`agent.mts:55-56`, comportement
  inchangé, aucune modification nécessaire).

## Tests

- RED-first `tests/plugin-loader.test.mts` : fixtures de vrais fichiers `.mjs`/
  `.mts` écrits sur disque (jamais de mock) — un plugin valide chargé et
  appelable, un plugin par dossier (les trois portées), un fichier sans
  `getTools()` isolé sans bloquer les autres, un outil retourné sans `name`
  refusé, `__init__.mjs`/fichier caché ignoré, dossier absent silencieux,
  catégorie déclarée par le plugin bien ignorée et forcée à `'extension'`.
- Preuve d'intégration réelle : `tests/worker-plugin.test.mts` — vrai
  `worker.mjs`, vrai fichier plugin sur disque, un vrai tour d'agent qui
  appelle l'outil du plugin de bout en bout (même patron que
  `worker-mcp.test.mts`).
- Preuve Electron réelle : extension de `tests/mcp-visual.cjs` ou nouveau test
  dédié pour la section « Plugins » de `ToolsTab.tsx` (liste + erreur
  affichées réellement).

## Hors scope (explicitement, pas un oubli)

- Aucun bac à sable / limitation de capacités pour un plugin (parité de risque
  avec Python, pas une régression).
- Aucune UI d'ajout/suppression de plugin (parité avec Python — gestion par
  fichiers uniquement).
- Aucun registre/marketplace de plugins, aucune installation depuis npm.
