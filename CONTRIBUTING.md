# Contribuer à openagent

## Mise en place

Prérequis : Windows, Node.js 24, git 2.44 ou plus récent.

```bash
git clone https://github.com/JLSkyzer/openagenticskyzer.git
cd openagenticskyzer/electron
npm ci
npm run renderer:build
```

## Structure

- `electron/main.cjs` — processus principal (fenêtre, coffre des clés, mises à jour).
- `electron/worker.mjs` — moteur (agent, outils, stockage), dans un `worker_threads`.
- `electron/core/*.mts` — modules du moteur, sans dépendance à Electron.
- `electron/renderer-src/` — interface React (Vite).
- `electron/tests/` — tests ; `tests/all.mts` les enregistre tous.

## Tests

```bash
cd electron
node --experimental-strip-types --test tests/all.mts
npx tsc --noEmit -p tsconfig.core.json
npx tsc --noEmit -p renderer-src/tsconfig.json
```

Les tests `npm run test:*` ouvrent une vraie fenêtre de l'application : lance-les un par un, une fois.

## Règles

- Tests d'abord : écrire le test, le voir échouer, puis implémenter.
- Tests réels : vrais fichiers, vrai worker, vrai serveur HTTP de test ; pas de mocks.
- Un commit par modification terminée et vérifiée, avec les seuls fichiers modifiés (pas de `git add -A`).
- Tout nouveau fichier chargé par le processus principal va dans `build.files` de `electron/package.json` dans le même commit.
- Les suivis et bilans de lots sont dans `tasks/todo.md` ; les leçons dans `tasks/lessons.md`.
