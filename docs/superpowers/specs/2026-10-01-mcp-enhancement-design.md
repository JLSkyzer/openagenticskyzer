# MCP enrichi : config par projet, variables d'environnement, transports distants

Date : 2026-10-01. Statut : conception validée par « oui » ; non implémentée.

## Contexte

Le client MCP actuel (`electron/core/mcp-config.mts`, `mcp-client.mts`,
`ToolsTab.tsx`, livré Tâche 86) est fonctionnel mais limité : un seul fichier
de config globale (`~/.openagent/mcp.json`), serveurs stdio uniquement (spawn
d'un process enfant local), pas de variables d'environnement, ajout/suppression
uniquement via une ligne de commande complète tapée dans l'UI. Décision
utilisateur (2026-10-01) : l'enrichir pour se rapprocher de ce que propose
Claude Code — config par projet en plus de la globale, variables d'env par
serveur, transports SSE/HTTP pour des serveurs distants (authentification par
en-tête statique seulement pour ce lot, pas d'OAuth).

## Contrat de livraison

- **Deux portées de configuration, fusionnées** :
  - Globale (inchangée) : `~/.openagent/mcp.json`, gérée par l'UI existante
    (ajout/suppression).
  - Projet (nouveau) : `<projet>/.mcp.json`, à la racine du projet (pas caché
    sous `.openagent/` — pensé pour être versionné et partagé en équipe, comme
    l'usage réel de Claude Code). Lu automatiquement à l'activation d'un
    dossier. **Jamais écrit par l'application** — géré à la main ou via git par
    l'utilisateur, l'UI ne fait que le lire et fusionner.
  - Fusion : union des deux ensembles ; en cas de collision de nom, le serveur
    projet l'emporte sur le serveur global (portée la plus spécifique gagne).
- **Même schéma que le vrai Claude Code** (interopérabilité réelle : un
  `.mcp.json` écrit pour Claude Code doit fonctionner tel quel ici) :
  ```json
  {
    "mcpServers": {
      "nom-serveur": { "command": "npx", "args": ["-y", "pkg"], "env": { "CLE": "valeur" } },
      "serveur-distant": { "type": "sse", "url": "https://exemple.com/mcp", "headers": { "Authorization": "Bearer ..." } }
    }
  }
  ```
  `command`/`args`/`env` pour un serveur stdio (le `type` est implicite si
  `command` est présent) ; `type: "sse" | "http"` + `url` + `headers` optionnel
  pour un serveur distant.
- **Variables d'environnement** pour les serveurs stdio : transmises au process
  enfant au spawn, en plus de l'environnement hérité du worker (jamais à la
  place — un serveur qui a besoin de `PATH` ne doit pas le perdre).
- **Transports SSE/HTTP** : connexion à un serveur MCP distant sans spawn de
  process local, JSON-RPC sur HTTP avec un flux SSE pour les messages
  serveur→client (spec MCP « Streamable HTTP »), en-têtes statiques (ex.
  `Authorization`) injectés sur chaque requête sortante. Aucun flux OAuth —
  hors scope explicite de ce lot, à réévaluer séparément si le besoin se
  confirme.
- **UI (`ToolsTab.tsx`)** : liste fusionnée des serveurs (les deux portées),
  puce « projet » sur ceux venant de `.mcp.json` avec le bouton ✕ désactivé
  pour ceux-là (rien à supprimer côté app, c'est un fichier externe). Le champ
  existant (ligne de commande complète) reste pour ajouter un serveur stdio
  global. Nouveau petit formulaire (URL + en-tête d'autorisation optionnel)
  pour ajouter un serveur distant global.

## Architecture

- `core/mcp-config.mts` — `McpConfigStore` existant conserve son rôle pour la
  portée globale, étendu pour accepter/persister `env` sur `add()`. Nouvelle
  fonction pure `readProjectMcpConfig(folder): Promise<McpServerConfig[]>` —
  lit `<folder>/.mcp.json`, tolère absence de fichier (retourne `[]`) et JSON
  malformé (retourne `[]` avec un avertissement loggé, jamais une exception
  qui bloquerait l'activation du dossier — même philosophie que
  `project_memory.py`/les autres lectures tolérantes déjà dans ce projet).
  Nouvelle fonction pure `mergeServerConfigs(global, project):
  McpServerConfig[]` — union par nom, projet gagne sur collision.
- Type union `McpServerConfig` :
  ```ts
  type StdioServerConfig = { id: string; name?: string; command: string; args: string[]; env?: Record<string, string> };
  type RemoteServerConfig = { id: string; name?: string; type: 'sse' | 'http'; url: string; headers?: Record<string, string> };
  type McpServerConfig = StdioServerConfig | RemoteServerConfig;
  ```
- `core/mcp-client.mts::openSession()` — branche sur la forme du config :
  stdio garde le comportement actuel (spawn + JSON-RPC newline-delimited),
  `env` fusionné avec `process.env` du worker au spawn ; sse/http ouvre une
  connexion réelle (recherche de l'implémentation exacte du transport
  « Streamable HTTP » MCP à faire en amont de l'implémentation — la spec
  protocolaire doit être vérifiée contre sa source officielle avant de coder,
  pas supposée). Isolation par serveur déjà existante (un serveur cassé
  n'empêche pas les autres) inchangée pour les deux types.
- `worker.mjs::registerTools` — `mcpConfig.list()` devient la fusion
  global+projet (lit `.mcp.json` du dossier actif à chaque appel, comme
  `effective settings` le fait déjà pour d'autres réglages par projet).

## Erreurs et validation

- `.mcp.json` absent → liste projet vide, comportement identique à aujourd'hui.
- `.mcp.json` présent mais JSON invalide, ou `mcpServers` absent/mal formé →
  ignoré avec un avertissement loggé (jamais un crash de l'activation du
  dossier).
- Un serveur distant qui échoue à se connecter (URL injoignable, en-tête
  invalide) → isolé exactement comme un serveur stdio qui ne démarre pas
  aujourd'hui (erreur loggée côté worker, pas de blocage des autres serveurs).
- Un en-tête d'autorisation saisi dans l'UI est stocké en clair dans
  `mcp.json` (portée globale), au même titre que les variables `env` des
  serveurs stdio déjà prévues par ce même schéma — cohérent avec la
  convention réelle de Claude Code (son propre `.mcp.json` stocke `env` en
  clair). Le coffre chiffré `connections.mts` reste réservé aux clés des
  fournisseurs de modèle (portée différente, ne pas réutiliser ici).

## Tests

- Unitaire : fusion global/projet avec collision de nom (projet gagne),
  `.mcp.json` absent/malformé toléré, `env` bien transmis au process enfant
  (vrai process, lit sa propre variable d'environnement et la retourne — pas
  un mock).
- Preuve d'intégration réelle : un vrai petit serveur HTTP/SSE local (nouvelle
  fixture, même esprit que `fixtures/fake-mcp-server.cjs` mais en HTTP) pour
  prouver le transport distant de bout en bout, en-tête d'autorisation
  vérifié réellement reçu par le serveur fixture.
- Preuve Electron réelle : `ToolsTab.tsx` affiche bien la puce « projet », le
  formulaire d'ajout de serveur distant fonctionne réellement.

## Hors scope (explicitement, pas un oubli)

- Authentification OAuth pour les serveurs distants.
- Édition de `.mcp.json` depuis l'UI (lecture seule, géré par fichier/git).
- Ressources et prompts MCP (seuls les outils — `tools/list`/`tools/call` —
  sont dans le scope, comme l'implémentation actuelle).
