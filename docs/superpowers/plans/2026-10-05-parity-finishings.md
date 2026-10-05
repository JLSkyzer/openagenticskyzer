# Parity Finishings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last seven partial rows of the parity matrix (2, 6, 7, 14, 16, 18, 30) and keep secret and ignored files out of the semantic index, so the migration can be marked « LIVRÉE ».

**Architecture:**
- **Index without secrets (row 30, security).** The file tools' filter leaves its closure in `core/workspace.mts` for a new shared module, `core/file-filter.mts`. Both `workspace.mts` and `core/semantic-index.mts` import it. Indexing skips what a search hides and drops JsonStore's backup copy of the old index. `semantic_search` filters again at read.
- **Tool cards (row 6).** The agent loop saves each tool result with `name` and `category`. `core/request-context.mts` sends a tool result as `role`, `tool_call_id` and `content` only. A new pure module, `renderer-src/src/state/tool-cards.ts`, builds each card's name, category and detail on every load and live, recovering the name of an older result from the preceding `tool_calls`. `edit_file` appends a bounded unified diff computed by a new in-repo module, `core/unified-diff.mts`.
- **Typed path (row 2).** The Sidebar gets « Chemin du dossier » + « Ouvrir ». It goes through the same `activate()` as the dialog. `activate_folder` now also answers the canonical folder, so a typed spelling is activated under the path the history stores.
- **Window proofs (rows 6, 7, 14, 16, 18).** These extend `chat-visual`, `export-visual` and `theme-visual`, and add a worker test for `search_ask`. They fix the two defects the code shows: a double send when the box is refilled between two Enter, and the IPC wrapper in the export failure toast.

**Tech Stack:**
- Electron 44.4.2 and Node 24 (`--experimental-strip-types`, `worker_threads`, `node:test`).
- React 19, Vite 8, TypeScript 7.
- electron-builder 26.
- No new dependency: `package.json` has no diff library, so the diff is about 40 lines in-repo.

**Spec:** `docs/superpowers/specs/2026-10-05-parity-finishings-design.md` is the authority. The `file:line` evidence per row is in `docs/superpowers/specs/2026-10-04-parity-matrix-audit.md`.

## Global Constraints

- **Real tests, no mocks, RED first for new behaviour.** Use real files in a `mkdtemp` folder, a real `worker.mjs` in a `worker_threads` Worker, a real HTTP fake model server (`node:http` on `127.0.0.1:0`) and real Electron windows for UI proofs. Every unit or worker test of new behaviour is run and seen failing before its implementation.
  - Tests of rows that only lacked a proof (row 30's modify-then-search, row 18's `search_ask`) are expected to pass on their first run. If one fails, the failure is a real defect: investigate and fix it in the same task, and say so in the bilan.
- **Windows open once.**
  - Every test that opens a window (`*-visual.cjs`, `test:package`) runs **once**. The user explicitly asked for this. On failure, report the output and stop; never re-run in a loop.
  - These tests are not run RED. The RED proof of each change is its unit or worker test.
  - Each window test runs in the task that touches it, after the implementation: `index-status` in Task 1, `sidebar` in Task 3, and `chat`, `export`, `theme` in Task 4. Task 5 runs `test:package` only.
  - Each visual test needs a fresh `renderer-dist`: run `npm run renderer:build` (from `electron/`) right before it.
- **No user data.** The user's real data home (`%USERPROFILE%\.openagent`) and real projects are **never** touched. Every worker gets `OPENAGENT_HOME=<temp>`, and every project is a `mkdtemp` folder.
- **Commits.**
  - Each task commits only its own files, with explicit `git add <paths>` from the repository root, never `git add -A` or `git add .`.
  - The repository has unrelated uncommitted user docs changes that must stay untouched:
    - `docs/superpowers/plans/2026-04-27-*.md` (deleted);
    - `liste logique à suivre.txt`;
    - `docs/superpowers/specs/2026-09-14-electron-autonomous-design.md`;
    - the untracked `OK …`, `native-desktop` and `mcp-enhancement` files.
    - This plan file is not committed by any task.
  - Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a last `-m` paragraph.
  - Push after each task's commit with `git push origin master`, per the user's standing instruction.
- **Registration and suite.**
  - Every new `*.test.mts` file is registered in `electron/tests/all.mts` as a new last line `import './<file>';`.
  - The full suite runs from `electron/` with `timeout 900 node --experimental-strip-types --test tests/all.mts`.
  - The **baseline is 781/781**. This lot adds 22 tests, so the expected total is **803/803**:
    - Task 1 adds 8;
    - Task 2 adds 11;
    - Task 3 adds 1;
    - Task 4 adds 2.
- **tsc baselines** (from `electron/`):
  - `npx tsc --noEmit -p tsconfig.core.json` shows the **5 pre-existing errors only**: local-engine.mts, local-provider.mts, pdf-loader.ts, local-provider.test.mts ×2. Tests are in this project, and so are the renderer state files they import.
  - `npx tsc --noEmit -p renderer-src/tsconfig.json` shows **0**.
- **Exact values from the spec** (verbatim):
  - the detail is cut to **120** characters;
  - the diff is capped at **60** lines / **4 000** characters, with the marker `[diff tronqué]`;
  - the toast « Échec de l'export »;
  - the accent `#ff0000`;
  - the field label « Chemin du dossier » and the button « Ouvrir ».
- **`name`/`category` never reach the provider.** A tool result goes out as `role`, `tool_call_id` and `content` only.
- **Packaging.** No file required by `main.cjs` is added. The two new core modules are covered by `build.files` → `core/**/*`. `package:win` + `test:package` prove it in Task 5.
- **Rulings made while writing this plan** (read against the code). Every task applies them, and the bilan lists them.
  1. **"The secret list used by `read_file` / `grep_codebase`".**
     - `read_file` (like every file tool) only refuses `.env*`, `.git`, `.openagent` and `ignored_patterns`: the closure `blocked`, at `core/workspace.mts:15-21`.
     - Key material by name (`SENSITIVE_FILE`, `:77`: `secrets.json`, `credentials.json`, `id_rsa`…, `*.pem|key|p12|pfx`) is hidden by the **searches** only (`glob_files`, `grep_codebase`).
     - The index is a search, so it applies the union: `searchExclusion(ignoredPatterns)` = `blocked` ∪ `SENSITIVE_FILE`, from the one shared module.
     - `read_file` is unchanged. It can still read `secrets.json` by name, and the bilan reports this as out of scope.
  2. **Purge.**
     - `indexFolder` is already a full rebuild that replaces the store (`core/semantic-index.mts:90-91`), so filtering the scan purges.
     - But `JsonStore.update` copies the first version of any file it rewrites to `<file>.pre-electron.bak`, once and forever (`core/json-store.mts:56-57`). For the index, that copy would keep pre-lot chunks of `secrets.json` after the purge.
     - So `indexFolder` removes `codebase.json.pre-electron.bak` after each write. The index is a cache rebuilt from the files, and its backup protects nothing.
  3. **Read filter default.** `searchCollection`'s new `excluded` parameter defaults to `searchExclusion('')`. Secrets and protected paths are hidden even from a caller that passes no patterns.
  4. **Where the index reads the patterns.**
     - `triggerIndexing` reads `(await settings.project(folder)).ignored_patterns`. That is the value `settings.effective()` gives the file tools: `ignored_patterns` is a project-only key and never a relaxation (`core/settings.mts:154-166`).
     - An unreadable project config makes the index run end in its existing `error` state, with nothing written.
  5. **Detail per tool.** The spec's groups become an explicit table (`tool-cards.ts`):
     - `path` for the 11 workspace tools;
     - `command` for `run_command`;
     - `query` for `internet_search`, `semantic_search` and `knowledge_search`;
     - `url` for `fetch_url`;
     - nothing for the others, even when they have a `path`-like argument (`git_blame.file`).
     - `glob_files`/`grep_codebase` show their `path` only when one is given.
     - The cut is `slice(0, 120)` with no ellipsis, as Python's `[:120]`. The card's CSS `truncate` handles the width.
  6. **Diff bounds include the marker.** A cut diff is the first 59 lines, cut to `4000 - 15` characters, then `\n[diff tronqué]`, so the whole result is ≤ 60 lines and ≤ 4 000 characters. Only the shown diff is cut: the file gets the whole edit.
  7. **`edit_file` already returned a pseudo-diff.** It returned `Modifié : <path>\n-<old>\n+<new>` (`core/workspace.mts:194`). Only the first line of a multi-line string carried the sign, and there were no headers and no context. The audit's « aucun diff » is inaccurate: single-line edits were already coloured. It is replaced by a real unified diff (`--- a/`, `+++ b/`, `@@`, 3 context lines). The `---`/`+++` header lines get a neutral style on the card.
  8. **Neutral badge.** Two cases get a neutral badge, `OUTIL` (`data-badge="neutral"`):
     - an unknown category: an older result, or a Stop/error closing result;
     - a category with no colour of its own: `extension`, which MCP and plugin tools use.
     - Before this lot, both showed no badge at all.
  9. **Closing results keep their shape.** `closeDanglingCalls` (Stop/error) results are made by the worker, not the agent loop. They stay `{ role, tool_call_id, content }`: `request-context.test.mts:93` and `worker-request.test.mts:172` assert that shape.
     - Live, their card takes the name and category from the `tool-start` that preceded them.
     - After a reload, the name comes from `tool_calls` and the badge is neutral.
  10. **Typed path.**
      - Surrounding double quotes (Explorer's « Copier en tant que chemin d'accès ») are stripped, and the value is trimmed.
      - An empty value is refused in the page with `Impossible d’ouvrir ce dossier : chemin vide`.
      - Every other refusal is the worker's own reason (`Dossier absolu requis`, `Dossier introuvable`), without the IPC wrapper (`cleanIpcError`): `Impossible d’ouvrir ce dossier : <raison>`. `FoldersService.recordOpened` already refuses a relative, missing or non-directory path, and its messages stay unchanged.
      - The worker's `activate_folder` reply gains `folder`: the canonical path.
      - The Sidebar activates a **typed** path under it, so `C:/x/proj` highlights the stored `C:\x\proj` entry. The dialog and history clicks keep passing their own path, unchanged.
  11. **Row 7.**
      - Shift+Enter: a synthetic `KeyboardEvent` never performs the browser's default action, so no newline appears. The proof is that the app leaves Shift+Enter's keydown uncancelled (the textarea's own new line) while it cancels a plain Enter, and that no request reaches the fake server.
      - Double send: reading `InputBar.tsx:76-86` shows a real defect. The guard is `state.agentRunning`, which turns true only after the worker's reply, and the worker's `send` has no same-folder guard. Enter, then Enter again with the box refilled in the same tick, starts **two turns** in one folder.
      - The fix is a `sendingRef` set before the first `await`, checked before the box is emptied. The text typed meanwhile stays in the box.
      - The few milliseconds between the reply and React's next render are not covered. A human key cannot land there, and the bilan says so.
  12. **Row 14.**
      - « Dossier rendu inaccessible » means renaming the active folder on disk after activation. The test first waits for the background indexing to end, and the rename is retried for up to 5 s on `EPERM`/`EBUSY`/`EACCES`, because Windows refuses to rename a folder a process still holds.
      - The toast showed Electron's wrapper (`Échec de l'export : Error invoking remote method 'backend-request': Error: …`) because `performExport` did not use `cleanIpcError`. This is fixed, with a unit test.
  13. **Row 6 also closes « blocs de code et défilement ».** The open box in `tasks/todo.md` lists them for row 6, though the spec does not. Two assertions in `chat-visual` cover them: `pre code.hljs`, and the view at the bottom of a conversation taller than the window.
  14. **Reopening in `chat-visual`.**
      - Clicking the active folder's entry does not reload the chat. `ChatProvider`'s load effect is keyed on `activeFolder` (`ChatProvider.tsx:115-131`), and `App` bails out on an equal folder.
      - So the test opens a second folder, then clicks the project again.
      - `export-visual.cjs:131` relies on a same-entry click reloading. That could not be explained by reading, and it is not touched here.
  15. **Row 18 without network.**
      - `fetch_url` to `http://127.0.0.1:9/page` is refused by the SSRF policy **when it runs** (`Erreur : Adresse réseau interne ou privée refusée`). That proves it ran, and no packet leaves the machine.
      - « Refusée » gives `Erreur : Exécution refusée par les permissions`, with no `tool-start`.
  16. **Decomposition.** All window proofs of rows 6 and 7 are in Task 4, so `chat-visual.cjs`, touched by both rows, is changed and run once. Task 2 proves row 6 with unit, reducer and worker tests.
  17. **Closure.** The header becomes « LIVRÉE » only if every window test of Tasks 1, 3 and 4 and `test:package` passed on their single run. Otherwise it names exactly the rows whose proof failed.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `electron/core/file-filter.mts` | **create** | `SENSITIVE_FILE`, `protectedPathMatcher`, `searchExclusion`: the one filter for file tools, searches and the index |
| `electron/core/workspace.mts` | modify | imports the filter (no copy); `edit_file` returns success line + bounded unified diff |
| `electron/core/semantic-index.mts` | modify | scan skips excluded paths; `indexFolder(…, ignoredPatterns)`; backup copy removed; `searchCollection(…, excluded)` filters at read |
| `electron/core/search-tools.mts` | modify | `searchTools(folder, home, ignoredPatterns)` passes the exclusion to `semantic_search` |
| `electron/core/unified-diff.mts` | **create** | `unifiedDiff`, `boundedDiff`, `DIFF_MAX_LINES`, `DIFF_MAX_CHARS`, `DIFF_TRUNCATED` |
| `electron/core/provider.mts` | modify | `ChatMessage.name?`, `ChatMessage.category?` (documented as never sent) |
| `electron/core/agent.mts` | modify | tool results saved with `name` and `category` |
| `electron/core/request-context.mts` | modify | a tool result goes out as `role`, `tool_call_id`, `content` |
| `electron/worker.mjs` | modify | index trigger reads the project's patterns; `searchTools` gets them; `activate_folder` answers `folder` |
| `electron/renderer-src/src/state/tool-cards.ts` | **create** | `toolDetail`, `callsById`, `toolCard`, `withToolCards`, `RenderedMessage`, `TOOL_DETAIL_MAX` |
| `electron/renderer-src/src/state/reducer.ts` | modify | cards built on every load and live; `ToolMeta.detail` |
| `electron/renderer-src/src/components/ToolMessage.tsx` | rewrite | detail in the header, neutral badge, test ids, neutral diff headers |
| `electron/renderer-src/src/components/ChatView.tsx` | modify | passes `detail` |
| `electron/renderer-src/src/components/Sidebar.tsx` | modify | « Chemin du dossier » + « Ouvrir » |
| `electron/renderer-src/src/ipc/bridge.ts` | modify | `activateFolder` reply has `folder` |
| `electron/renderer-src/src/components/InputBar.tsx` | modify | `sendingRef` guard |
| `electron/renderer-src/src/state/export.ts` | modify | toast through `cleanIpcError` |
| tests | see each task | new: `file-filter.test.mts`, `unified-diff.test.mts`, `tool-cards.test.mts` |
| `tasks/todo.md`, `tasks/lessons.md` | modify | closure (Task 5) |

**Decomposition changes against the suggested one, and why:**
- **Task 2 has no window test.** `chat-visual.cjs` carries the proofs of rows 6 **and** 7. Putting both in Task 4 changes and runs that file once, instead of twice, two different versions, in two tasks. Task 2 is proven by unit, reducer and worker tests.
- **Task 4 holds two code fixes, not just tests.** Its tests reveal them: the double send (row 7) and the IPC wrapper in the export toast (row 14).
- **`core/file-filter.mts` is a new module** rather than an export from `workspace.mts`. The filter was a closure inside `workspaceTools()`, unreachable from the index. A small module that both import avoids a copy, and avoids making `semantic-index.mts` depend on the whole tool factory.

---

### Task 1: The index never sees secret or ignored files (row 30 and security)

**Files:**
- Create: `electron/core/file-filter.mts`
- Create: `electron/tests/file-filter.test.mts`
- Modify: `electron/core/workspace.mts:1-21,77` (import, `blocked`, `SENSITIVE_FILE`)
- Modify: `electron/core/semantic-index.mts` (whole file shown below)
- Modify: `electron/core/search-tools.mts` (whole file shown below)
- Modify: `electron/worker.mjs:74-85` (`triggerIndexing`), `:200` (`builtInTools`)
- Modify: `electron/tests/semantic-index.test.mts` (imports + 3 tests appended)
- Modify: `electron/tests/search-tools.test.mts` (imports + 1 test appended)
- Modify: `electron/tests/worker-index-status.test.mts` (imports + 1 test appended)
- Modify: `electron/tests/worker-search-tools.test.mts` (imports + 1 test appended)
- Modify: `electron/tests/all.mts` (register `file-filter.test.mts`)

**Interfaces:**
- Produces (`core/file-filter.mts`):
  - `SENSITIVE_FILE: RegExp`
  - `protectedPathMatcher(ignoredPatterns: string): (rel: string) => boolean`
  - `searchExclusion(ignoredPatterns: string): (rel: string) => boolean`
- Produces (`core/semantic-index.mts`):
  - `indexFolder(folder: string, home: string, onProgress?: (current: number, total: number, filepath: string) => void, ignoredPatterns?: string): Promise<{ chunks: number }>`
  - `searchCollection(collectionPath: string, query: string, home: string, n?: number, excluded?: (file: string) => boolean): Promise<SearchResult[]>`
- Produces (`core/search-tools.mts`): `searchTools(folder: string, home: string, ignoredPatterns?: string): Promise<AgentTool[]>`
- Later tasks consume nothing from this task.

- [ ] **Step 1: Write the failing filter tests**

Create `electron/tests/file-filter.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { protectedPathMatcher, searchExclusion } = await import('../core/file-filter.mts');

test("protectedPathMatcher refuses .env*, .git and .openagent at any depth and the project's ignored patterns, with either separator", () => {
  const blocked = protectedPathMatcher('node_modules/, dist/, ignored.txt, *.log');
  for (const rel of ['.env', 'sub/.env.local', '.git/config', 'a/.openagent/x.json', 'node_modules/x/index.js', 'dist\\out.js', 'ignored.txt', 'deep/ignored.txt', 'logs/a.log']) {
    assert.equal(blocked(rel), true, rel);
  }
  for (const rel of ['src/app.ts', 'environment.ts', 'dist-notes.md', 'secrets.json']) assert.equal(blocked(rel), false, rel);
});

test('searchExclusion adds key material by name: what no search and no index ever shows', () => {
  const hidden = searchExclusion('private/');
  for (const rel of ['secrets.json', 'conf/credentials.json', 'id_rsa', 'keys/server.pem', 'a.key', 'cert.pfx', 'store.p12', 'private/notes.md', '.env', 'sub\\secrets.json']) {
    assert.equal(hidden(rel), true, rel);
  }
  for (const rel of ['src/secrets.ts', 'README.md', 'public/key.md']) assert.equal(hidden(rel), false, rel);
});
```

Append to `electron/tests/all.mts`:

```typescript
import './file-filter.test.mts';
```

- [ ] **Step 2: Write the failing index tests**

In `electron/tests/semantic-index.test.mts`, replace lines 3-5:

```typescript
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

with:

```typescript
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
```

Append to `electron/tests/semantic-index.test.mts`:

```typescript
test('indexFolder never indexes a secret file nor one the project ignores, and a rebuild purges them from an older index, backup copy included', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'sort.py'), 'def sort_list(items):\n    return sorted(items)\n');
  await writeFile(join(project, 'secrets.json'), '{"api_key": "SECRET-INDEX-1"}');
  await writeFile(join(project, 'credentials.json'), '{"token": "SECRET-INDEX-2"}');
  await mkdir(join(project, 'private'));
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-INDEX-3');
  await writeFile(join(project, 'draft.md'), 'SECRET-INDEX-4');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  // An index written before 2026-10-05: every one of these files in it.
  const store = await storePath(project);
  await mkdir(dirname(store), { recursive: true });
  const stale = ['secrets.json', 'credentials.json', 'private/notes.md', 'draft.md']
    .map((file, i) => ({ id: `${file}:0`, file, chunk: 0, text: `SECRET-INDEX-${i + 1}`, vector: new Array(384).fill(0) }));
  await writeFile(store, JSON.stringify({ version: 1, entries: stale }));

  const seen: string[] = [];
  await indexFolder(project, home, (_current, _total, file) => seen.push(file), 'private/, draft.md');

  const raw = JSON.parse(await readFile(store, 'utf8'));
  assert.deepEqual([...new Set(raw.entries.map((e: any) => e.file))], ['sort.py']);
  assert.deepEqual(seen, ['sort.py'], 'an excluded file is not even read');
  assert.deepEqual(await readdir(dirname(store)), ['codebase.json'], 'no backup copy keeps the old index');
  assert.equal(JSON.stringify(raw).includes('SECRET-INDEX'), false);
});

test('searchCollection never returns a chunk of a secret or excluded file, even from an index written before the filter existed', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const { searchCollection, storePath } = await import('../core/semantic-index.mts');
  const { embed } = await import('../core/embeddings.mts');
  const { searchExclusion } = await import('../core/file-filter.mts');
  const [vector] = await embed(['trier une liste'], home);
  const entry = (file: string, text: string) => ({ id: `${file}:0`, file, chunk: 0, text, vector });
  const store = await storePath(project);
  await mkdir(dirname(store), { recursive: true });
  await writeFile(store, JSON.stringify({ version: 1, entries: [
    entry('secrets.json', 'SECRET-READ-1'), entry('private/notes.md', 'SECRET-READ-2'), entry('.env.local', 'SECRET-READ-3'),
    entry('sort.py', 'def sort_list(items): return sorted(items)'),
  ] }));
  const byDefault = await searchCollection(store, 'trier une liste', home, 5);
  assert.deepEqual(byDefault.map(r => r.file).sort(), ['private/notes.md', 'sort.py'], 'secret and protected files are hidden whatever the caller passes');
  const withPatterns = await searchCollection(store, 'trier une liste', home, 5, searchExclusion('private/'));
  assert.deepEqual(withPatterns.map(r => r.file), ['sort.py']);
});

test('re-indexing after a file is modified: the search finds the new content and the old one is gone from the store (parity row 30)', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const file = join(project, 'topic.py');
  await writeFile(file, 'def get_weather(city):\n    """Fetches the current weather forecast for a city."""\n    return call_weather_api(city)\n');
  await writeFile(join(project, 'other.py'), 'def add(a, b):\n    return a + b\n');
  const { indexFolder, searchCollection, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  await writeFile(file, 'def sort_list(items):\n    """Sorts a list of items in ascending order."""\n    return sorted(items)\n');
  await indexFolder(project, home);
  const raw = JSON.parse(await readFile(await storePath(project), 'utf8'));
  const stored = raw.entries.filter((e: any) => e.file === 'topic.py').map((e: any) => e.text).join('\n');
  assert.match(stored, /sort_list/);
  assert.equal(stored.includes('get_weather'), false, 'the old content left no chunk behind');
  const [best] = await searchCollection(await storePath(project), 'trier une liste', home, 5);
  assert.equal(best.file, 'topic.py');
  assert.match(best.content, /sort_list/);
});
```

In `electron/tests/search-tools.test.mts`, replace line 3:

```typescript
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
```

with:

```typescript
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
```

Append to `electron/tests/search-tools.test.mts`:

```typescript
test('semantic_search never renders a secret or ignored file, even from an index that still holds one', { timeout: 60000 }, async t => {
  const { home, folder } = await fixture(t);
  await writeFile(join(folder, 'sort.py'), 'def sort_list(items):\n    """Sorts a list of items in ascending order."""\n    return sorted(items)\n');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(folder, home);
  // What an index built before 2026-10-05 could hold, with sort.py's own vector: they would rank as high.
  const store = JSON.parse(await readFile(await storePath(folder), 'utf8'));
  const [first] = store.entries;
  store.entries.push(
    { ...first, id: 'secrets.json:0', file: 'secrets.json', text: 'SECRET-TOOL-1' },
    { ...first, id: 'private/notes.md:0', file: 'private/notes.md', text: 'SECRET-TOOL-2' },
  );
  await writeFile(await storePath(folder), JSON.stringify(store));

  const { searchTools } = await import('../core/search-tools.mts');
  const search = tool(await searchTools(folder, home, 'private/'), 'semantic_search');
  const output = await search.execute({ query: 'trier une liste' }, new AbortController().signal);
  assert.match(output, /\[sort\.py\]/);
  assert.equal(output.includes('SECRET-TOOL'), false, output);
  assert.equal(output.includes('secrets.json') || output.includes('private/'), false, output);
});
```

- [ ] **Step 3: Write the failing worker tests**

In `electron/tests/worker-index-status.test.mts`, replace line 5:

```typescript
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
```

with:

```typescript
import { mkdtemp, mkdir, writeFile, rm, access, readFile, readdir } from 'node:fs/promises';
```

Append to `electron/tests/worker-index-status.test.mts`:

```typescript
test("the automatic indexing applies the project's ignored patterns and the secret-file filter, and purges an older index of them", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-index-filter-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(join(project, 'private'), { recursive: true }), mkdir(join(project, '.openagent', 'index'), { recursive: true })]);
  await writeFile(join(project, 'a.py'), 'def a():\n    return 1\n');
  await writeFile(join(project, 'secrets.json'), '{"key": "SECRET-WORKER-1"}');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-WORKER-2');
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ ignored_patterns: 'private/' }));
  await writeFile(join(project, '.openagent', 'index', 'codebase.json'), JSON.stringify({ version: 1, entries: [
    { id: 'secrets.json:0', file: 'secrets.json', chunk: 0, text: 'SECRET-WORKER-1', vector: new Array(384).fill(0) },
  ] }));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'activate_folder', { folder: project });
  const status = await untilReady(worker, project);
  assert.equal(status.state, 'ready', JSON.stringify(status));

  const index = join(project, '.openagent', 'index');
  const raw = JSON.parse(await readFile(join(index, 'codebase.json'), 'utf8'));
  assert.deepEqual([...new Set(raw.entries.map((e: any) => e.file))], ['a.py']);
  assert.deepEqual(await readdir(index), ['codebase.json'], 'no backup copy of the old index is kept');
});
```

In `electron/tests/worker-search-tools.test.mts`, replace line 5:

```typescript
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
```

with:

```typescript
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
```

Append to `electron/tests/worker-search-tools.test.mts`:

```typescript
test("worker::semantic_search applies the project's ignored patterns and hides secret files, even from an index that still holds them", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-search-filter-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(join(project, 'sort.py'), 'def sort_list(items):\n    """Sorts a list of items in ascending order."""\n    return sorted(items)\n');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  // What an index built before 2026-10-05 could hold: a secret file and a file the project now ignores, each with
  // sort.py's own vector — they would rank first if they were not filtered. No activate_folder: nothing re-indexes.
  const store = JSON.parse(await readFile(await storePath(project), 'utf8'));
  const [first] = store.entries;
  store.entries.push(
    { ...first, id: 'secrets.json:0', file: 'secrets.json', text: 'SECRET-WORKER-SEARCH-1' },
    { ...first, id: 'private/notes.md:0', file: 'private/notes.md', text: 'SECRET-WORKER-SEARCH-2' },
  );
  await writeFile(await storePath(project), JSON.stringify(store));
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ ignored_patterns: 'private/' }));

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  const bodies: any[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(bodies.length === 1
        ? { choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'semantic_search', arguments: JSON.stringify({ query: 'trier une liste' }) } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'cherche comment trier', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  assert.equal(events.at(-1).kind, 'done', `expected done, got: ${events.map(e => e.kind).join(',')}`);
  const messages = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  const toolResult = messages.find((m: any) => m.role === 'tool');
  assert.match(toolResult.content, /\[sort\.py\]/);
  assert.equal(/SECRET-WORKER-SEARCH|secrets\.json|private\//.test(toolResult.content), false, toolResult.content);
  assert.equal(JSON.stringify(bodies[1]).includes('SECRET-WORKER-SEARCH'), false, 'nothing of them reached the model');
});
```

- [ ] **Step 4: Run them to verify they fail**

Run (from `electron/`): `node --experimental-strip-types --test tests/file-filter.test.mts tests/semantic-index.test.mts tests/search-tools.test.mts tests/worker-index-status.test.mts tests/worker-search-tools.test.mts`

Expected:
- `file-filter.test.mts`: FAIL, `Cannot find module` naming `core/file-filter.mts`.
- `semantic-index.test.mts`:
  - « indexFolder never indexes… »: FAIL on the first `deepEqual`, since the store lists `credentials.json`, `draft.md`, `private/notes.md`, `secrets.json` and `sort.py`;
  - « searchCollection never returns… »: FAIL with `Cannot find module` for `file-filter.mts`;
  - « re-indexing after a file is modified… »: **PASS**. It is a missing proof, not new behaviour.
- `search-tools.test.mts`: the new test FAILs, because the output contains `SECRET-TOOL`.
- `worker-index-status.test.mts`: the new test FAILs on `deepEqual`, because `secrets.json` and `private/notes.md` are indexed.
- `worker-search-tools.test.mts`: the new test FAILs, because the tool result contains `SECRET-WORKER-SEARCH`.

- [ ] **Step 5: Create `core/file-filter.mts`**

Create `electron/core/file-filter.mts`:

```typescript
import { posix } from 'node:path';

// The file tools' filter, shared (2026-10-05): the semantic index applies exactly what the file tools' searches apply,
// so a file the model cannot find with grep_codebase cannot reach it through semantic_search either. Moved here from
// core/workspace.mts unchanged — never copied.

/** Key material, by file name: never listed by a search (glob_files, grep_codebase) nor indexed. */
export const SENSITIVE_FILE = /^id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|key|p12|pfx)$|^(credentials|secrets)\.json$/i;

/**
 * A matcher for a project-relative path (either separator): true for `.env*`, `.git` and `.openagent` at any depth, and
 * for a match of the project's `ignored_patterns` (comma-separated globs; a pattern without « / » matches a name at any
 * depth, `dir/` covers everything under it). Every file tool refuses such a path.
 */
export function protectedPathMatcher(ignoredPatterns: string): (rel: string) => boolean {
  const ignored = ignoredPatterns.split(',').map(v => v.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  return (rel: string) => {
    const normalized = rel.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some(s => /^\.env(?:\.|$)/i.test(s) || ['.git', '.openagent'].includes(s.toLowerCase()))) return true;
    return ignored.some(pattern => posix.matchesGlob(normalized, pattern) || posix.matchesGlob(normalized, pattern + '/**') ||
      (!pattern.includes('/') && segments.some(s => posix.matchesGlob(s, pattern))));
  };
}

/** What a search never shows the model: a protected or ignored path, or key material by name. Applied by the
 * semantic index when it indexes and again when semantic_search reads (core/semantic-index.mts). */
export function searchExclusion(ignoredPatterns: string): (rel: string) => boolean {
  const blocked = protectedPathMatcher(ignoredPatterns);
  return (rel: string) => blocked(rel) || SENSITIVE_FILE.test(posix.basename(rel.replace(/\\/g, '/')));
}
```

- [ ] **Step 6: Make `core/workspace.mts` import it**

In `electron/core/workspace.mts`, replace line 6:

```typescript
import { metadataDirectory } from './json-store.mts';
```

with:

```typescript
import { metadataDirectory } from './json-store.mts';
import { protectedPathMatcher, SENSITIVE_FILE } from './file-filter.mts';
```

Replace lines 14-21:

```typescript
  const ignored = ignoredPatterns.split(',').map(v => v.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  const blocked = (rel: string) => {
    const normalized = rel.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some(s => /^\.env(?:\.|$)/i.test(s) || ['.git', '.openagent'].includes(s.toLowerCase()))) return true;
    return ignored.some(pattern => posix.matchesGlob(normalized, pattern) || posix.matchesGlob(normalized, pattern + '/**') ||
      (!pattern.includes('/') && segments.some(s => posix.matchesGlob(s, pattern))));
  };
```

with:

```typescript
  // .env*, .git, .openagent and the project's ignored_patterns — core/file-filter.mts, shared with the semantic index.
  const blocked = protectedPathMatcher(ignoredPatterns);
```

Delete the line (formerly 77) inside the search helpers:

```typescript
  const SENSITIVE_FILE = /^id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|key|p12|pfx)$|^(credentials|secrets)\.json$/i;
```

`posix` stays imported: `glob_files` still uses it.

- [ ] **Step 7: Rewrite `core/semantic-index.mts`**

Replace the whole content of `electron/core/semantic-index.mts` with:

```typescript
import { readdir, readFile as readFileFs, rm, stat as statFs } from 'node:fs/promises';
import { join, relative, sep, extname, isAbsolute } from 'node:path';
import { metadataDirectory, JsonStore } from './json-store.mts';
import { chunkText, cosineSimilarity } from './semantic-chunk.mts';
import { embed } from './embeddings.mts';
import { searchExclusion } from './file-filter.mts';

// Same set as the previous app's indexer.py (_EXCLUDED / _EXTENSIONS) — a full-repo semantic
// index, not the shallower stack-detection scan project-analyzer.mts does.
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', 'dist', 'build', '.openagent', '.venv', 'venv', '.mypy_cache']);
const INDEXED_EXTENSIONS = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.css', '.html', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.sql']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexEntry {
  id: string;
  file: string;
  chunk: number;
  text: string;
  vector: number[];
}
interface IndexFile {
  version: 1;
  entries: IndexEntry[];
}
export interface SearchResult {
  file: string;
  content: string;
  score: number;
}

/** `<project>/.openagent/index/codebase.json` — one JSON store per project, not a ChromaDB
 * collection: brute-force cosine search over a project's chunks is well within budget for
 * realistic codebase sizes, with none of ChromaDB's native/server packaging burden. Routed
 * through metadataDirectory, like every other file under .openagent/, so a project folder can
 * never redirect this write outside itself via a junction. */
export async function storePath(folder: string): Promise<string> {
  return join(await metadataDirectory(folder), 'index', 'codebase.json');
}

/** Every indexable file under `root`, in name order. A path `excluded` refuses (core/file-filter.mts: protected,
 * ignored by the project, key material by name) is skipped — a refused directory is not even entered. */
async function scanFiles(root: string, excluded: (rel: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string) {
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (excluded(relative(root, path).split(sep).join('/'))) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && INDEXED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files;
}

/**
 * Scans, chunks and embeds every matching file under `folder`, replacing the whole store with
 * the freshly computed result. Always a full rebuild (like indexer.py's own index_folder — no
 * incrementality either side of this port), but because the store is REPLACED wholesale rather
 * than upserted by id, a deleted or shrunk file can never leave stale vectors behind — the
 * previous app's own indexer.py never purged them (fixed here, not reproduced).
 *
 * `ignoredPatterns` is the project's ignored_patterns: what the file tools' searches hide is never indexed
 * (core/file-filter.mts), and the rebuild purges what an older index held of it. JsonStore keeps a one-time copy of
 * the first version of any file it rewrites (`.pre-electron.bak`); for this cache that copy would keep the first index
 * ever written — secret files included for an index built before 2026-10-05 — so it is removed after each write.
 */
export async function indexFolder(
  folder: string,
  home: string,
  onProgress?: (current: number, total: number, filepath: string) => void,
  ignoredPatterns = '',
): Promise<{ chunks: number }> {
  if (!isAbsolute(folder) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  const files = await scanFiles(folder, searchExclusion(ignoredPatterns));
  const entries: IndexEntry[] = [];
  for (let i = 0; i < files.length; i++) {
    const absolute = files[i];
    const relFile = relative(folder, absolute).split(sep).join('/');
    onProgress?.(i + 1, files.length, relFile);
    let content: string;
    try {
      const info = await statFs(absolute);
      if (info.size > MAX_FILE_BYTES) continue;
      content = await readFileFs(absolute, 'utf8');
    } catch {
      continue; // unreadable/binary file: skip, like indexer.py's per-file try/except
    }
    const chunks = chunkText(content);
    if (!chunks.length) continue;
    const vectors = await embed(chunks, home);
    chunks.forEach((text, chunkIndex) => {
      entries.push({ id: `${relFile}:${chunkIndex}`, file: relFile, chunk: chunkIndex, text, vector: vectors[chunkIndex] });
    });
  }
  const file = await storePath(folder);
  const store = new JsonStore();
  await store.update<IndexFile>(file, { version: 1, entries: [] }, () => ({ version: 1, entries }));
  await rm(`${file}.pre-electron.bak`, { force: true });
  return { chunks: entries.length };
}

/** Top-`n` chunks by cosine similarity to `query` — score = cosine similarity itself (this
 * app's cosineSimilarity already returns the `1 - distance` value indexer.py's search scored with).
 * A chunk of a file `excluded` refuses is never returned: an index written before the filter, or before a pattern was
 * added, may still hold one. By default secrets and protected paths are hidden even when no patterns are passed. */
export async function searchCollection(
  collectionPath: string,
  query: string,
  home: string,
  n = 5,
  excluded: (file: string) => boolean = searchExclusion(''),
): Promise<SearchResult[]> {
  if (n <= 0) return [];
  const store = new JsonStore();
  const data = await store.read<IndexFile>(collectionPath, { version: 1, entries: [] });
  const entries = data.entries.filter(entry => !excluded(entry.file));
  if (!entries.length) return [];
  const [queryVector] = await embed([query], home);
  return entries
    .map(entry => ({ file: entry.file, content: entry.text, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}
```

- [ ] **Step 8: Rewrite `core/search-tools.mts`**

Replace the whole content of `electron/core/search-tools.mts` with:

```typescript
import { isAbsolute } from 'node:path';
import type { AgentTool } from './agent.mts';
import { defineTool } from './tool-kit.mts';
import { searchCollection, storePath } from './semantic-index.mts';
import { searchKnowledge } from './knowledge-base.mts';
import { searchExclusion } from './file-filter.mts';

const N_RULE = { type: 'integer' as const, minimum: 1, maximum: 20, description: 'Nombre de résultats (défaut 5)' };
const QUERY_RULE = { type: 'string' as const, maxLength: 2000, description: 'Requête en langage naturel' };

/**
 * `semantic_search`/`knowledge_search` — same text contract as `index_tools.py`. Unlike Python,
 * where tools are registered once globally and must check `state.active_folder` themselves,
 * `registerTools` in this codebase already re-builds every tool for a specific, real, validated
 * `folder` on each turn (every other read tool here, e.g. gitTools, relies on the same
 * guarantee) — so there is no "no active folder" case to report here.
 *
 * `ignoredPatterns` is the project's ignored_patterns: semantic_search never renders a chunk of a file the file tools'
 * searches hide (core/file-filter.mts), even from an index built before that file was excluded.
 */
export async function searchTools(folder: string, home: string, ignoredPatterns = ''): Promise<AgentTool[]> {
  if (!isAbsolute(folder) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  const excluded = searchExclusion(ignoredPatterns);
  return [
    defineTool({
      name: 'semantic_search',
      description: 'Recherche sémantique dans le code du dossier actif pour des correspondances conceptuelles.',
      category: 'read',
      properties: { query: QUERY_RULE, n: N_RULE },
      required: ['query'],
      execute: async args => {
        const n = (args.n as number | undefined) ?? 5;
        let results;
        try {
          results = await searchCollection(await storePath(folder), args.query as string, home, n, excluded);
        } catch (error) {
          return `Index not ready: ${error instanceof Error ? error.message : 'Erreur interne'}. Index the project first.`;
        }
        if (!results.length) return 'No results found. The index may not be built yet.';
        return results.map(r => `[${r.file}] (score: ${r.score.toFixed(2)})\n${r.content}`).join('\n\n---\n\n');
      },
    }),
    defineTool({
      name: 'knowledge_search',
      description: 'Recherche dans les documents explicitement ajoutés à la base de connaissances personnelle.',
      category: 'read',
      properties: { query: QUERY_RULE, n: N_RULE },
      required: ['query'],
      execute: async args => {
        const n = (args.n as number | undefined) ?? 5;
        let results;
        try {
          results = await searchKnowledge(args.query as string, home, n);
        } catch (error) {
          return `Erreur base de connaissances : ${error instanceof Error ? error.message : 'Erreur interne'}`;
        }
        if (!results.length) return 'La base de connaissances est vide ou aucun résultat pertinent.';
        return results.map(r => `[Source: ${r.source}] (score: ${r.score.toFixed(2)})\n${r.content}`).join('\n\n---\n\n');
      },
    }),
  ];
}
```

- [ ] **Step 9: Wire the worker**

In `electron/worker.mjs`, replace the body of `triggerIndexing` (lines 74-85):

```javascript
async function triggerIndexing(folder) {
  const key = resolve(String(folder));
  if (indexStatus.get(key)?.state === 'indexing') return;
  postIndexEvent(folder, { state: 'indexing', current: 0, total: 0, message: undefined });
  try {
    await indexFolder(folder, dataHome, (current, total) => postIndexEvent(folder, { state: 'indexing', current, total }));
    postIndexEvent(folder, { state: 'ready', current: undefined, total: undefined, message: undefined });
  } catch (error) {
    postIndexEvent(folder, { state: 'error', current: undefined, total: undefined, message: error instanceof Error ? error.message : 'Erreur interne' });
  }
}
```

with:

```javascript
async function triggerIndexing(folder) {
  const key = resolve(String(folder));
  if (indexStatus.get(key)?.state === 'indexing') return;
  postIndexEvent(folder, { state: 'indexing', current: 0, total: 0, message: undefined });
  try {
    // The project's ignored_patterns — the value the file tools get (settings.effective keeps it as the project wrote
    // it): an ignored or secret file is never indexed, and the rebuild purges what an older index held of it. An
    // unreadable project config ends in 'error' with nothing written.
    const { ignored_patterns: ignoredPatterns } = await settings.project(folder);
    await indexFolder(folder, dataHome, (current, total) => postIndexEvent(folder, { state: 'indexing', current, total }), ignoredPatterns);
    postIndexEvent(folder, { state: 'ready', current: undefined, total: undefined, message: undefined });
  } catch (error) {
    postIndexEvent(folder, { state: 'error', current: undefined, total: undefined, message: error instanceof Error ? error.message : 'Erreur interne' });
  }
}
```

In `builtInTools` (line 200), replace:

```javascript
    ...await searchTools(folder, dataHome),
```

with:

```javascript
    ...await searchTools(folder, dataHome, effective.ignored_patterns),
```

- [ ] **Step 10: Run the Task 1 tests**

Run (from `electron/`): `node --experimental-strip-types --test tests/file-filter.test.mts tests/semantic-index.test.mts tests/search-tools.test.mts tests/worker-index-status.test.mts tests/worker-search-tools.test.mts tests/workspace.test.mts tests/workspace-search.test.mts`
Expected: all PASS. `workspace.test.mts` and `workspace-search.test.mts` prove the moved filter behaves as before.

- [ ] **Step 11: Type-check**

Run (from `electron/`): `npx tsc --noEmit -p tsconfig.core.json`
Expected: the 5 pre-existing errors only.

- [ ] **Step 12: Run `index-status-visual` once**

Run (from `electron/`): `npm run renderer:build`, then `npm run test:indexstatus`. Run it **once**.
Expected: `PASS index status: …`. On failure, report the output and stop.

- [ ] **Step 13: Commit and push**

From the repository root:

```bash
git add electron/core/file-filter.mts electron/core/workspace.mts electron/core/semantic-index.mts electron/core/search-tools.mts electron/worker.mjs electron/tests/file-filter.test.mts electron/tests/semantic-index.test.mts electron/tests/search-tools.test.mts electron/tests/worker-index-status.test.mts electron/tests/worker-search-tools.test.mts electron/tests/all.mts
git commit -m "fix: the semantic index never sees secret or ignored files — the file tools' filter moves to core/file-filter.mts and is shared, indexing applies the project's ignored_patterns and purges older chunks (backup copy included), semantic_search filters at read; row 30 modify-then-search proven" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 2: Tool cards keep name, badge and detail; `edit_file` shows a diff (row 6, without window)

**Files:**
- Create: `electron/core/unified-diff.mts`
- Create: `electron/tests/unified-diff.test.mts`
- Create: `electron/renderer-src/src/state/tool-cards.ts`
- Create: `electron/tests/tool-cards.test.mts`
- Modify: `electron/core/workspace.mts` (imports; `edit_file`'s `return`, line 194)
- Modify: `electron/core/provider.mts:7-16` (`ChatMessage`)
- Modify: `electron/core/agent.mts:116-150` (tool-call loop)
- Modify: `electron/core/request-context.mts:43-58`
- Modify: `electron/renderer-src/src/state/reducer.ts:1-15,91-93,100-124,174-212`
- Rewrite: `electron/renderer-src/src/components/ToolMessage.tsx`
- Modify: `electron/renderer-src/src/components/ChatView.tsx:85-92` (the two `ToolMessage` uses)
- Modify: `electron/tests/workspace.test.mts`, `agent.test.mts`, `request-context.test.mts`, `worker-tools.test.mts` (1 test each, appended)
- Modify: `electron/tests/all.mts` (register `unified-diff.test.mts`, `tool-cards.test.mts`)

**Interfaces:**
- Produces (`core/unified-diff.mts`):
  - `DIFF_MAX_LINES = 60`, `DIFF_MAX_CHARS = 4000`, `DIFF_TRUNCATED = '[diff tronqué]'`
  - `unifiedDiff(path: string, before: string, after: string): string`: `''` when the lines are the same
  - `boundedDiff(diff: string): string`
- Produces (`core/provider.mts`): `ChatMessage.name?: string`, `ChatMessage.category?: string`
- Produces (`renderer-src/src/state/tool-cards.ts`):
  - `TOOL_DETAIL_MAX = 120`
  - `interface ToolCallInfo { name: string; arguments: string }`
  - `type RenderedMessage = ChatMessage & { _tool?: string; _category?: string; _detail?: string }`
  - `toolDetail(tool: string | undefined, rawArguments: string | undefined): string | undefined`
  - `callsById(messages: readonly ChatMessage[]): Map<string, ToolCallInfo>`
  - `toolCard(message: ChatMessage, calls: ReadonlyMap<string, ToolCallInfo>, live?: { tool: string; category?: string }): RenderedMessage`
  - `withToolCards(messages: readonly ChatMessage[]): RenderedMessage[]`
- Produces (`reducer.ts`): `ToolMeta.detail?: string`; `RenderedMessage` re-exported.
- Produces (`ToolMessage.tsx`):
  - props `{ tool?, category?, detail?, content, pending? }`;
  - DOM: `[data-testid="oa-tool-badge"][data-badge="<category>|neutral"]`, `[data-testid="oa-tool-name"]`, `[data-testid="oa-tool-detail"]`.
  - Task 4 asserts these.

- [ ] **Step 1: Write the failing diff tests**

Create `electron/tests/unified-diff.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { unifiedDiff, boundedDiff, DIFF_MAX_LINES, DIFF_MAX_CHARS, DIFF_TRUNCATED } = await import('../core/unified-diff.mts');

test('one changed line: headers, one hunk, three lines of context each side', () => {
  const before = ['l1', 'l2', 'l3', 'l4', 'five', 'l6', 'l7', 'l8', 'l9'].join('\n') + '\n';
  const after = before.replace('five', 'FIVE');
  assert.equal(unifiedDiff('src/a.txt', before, after), [
    '--- a/src/a.txt', '+++ b/src/a.txt', '@@ -2,7 +2,7 @@', ' l2', ' l3', ' l4', '-five', '+FIVE', ' l6', ' l7', ' l8',
  ].join('\n'));
});

test('a multi-line replacement prefixes every removed and added line, and a CRLF file diffs by line', () => {
  assert.equal(unifiedDiff('f.txt', 'a\r\nb\r\nc\r\n', 'a\r\nX\r\nY\r\nZ\r\nc\r\n'), [
    '--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,5 @@', ' a', '-b', '+X', '+Y', '+Z', ' c',
  ].join('\n'));
});

test('identical texts give no diff, and a change on the first or last line has context on one side only', () => {
  assert.equal(unifiedDiff('f', 'same\n', 'same\n'), '');
  const text = 'a\nb\nc\nd\ne';
  assert.equal(unifiedDiff('f', text, text.replace('a', 'A')), ['--- a/f', '+++ b/f', '@@ -1,4 +1,4 @@', '-a', '+A', ' b', ' c', ' d'].join('\n'));
  assert.equal(unifiedDiff('f', text, text.replace('e', 'E')), ['--- a/f', '+++ b/f', '@@ -2,4 +2,4 @@', ' b', ' c', ' d', '-e', '+E'].join('\n'));
});

test('boundedDiff keeps a diff of up to 60 lines and 4 000 characters whole, and cuts a longer one to those bounds, « [diff tronqué] » included', () => {
  assert.equal(DIFF_MAX_LINES, 60);
  assert.equal(DIFF_MAX_CHARS, 4000);
  assert.equal(DIFF_TRUNCATED, '[diff tronqué]');
  const sixty = Array.from({ length: 60 }, (_, i) => `+${i}`).join('\n');
  assert.equal(boundedDiff(sixty), sixty, 'exactly at the bound: whole');
  const many = Array.from({ length: 200 }, (_, i) => `+ligne ${i}`).join('\n');
  const byLines = boundedDiff(many).split('\n');
  assert.equal(byLines.length, 60);
  assert.equal(byLines[58], '+ligne 58');
  assert.equal(byLines[59], '[diff tronqué]');
  const wide = Array.from({ length: 10 }, () => '+' + 'x'.repeat(999)).join('\n');
  const byChars = boundedDiff(wide);
  assert.equal(byChars.length, 4000);
  assert.ok(byChars.endsWith('\n[diff tronqué]'));
});
```

Append to `electron/tests/all.mts`:

```typescript
import './unified-diff.test.mts';
```

- [ ] **Step 2: Write the failing `edit_file`, agent and request tests**

Append to `electron/tests/workspace.test.mts`:

```typescript
test('edit_file answers its success line then a unified diff of the change, bounded with « [diff tronqué] »', async t => {
  const { a, invoke } = await fixture(t);
  await invoke('create_file', { path: 'src/app.txt', content: 'un\ndeux\ntrois\n' });
  const out = await invoke('edit_file', { path: 'src/app.txt', old_string: 'deux', new_string: 'DEUX\nDEUX-BIS' });
  assert.equal(out, [
    `Modifié : ${join('src', 'app.txt')}`, '--- a/src/app.txt', '+++ b/src/app.txt', '@@ -1,3 +1,4 @@', ' un', '-deux', '+DEUX', '+DEUX-BIS', ' trois',
  ].join('\n'));

  await invoke('create_file', { path: 'big.txt', content: 'DEBUT\nFIN\n' });
  const big = Array.from({ length: 100 }, (_, i) => `ligne ${i}`).join('\n');
  const lines = (await invoke('edit_file', { path: 'big.txt', old_string: 'DEBUT', new_string: big })).split('\n');
  assert.equal(lines[0], 'Modifié : big.txt');
  assert.equal(lines.at(-1), '[diff tronqué]');
  assert.equal(lines.length - 1, 60, 'the diff part, marker included, is 60 lines');
  assert.equal(await readFile(join(a, 'big.txt'), 'utf8'), big + '\nFIN\n', 'the whole edit is written: only the shown diff is cut');
});
```

Append to `electron/tests/agent.test.mts`:

```typescript
test('a tool result is saved with its tool name and category, and neither field is ever sent to the provider', async () => {
  const { runAgent } = await import('../core/agent.mts');
  const { ChatProvider } = await import('../core/provider.mts');
  const requests: any[] = [];
  const provider = new ChatProvider(async (_url: any, options: any) => {
    requests.push(JSON.parse(options.body));
    const calls = [
      { id: 'k', type: 'function', function: { name: 'look', arguments: '{}' } },
      { id: 'u', type: 'function', function: { name: 'ghost', arguments: '{}' } },
    ];
    return new Response(JSON.stringify({ choices: [{ message: requests.length === 1 ? { content: '', tool_calls: calls } : { content: 'fin' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await runAgent({ provider, connection, instructions: '', messages: [{ role: 'user', content: 'go' }],
    settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true,
    tools: [{ name: 'look', description: '', category: 'read', parameters: { type: 'object' }, validate: () => {}, execute: async () => 'vu' }],
  });
  const saved = result.filter(m => m.role === 'tool');
  assert.deepEqual(saved.map(m => [m.tool_call_id, m.name, m.category, m.content]), [
    ['k', 'look', 'read', 'vu'],
    ['u', 'ghost', undefined, 'Erreur : Outil inconnu : exécution refusée'],
  ]);
  assert.equal('category' in saved[1], false, 'an unknown tool has no category, never a guessed one');
  const sent = requests[1].messages.filter((m: any) => m.role === 'tool');
  assert.equal(sent.length, 2);
  for (const message of sent) assert.deepEqual(Object.keys(message).sort(), ['content', 'role', 'tool_call_id']);
});
```

Append to `electron/tests/request-context.test.mts`:

```typescript
test('a tool result goes out as role, tool_call_id and content only: its saved name and category stay on disk', () => {
  const stored: any[] = [
    { role: 'user', content: 'avant' },
    callMessage('c0', 'read_file', '{"path":"x"}'),
    { ...result('c0', 'ancien'), name: 'read_file', category: 'read' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'go' },
    callMessage('c1', 'read_file', '{"path":"a"}'),
    { ...result('c1', 'lu'), name: 'read_file', category: 'read' },
  ];
  const before = structuredClone(stored);
  const sent = requestMessages(stored);
  assert.deepEqual(sent.at(-1), result('c1', 'lu'));
  assert.equal(sent.some(message => 'category' in message || (message.role === 'tool' && 'name' in message)), false);
  assert.deepEqual(stored, before, 'the saved messages are untouched');
});
```

Append to `electron/tests/worker-tools.test.mts`:

```typescript
// ── row 6: a saved tool result keeps its card (2026-10-05) ──────────────────────────
test('a saved tool result keeps its tool name and category, and the next request sends neither', async t => {
  const { worker, project, bodies, send } = await setup(t, [{ tool: { name: 'list_dir', args: { path: '.' } } }, { text: 'vu' }]);
  const r = await send(worker);
  await until(() => finished(r.events), 'the run');
  r.stop();
  const live = r.events.find(e => e.kind === 'message' && e.message.role === 'tool').message;
  assert.equal(live.name, 'list_dir');
  assert.equal(live.category, 'read');
  const saved = (await callWorker(worker, 'messages', { folder: project, branchId: 'main' })).find((m: any) => m.role === 'tool');
  assert.equal(saved.name, 'list_dir');
  assert.equal(saved.category, 'read');
  const sent = bodies[1].messages.filter((m: any) => m.role === 'tool');
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['content', 'role', 'tool_call_id']);
});
```

- [ ] **Step 3: Write the failing card tests**

Create `electron/tests/tool-cards.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DETAIL_MAX, toolDetail, withToolCards } from '../renderer-src/src/state/tool-cards.ts';
import { chatReducer, initialChatState, type ChatState } from '../renderer-src/src/state/reducer.ts';

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const json = (value: Record<string, unknown>) => JSON.stringify(value);
const agentEvent = (body: Record<string, unknown>) => ({ type: 'agent-event' as const, event: { type: 'event', event: 'agent', runId: 'r1', ...body } as never });

test('toolDetail: path for the file tools, command for run_command, query or url for search and the web, nothing for the others; cut to 120 characters', () => {
  assert.equal(TOOL_DETAIL_MAX, 120);
  for (const tool of ['read_file', 'view_file', 'list_dir', 'create_file', 'edit_file', 'create_dir', 'delete_file', 'delete_dir', 'grep_file', 'glob_files', 'grep_codebase']) {
    assert.equal(toolDetail(tool, json({ path: 'src/app.ts', pattern: '*.ts' })), 'src/app.ts', tool);
  }
  assert.equal(toolDetail('run_command', json({ command: 'npm test', timeout: 5 })), 'npm test');
  for (const tool of ['internet_search', 'semantic_search', 'knowledge_search']) assert.equal(toolDetail(tool, json({ query: 'tri rapide' })), 'tri rapide', tool);
  assert.equal(toolDetail('fetch_url', json({ url: 'https://example.com/page' })), 'https://example.com/page');
  assert.equal(toolDetail('git_blame', json({ file: 'a.ts', path: 'a.ts' })), undefined, 'not a file, shell, search or web tool');
  assert.equal(toolDetail('save_memory', json({ query: 'x' })), undefined);
  assert.equal(toolDetail('glob_files', json({ pattern: '*.ts' })), undefined, 'no path given: no detail');
  assert.equal(toolDetail('read_file', 'pas du JSON'), undefined);
  assert.equal(toolDetail('read_file', json({ path: '   ' })), undefined);
  assert.equal(toolDetail(undefined, json({ path: 'a' })), undefined);
  const long = 'x'.repeat(300);
  assert.equal(toolDetail('run_command', json({ command: long })), long.slice(0, 120));
});

test('withToolCards: a saved result shows its saved name and category; an older one gets its name from the preceding call and no category (neutral badge); both get their detail', () => {
  const messages: any[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'create_file', { path: 'notes.md', content: 'x' }), call('c2', 'read_file', { path: 'old.txt' })] },
    { role: 'tool', tool_call_id: 'c1', name: 'create_file', category: 'write', content: 'Créé : notes.md' },
    { role: 'tool', tool_call_id: 'c2', content: 'ancien contenu' },
    { role: 'tool', tool_call_id: 'nowhere', content: 'orphelin' },
    { role: 'assistant', content: 'fin' },
  ];
  const cards = withToolCards(messages);
  assert.equal(cards[0], messages[0], 'a message that is not a tool result is passed through as is');
  assert.equal(cards[1], messages[1]);
  assert.equal(cards[5], messages[5]);
  assert.deepEqual(cards[2], { ...messages[2], _tool: 'create_file', _category: 'write', _detail: 'notes.md' });
  assert.deepEqual(cards[3], { ...messages[3], _tool: 'read_file', _detail: 'old.txt' }, 'name recovered from the call, no category');
  assert.deepEqual(cards[4], { ...messages[4] }, 'a result whose call is unknown gets nothing invented');
});

test('the reducer builds the cards on every load and live: folder, branch switch and creation, compaction, tool-start and the result', () => {
  const history: any[] = [
    { role: 'user', content: 'liste' },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'list_dir', { path: 'src' })] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.ts' },
  ];
  const expected = { _tool: 'list_dir', _detail: 'src' };
  const pick = (state: ChatState) => ({ _tool: state.messages[2]._tool, _detail: state.messages[2]._detail });
  const loaded = chatReducer(initialChatState, { type: 'folder-loaded', messages: history });
  assert.deepEqual(pick(loaded), expected, 'folder-loaded');
  assert.deepEqual(pick(chatReducer(loaded, { type: 'branch-switched', id: 'b', messages: history })), expected, 'branch-switched');
  assert.deepEqual(pick(chatReducer(loaded, { type: 'branch-created', id: 'b', label: 'Branche 1', branches: [], messages: history })), expected, 'branch-created');
  const compacting: ChatState = { ...loaded, compacting: true, compactionId: 'k1' };
  const compacted = chatReducer(compacting, { type: 'agent-event', event: { type: 'event', event: 'agent', runId: 'k1', kind: 'compacted', messages: history } as never });
  assert.deepEqual(pick(compacted), expected, 'compacted');

  let live = chatReducer(loaded, { type: 'send-started', runId: 'r1', text: 'teste' });
  live = chatReducer(live, agentEvent({ kind: 'message', message: { role: 'assistant', content: '', tool_calls: [call('c9', 'run_command', { command: 'npm test' })] } }));
  live = chatReducer(live, agentEvent({ kind: 'tool-start', id: 'c9', tool: 'run_command', category: 'shell' }));
  assert.deepEqual(live.liveToolStarts.c9, { tool: 'run_command', category: 'shell', detail: 'npm test' }, 'the pending card already shows its detail');
  live = chatReducer(live, agentEvent({ kind: 'message', message: { role: 'tool', tool_call_id: 'c9', name: 'run_command', category: 'shell', content: 'ok' } }));
  const card = live.messages.at(-1)!;
  assert.deepEqual([card._tool, card._category, card._detail], ['run_command', 'shell', 'npm test']);
  assert.deepEqual(live.liveToolStarts, {});
});
```

Append to `electron/tests/all.mts`:

```typescript
import './tool-cards.test.mts';
```

- [ ] **Step 4: Run them to verify they fail**

Run (from `electron/`): `node --experimental-strip-types --test tests/unified-diff.test.mts tests/tool-cards.test.mts tests/workspace.test.mts tests/agent.test.mts tests/request-context.test.mts tests/worker-tools.test.mts`

Expected:
- `unified-diff.test.mts`: FAIL, `Cannot find module` naming `core/unified-diff.mts`.
- `tool-cards.test.mts`: FAIL, `Cannot find module` naming `state/tool-cards.ts`.
- `workspace.test.mts`: the new test FAILs. The output is `Modifié : src\app.txt\n-deux\n+DEUX\nDEUX-BIS` (on Windows).
- `agent.test.mts`: the new test FAILs, since `name` is `undefined`.
- `request-context.test.mts`: the new test FAILs on `deepEqual`, since `name` and `category` are present.
- `worker-tools.test.mts`: the new test FAILs, since `live.name` is `undefined`.

- [ ] **Step 5: Create `core/unified-diff.mts`**

Create `electron/core/unified-diff.mts`:

```typescript
// The diff edit_file returns (parity row 6, 2026-10-05). An edit replaces ONE occurrence, so the two texts differ in a
// single region: the common leading and trailing lines are context, everything between is the change. No LCS and no
// dependency — none of the app's dependencies ships a diff.

export const DIFF_MAX_LINES = 60;
export const DIFF_MAX_CHARS = 4000;
export const DIFF_TRUNCATED = '[diff tronqué]';
const CONTEXT_LINES = 3;

/** Lines of a text, without the empty element a final newline adds (as read_file counts them); CRLF or LF. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** One side of a hunk header, 1-based; an empty side names the line before it, as `diff -u` does. */
function range(start: number, count: number): string {
  return count === 0 ? `${start},0` : `${start + 1},${count}`;
}

/** The unified diff turning `before` into `after` for `path` (`--- a/` and `+++ b/` headers, one hunk, up to three
 * lines of context on each side). Empty when the two texts have the same lines. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const old = linesOf(before);
  const next = linesOf(after);
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const removed = old.slice(head, old.length - tail);
  const added = next.slice(head, next.length - tail);
  if (!removed.length && !added.length) return '';
  const lead = Math.min(CONTEXT_LINES, head);
  const trail = Math.min(CONTEXT_LINES, tail);
  const start = head - lead;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${range(start, lead + removed.length + trail)} +${range(start, lead + added.length + trail)} @@`,
    ...old.slice(start, head).map(line => ` ${line}`),
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    ...old.slice(old.length - tail, old.length - tail + trail).map(line => ` ${line}`),
  ].join('\n');
}

/** `diff` whole when it fits in DIFF_MAX_LINES lines and DIFF_MAX_CHARS characters; otherwise cut so that the result,
 * DIFF_TRUNCATED on its own last line included, still fits in both. */
export function boundedDiff(diff: string): string {
  const lines = diff.split('\n');
  if (lines.length <= DIFF_MAX_LINES && diff.length <= DIFF_MAX_CHARS) return diff;
  const room = DIFF_MAX_CHARS - DIFF_TRUNCATED.length - 1;
  return `${lines.slice(0, DIFF_MAX_LINES - 1).join('\n').slice(0, room)}\n${DIFF_TRUNCATED}`;
}
```

- [ ] **Step 6: Make `edit_file` return the diff**

In `electron/core/workspace.mts`, after the `file-filter.mts` import added in Task 1, add:

```typescript
import { boundedDiff, unifiedDiff } from './unified-diff.mts';
```

In `edit_file`, replace:

```typescript
      return `Modifié : ${relative(root, file)}\n-${old}\n+${args.new_string}`;
```

with:

```typescript
      // The change as a bounded unified diff (core/unified-diff.mts): coloured on the tool card, read by the model too.
      const shown = relative(root, file);
      const diff = boundedDiff(unifiedDiff(shown.split(sep).join('/'), text, next));
      return diff ? `Modifié : ${shown}\n${diff}` : `Modifié : ${shown}`;
```

- [ ] **Step 7: Save `name` and `category`, never send them**

In `electron/core/provider.mts`, replace lines 7-16:

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | unknown[] | null;
  tool_call_id?: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[];
  // A user message's files, kept beside what was typed (see attachments.mts). Never sent as such: they are
  // expanded into `content` (toWireMessage) just before the provider is called.
  attachments?: unknown[];
  // Set on a reply the output limit cut (finish_reason "length"). agent.mts turns it into a visible notice;
  // the flag itself is never stored nor sent back to a provider.
  truncated?: boolean;
}
```

with:

```typescript
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; content: string | unknown[] | null;
  tool_call_id?: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[];
  // A user message's files, kept beside what was typed (see attachments.mts). Never sent as such: they are
  // expanded into `content` (toWireMessage) just before the provider is called.
  attachments?: unknown[];
  // Set on a reply the output limit cut (finish_reason "length"). agent.mts turns it into a visible notice;
  // the flag itself is never stored nor sent back to a provider.
  truncated?: boolean;
  // A tool result's tool name and category (agent.mts), saved so a reopened conversation shows the same card. Never
  // sent: request-context.mts sends a tool result as role, tool_call_id and content only.
  name?: string; category?: string;
}
```

In `electron/core/agent.mts`, replace lines 116-150:

```typescript
    for (const call of reply.tool_calls) {
      signal.throwIfAborted();
      let output: string;
      try {
        // A call cut by the output limit has incomplete arguments: never executed, whatever the permissions.
        if (truncated) throw new Error(TRUNCATED_ARGUMENTS);
        const tool = registry.get(call.function.name);
        if (!tool) throw new Error('Outil inconnu : exécution refusée');
```

with:

```typescript
    for (const call of reply.tool_calls) {
      signal.throwIfAborted();
      const tool = registry.get(call.function.name);
      let output: string;
      try {
        // A call cut by the output limit has incomplete arguments: never executed, whatever the permissions.
        if (truncated) throw new Error(TRUNCATED_ARGUMENTS);
        if (!tool) throw new Error('Outil inconnu : exécution refusée');
```

and, further down in the same loop, replace:

```typescript
      if (output.length > 50000) output = output.slice(0, 50000) + '\n[Sortie tronquée]';
      const result: ChatMessage = { role: 'tool', tool_call_id: call.id, content: output };
```

with:

```typescript
      if (output.length > 50000) output = output.slice(0, 50000) + '\n[Sortie tronquée]';
      // The tool's name and category ride with its result (parity row 6): a reopened conversation shows the same card.
      // An unknown tool gets no category, never a guessed one. requestMessages never sends either field.
      const result: ChatMessage = { role: 'tool', tool_call_id: call.id, name: call.function.name, ...(tool ? { category: tool.category } : {}), content: output };
```

In `electron/core/request-context.mts`, replace lines 43-58 (the `requestMessages` doc comment and function):

```typescript
/**
 * The messages to send (system message excluded). Earlier turns — before the last user message — keep only
 * the user messages and the TEXT of the assistant ones (tool calls, tool results and text-less assistant
 * messages are dropped, as Python sent them); the turn in progress is sent whole, its attachments expanded and
 * unreadable call arguments replaced by `{}` (in the request only: the saved transcript keeps them).
 */
export function requestMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const start = Math.max(0, currentTurnStart(messages));
  const earlier: ChatMessage[] = [];
  for (const message of messages.slice(0, start)) {
    if (isUser(message)) earlier.push({ role: 'user', content: withPlaceholders(message) });
    else if (isAssistant(message) && textOf(message.content).trim()) earlier.push({ role: 'assistant', content: textOf(message.content) });
  }
  const current = messages.slice(start).map(message => withSendableArguments(toWireMessage(message as never) as unknown as ChatMessage));
  return [...earlier, ...current];
}
```

with:

```typescript
/** A tool result as the provider receives it: role, tool_call_id and content — the OpenAI format's fields. The `name`
 * and `category` saved beside it for the screen (agent.mts) never leave. */
function wireToolResult(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool') return message;
  return { role: 'tool', ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }), content: message.content };
}

/**
 * The messages to send (system message excluded). Earlier turns — before the last user message — keep only
 * the user messages and the TEXT of the assistant ones (tool calls, tool results and text-less assistant
 * messages are dropped, as Python sent them); the turn in progress is sent whole, its attachments expanded,
 * unreadable call arguments replaced by `{}` and its tool results reduced to the OpenAI fields (in the request
 * only: the saved transcript keeps everything).
 */
export function requestMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const start = Math.max(0, currentTurnStart(messages));
  const earlier: ChatMessage[] = [];
  for (const message of messages.slice(0, start)) {
    if (isUser(message)) earlier.push({ role: 'user', content: withPlaceholders(message) });
    else if (isAssistant(message) && textOf(message.content).trim()) earlier.push({ role: 'assistant', content: textOf(message.content) });
  }
  const current = messages.slice(start).map(message => wireToolResult(withSendableArguments(toWireMessage(message as never) as unknown as ChatMessage)));
  return [...earlier, ...current];
}
```

- [ ] **Step 8: Create the card module**

Create `electron/renderer-src/src/state/tool-cards.ts`:

```typescript
import type { ChatMessage } from '../ipc/types';

// Tool cards (parity row 6, 2026-10-05): the name, badge and detail a tool result shows, the same whether the turn is
// live or the conversation was reopened. The agent loop saves each result with the tool's `name` and `category`
// (core/agent.mts). A conversation saved before that has neither: the name is read from the assistant's tool call that
// precedes the result, the category stays unknown (the card shows a neutral badge).

export const TOOL_DETAIL_MAX = 120;

// The argument a card shows beside the tool name: the path for the file tools, the command for run_command, the query
// or the URL for search and the web. Every other tool shows none.
const DETAIL_ARGUMENT: Readonly<Record<string, string>> = {
  read_file: 'path', view_file: 'path', list_dir: 'path', create_file: 'path', edit_file: 'path', create_dir: 'path',
  delete_file: 'path', delete_dir: 'path', grep_file: 'path', glob_files: 'path', grep_codebase: 'path',
  run_command: 'command',
  internet_search: 'query', semantic_search: 'query', knowledge_search: 'query',
  fetch_url: 'url',
};

export interface ToolCallInfo { name: string; arguments: string }

/** A message as the chat shows it: on a tool result, `_tool`, `_category` and `_detail` are set only when known. */
export type RenderedMessage = ChatMessage & { _tool?: string; _category?: string; _detail?: string };

/** The detail of a call to `tool` with these raw (JSON) arguments, cut to TOOL_DETAIL_MAX characters; undefined when
 * the tool shows none, or the argument is missing, empty or unreadable. */
export function toolDetail(tool: string | undefined, rawArguments: string | undefined): string | undefined {
  const field = tool === undefined ? undefined : DETAIL_ARGUMENT[tool];
  if (!field || rawArguments === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(rawArguments); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.slice(0, TOOL_DETAIL_MAX);
}

function toolCallsOf(message: ChatMessage): Array<[string, ToolCallInfo]> {
  if (!Array.isArray(message.tool_calls)) return [];
  const found: Array<[string, ToolCallInfo]> = [];
  for (const raw of message.tool_calls as unknown[]) {
    const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    if (!call || typeof call.id !== 'string' || typeof call.function?.name !== 'string') continue;
    found.push([call.id, { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '' }]);
  }
  return found;
}

/** Every tool call of `messages`, by id. */
export function callsById(messages: readonly ChatMessage[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const message of messages) for (const [id, call] of toolCallsOf(message)) calls.set(id, call);
  return calls;
}

/** `message` with its card: the name and category it was saved with, else those of the live tool-start, else the
 * name of its call; the detail from its call's arguments. Anything but a tool result is returned as is. */
export function toolCard(message: ChatMessage, calls: ReadonlyMap<string, ToolCallInfo>, live?: { tool: string; category?: string }): RenderedMessage {
  if (message.role !== 'tool') return message;
  const call = typeof message.tool_call_id === 'string' ? calls.get(message.tool_call_id) : undefined;
  const tool = (typeof message.name === 'string' && message.name) || live?.tool || call?.name;
  const category = (typeof message.category === 'string' && message.category) || live?.category;
  const detail = toolDetail(call?.name ?? tool, call?.arguments);
  return { ...message, ...(tool ? { _tool: tool } : {}), ...(category ? { _category: category } : {}), ...(detail ? { _detail: detail } : {}) };
}

/** A conversation as loaded (folder, branch, compaction): each tool result with its card, from the calls before it. */
export function withToolCards(messages: readonly ChatMessage[]): RenderedMessage[] {
  const calls = new Map<string, ToolCallInfo>();
  return messages.map(message => {
    for (const [id, call] of toolCallsOf(message)) calls.set(id, call);
    return toolCard(message, calls);
  });
}
```

- [ ] **Step 9: Build the cards in the reducer**

In `electron/renderer-src/src/state/reducer.ts`, replace lines 1-15:

```typescript
import type { AgentEvent, Attachment, BranchInfo, ChatMessage } from '../ipc/bridge';
// Explicit `.ts`: the unit tests load this file with Node itself (type stripping), which does not resolve
// extension-less imports the way Vite does.
import { extractArtifact, type Artifact } from './artifacts.ts';
import { lastAssistantIndex } from './editing.ts';

export interface ToolMeta {
  tool: string;
  category?: string;
}

// A tool-role message enriched with the tool name/category correlated from the
// tool-start event that preceded it (by tool_call_id) — the raw message alone only
// carries tool_call_id + content, not which tool produced it.
export type RenderedMessage = ChatMessage & { _tool?: string; _category?: string };
```

with:

```typescript
import type { AgentEvent, Attachment, BranchInfo, ChatMessage } from '../ipc/bridge';
// Explicit `.ts`: the unit tests load this file with Node itself (type stripping), which does not resolve
// extension-less imports the way Vite does.
import { extractArtifact, type Artifact } from './artifacts.ts';
import { lastAssistantIndex } from './editing.ts';
import { callsById, toolCard, toolDetail, withToolCards, type RenderedMessage } from './tool-cards.ts';

// A message as shown, tool results with their card (name, category, detail): see tool-cards.ts.
export type { RenderedMessage } from './tool-cards.ts';

export interface ToolMeta {
  tool: string;
  category?: string;
  // The call's detail (path, command, query, url), read from the assistant message that made the call.
  detail?: string;
}
```

Replace the `folder-loaded` case:

```typescript
    case 'folder-loaded':
      // A new folder always opens on main: its fork list arrives separately ('branches-loaded').
      return { ...initialChatState, messages: action.messages };
```

with:

```typescript
    case 'folder-loaded':
      // A new folder always opens on main: its fork list arrives separately ('branches-loaded').
      return { ...initialChatState, messages: withToolCards(action.messages) };
```

In the `branch-created` case, replace `messages: action.messages,` with `messages: withToolCards(action.messages),`. Do the same in the `branch-switched` case.

In the `agent-event` case, replace:

```typescript
        return { ...state, compacting: false, compactionId: null, messages: event.messages, error: null, notice: 'Contexte compressé avec résumé IA.' };
```

with:

```typescript
        return { ...state, compacting: false, compactionId: null, messages: withToolCards(event.messages), error: null, notice: 'Contexte compressé avec résumé IA.' };
```

Replace the `tool-start` and the tool branch of `message`:

```typescript
        case 'tool-start':
          return {
            ...state,
            liveToolStarts: { ...state.liveToolStarts, [event.id]: { tool: event.tool, category: event.category } },
          };
        case 'message': {
          const message = event.message;
          if (message.role === 'tool' && message.tool_call_id) {
            const meta = state.liveToolStarts[message.tool_call_id];
            const { [message.tool_call_id]: _removed, ...remaining } = state.liveToolStarts;
            return {
              ...state,
              messages: [...state.messages, { ...message, _tool: meta?.tool, _category: meta?.category }],
              liveToolStarts: remaining,
            };
          }
```

with:

```typescript
        case 'tool-start': {
          // tool-start carries no arguments: the detail comes from the assistant message that made the call.
          const detail = toolDetail(event.tool, callsById(state.messages).get(event.id)?.arguments);
          return {
            ...state,
            liveToolStarts: { ...state.liveToolStarts, [event.id]: { tool: event.tool, category: event.category, ...(detail ? { detail } : {}) } },
          };
        }
        case 'message': {
          const message = event.message;
          if (message.role === 'tool' && message.tool_call_id) {
            const meta = state.liveToolStarts[message.tool_call_id];
            const { [message.tool_call_id]: _removed, ...remaining } = state.liveToolStarts;
            return {
              ...state,
              // The name and category the agent loop saved with it, else its tool-start's (a Stop closing result).
              messages: [...state.messages, toolCard(message, callsById(state.messages), meta)],
              liveToolStarts: remaining,
            };
          }
```

- [ ] **Step 10: Show the detail and the neutral badge**

Replace the whole content of `electron/renderer-src/src/components/ToolMessage.tsx` with:

```tsx
// Badge colors copied from chat.py: WRITE=green, RUN(shell)=blue, READ=orange,
// SEARCH(network)=violet. category comes from AgentTool.category (workspace.mts etc.).
const CATEGORY_STYLE: Record<string, { label: string; className: string }> = {
  write: { label: 'WRITE', className: 'bg-green-900 text-green-400' },
  shell: { label: 'RUN', className: 'bg-blue-900 text-blue-400' },
  read: { label: 'READ', className: 'bg-orange-900 text-orange-400' },
  network: { label: 'SEARCH', className: 'bg-purple-900 text-purple-400' },
};
// A category that is unknown (a result saved before 2026-10-05, or closed by a Stop) or has no colour of its own (an
// extension: MCP, plugin) gets this neutral badge rather than none.
const NEUTRAL_STYLE = { label: 'OUTIL', className: 'bg-gray-800 text-gray-400' };

function looksLikeDiff(content: string): boolean {
  return /^[+-]/m.test(content) && /^@@|\n-|\n\+/.test(content);
}

function diffLineClassName(line: string): string {
  // edit_file's diff headers (core/unified-diff.mts) are neither a removal nor an addition.
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'font-bold text-gray-300';
  if (line.startsWith('+')) return 'text-green-400 bg-green-950/40';
  if (line.startsWith('-')) return 'text-red-400 bg-red-950/40';
  if (line.startsWith('@@')) return 'font-bold text-purple-400';
  return 'text-gray-400';
}

interface ToolMessageProps {
  tool?: string;
  category?: string;
  // The call's path, command, query or URL (state/tool-cards.ts), already cut to 120 characters.
  detail?: string;
  content: string;
  pending?: boolean;
}

export function ToolMessage({ tool, category, detail, content, pending = false }: ToolMessageProps) {
  const known = category ? CATEGORY_STYLE[category] : undefined;
  const style = known ?? NEUTRAL_STYLE;
  const isDiff = !pending && looksLikeDiff(content);
  return (
    <div className="mx-8 my-1 overflow-hidden rounded-lg border border-gray-800" data-testid="oa-tool-message">
      <div className="flex items-center gap-2 bg-[#161620] px-2 py-1 text-[11px]">
        <span
          data-testid="oa-tool-badge"
          data-badge={known ? category : 'neutral'}
          className={`shrink-0 rounded px-1.5 py-0.5 font-bold ${style.className}`}
        >
          {style.label}
        </span>
        <span data-testid="oa-tool-name" className="max-w-[45%] shrink-0 truncate text-gray-400">{tool ?? 'outil'}</span>
        {detail && (
          <span data-testid="oa-tool-detail" title={detail} className="min-w-0 flex-1 truncate font-mono text-gray-500">
            {detail}
          </span>
        )}
        {pending && <span className="ml-auto animate-pulse text-gray-600">…</span>}
      </div>
      <div className="max-h-[400px] overflow-y-auto bg-[#0f1117] py-1">
        {isDiff ? (
          content.split('\n').map((line, index) => (
            <pre key={index} className={`whitespace-pre-wrap px-2 font-mono text-[11px] ${diffLineClassName(line)}`}>
              {line || ' '}
            </pre>
          ))
        ) : (
          <pre className="whitespace-pre-wrap px-2 font-mono text-[11px] text-gray-300">{content}</pre>
        )}
      </div>
    </div>
  );
}
```

In `electron/renderer-src/src/components/ChatView.tsx`, replace:

```tsx
              return <ToolMessage key={index} tool={message._tool} category={message._category} content={message.content} />;
```

with:

```tsx
              return <ToolMessage key={index} tool={message._tool} category={message._category} detail={message._detail} content={message.content} />;
```

and replace:

```tsx
            <ToolMessage key={id} tool={meta.tool} category={meta.category} content="" pending />
```

with:

```tsx
            <ToolMessage key={id} tool={meta.tool} category={meta.category} detail={meta.detail} content="" pending />
```

- [ ] **Step 11: Run the Task 2 tests**

Run (from `electron/`): `node --experimental-strip-types --test tests/unified-diff.test.mts tests/tool-cards.test.mts tests/workspace.test.mts tests/agent.test.mts tests/request-context.test.mts tests/worker-tools.test.mts tests/worker-request.test.mts tests/chat-branches.test.mts tests/chat-compaction.test.mts tests/edit-regenerate.test.mts tests/artifacts.test.mts tests/export.test.mts tests/worker-export.test.mts`
Expected: all PASS.
- `worker-request`: the closing results keep their shape (ruling 9).
- The reducer suites: non-tool messages are passed through unchanged.
- The export suites: `renderEntries` ignores the new fields.

- [ ] **Step 12: Type-check both projects**

Run (from `electron/`): `npx tsc --noEmit -p tsconfig.core.json`, then `npx tsc --noEmit -p renderer-src/tsconfig.json`
Expected: core shows the 5 pre-existing errors only; renderer shows 0.

- [ ] **Step 13: Commit and push**

From the repository root:

```bash
git add electron/core/unified-diff.mts electron/core/workspace.mts electron/core/provider.mts electron/core/agent.mts electron/core/request-context.mts electron/renderer-src/src/state/tool-cards.ts electron/renderer-src/src/state/reducer.ts electron/renderer-src/src/components/ToolMessage.tsx electron/renderer-src/src/components/ChatView.tsx electron/tests/unified-diff.test.mts electron/tests/tool-cards.test.mts electron/tests/workspace.test.mts electron/tests/agent.test.mts electron/tests/request-context.test.mts electron/tests/worker-tools.test.mts electron/tests/all.mts
git commit -m "feat: tool cards keep their name, badge and detail after a reload — results saved with name and category (never sent to the provider), older transcripts recover the name with a neutral badge, the header shows the path/command/query/url, edit_file returns a unified diff bounded to 60 lines and 4 000 characters" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 3: Open a folder by typing its path (row 2)

**Files:**
- Modify: `electron/worker.mjs:7` (import), `:578-583` (`activate_folder`)
- Modify: `electron/renderer-src/src/ipc/bridge.ts:151-153` (`activateFolder` type)
- Modify: `electron/renderer-src/src/components/Sidebar.tsx:1-6,53-60,91-105,134-151`
- Modify: `electron/tests/worker-folders.test.mts` (import + 1 test appended)
- Rewrite: `electron/tests/sidebar-visual.cjs`
- Modify: `electron/tests/run-sidebar-visual.cjs:7` (timeout)

**Interfaces:**
- Consumes: `canonicalFolderPath(path: string): Promise<string>`, from `core/folders.mts:28`. It already exists.
- Produces: the `activate_folder` reply is `{ history: ChatMessage[]; folders: FolderListItem[]; folder: string }`, where `folder` is the canonical path.
- Produces DOM for Task 5's bilan:
  - `#oa-folder-path-input` (placeholder and `aria-label` « Chemin du dossier »);
  - `#oa-folder-path-open` (« Ouvrir »).

- [ ] **Step 1: Write the failing worker test**

In `electron/tests/worker-folders.test.mts`, replace line 5:

```typescript
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
```

with:

```typescript
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
```

Append:

```typescript
test('worker::activate_folder answers the folder under the spelling the history stores, whatever spelling was typed', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-folders-typed-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  }));
  const indexed = indexingSettled(worker, project);
  // Forward slashes and a trailing separator: how a path is often typed or pasted.
  const activated = await callWorker(worker, 'activate_folder', { folder: project.replaceAll('\\', '/') + '/' });
  const canonical = await realpath(project);
  assert.equal(activated.folder, canonical);
  assert.equal(activated.folders[0].path, canonical, 'the folder the history now lists first');
  await indexed;
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `electron/`): `node --experimental-strip-types --test tests/worker-folders.test.mts`
Expected: the new test FAILs, since `activated.folder` is `undefined`.

- [ ] **Step 3: Answer the canonical folder**

In `electron/worker.mjs`, replace line 7:

```javascript
import { FoldersService } from './core/folders.mts';
```

with:

```javascript
import { FoldersService, canonicalFolderPath } from './core/folders.mts';
```

Replace the `activate_folder` branch (lines 578-583):

```javascript
    if (op === 'activate_folder') {
      const list = await folders.recordOpened(payload.folder);
      const history = await conversations.messages(payload.folder, 'main').catch(() => []);
      result = { history: servedMessages(history), folders: list };
      void triggerIndexing(payload.folder);
    }
```

with:

```javascript
    if (op === 'activate_folder') {
      const list = await folders.recordOpened(payload.folder);
      const history = await conversations.messages(payload.folder, 'main').catch(() => []);
      // `folder`: the spelling the history stores (core/folders.mts) — a typed path is activated under it (Sidebar).
      result = { history: servedMessages(history), folders: list, folder: await canonicalFolderPath(payload.folder) };
      void triggerIndexing(payload.folder);
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run (from `electron/`): `node --experimental-strip-types --test tests/worker-folders.test.mts`
Expected: 3/3 PASS.

- [ ] **Step 5: Add the field and the button**

In `electron/renderer-src/src/ipc/bridge.ts`, replace:

```typescript
export function activateFolder(folder: string): Promise<{ history: ChatMessage[]; folders: FolderListItem[] }> {
  return request('activate_folder', { folder });
}
```

with:

```typescript
// `folder` is the canonical path the history stores (worker.mjs): the Sidebar activates a typed path under it.
export function activateFolder(folder: string): Promise<{ history: ChatMessage[]; folders: FolderListItem[]; folder: string }> {
  return request('activate_folder', { folder });
}
```

In `electron/renderer-src/src/components/Sidebar.tsx`, replace line 6:

```tsx
import { useToast } from '../state/ToastProvider';
```

with:

```tsx
import { useToast } from '../state/ToastProvider';
import { cleanIpcError } from '../ipc/errors';
```

Replace `activate` (lines 53-60):

```tsx
  const activate = useCallback(
    async (folder: string) => {
      const result = await activateFolder(folder);
      setFolders(result.folders);
      onActivated(folder, result.history);
    },
    [onActivated],
  );
```

with:

```tsx
  const activate = useCallback(
    async (folder: string, typed = false) => {
      const result = await activateFolder(folder);
      setFolders(result.folders);
      // A typed path is activated under the spelling the history stores (the worker's canonical path), so its entry
      // shows as active whatever separators were typed; the dialog and the history entries keep their own path.
      onActivated(typed ? result.folder : folder, result.history);
    },
    [onActivated],
  );
```

After `useRegisterAction('open-folder', () => void handleOpenFolder());` (line 105), add:

```tsx
  // « Chemin du dossier » + « Ouvrir » (parity row 2, sidebar.py::open_folder_prompt): the same activate() as the dialog
  // — history, restore, trust. The worker refuses a relative, missing or non-folder path (core/folders.mts); the toast
  // gives its own reason. Uncontrolled like the message box: Enter reads what is in the field right now.
  const pathRef = useRef<HTMLInputElement>(null);
  const handleOpenTyped = useCallback(async () => {
    const input = pathRef.current;
    if (!input) return;
    // Explorer's « Copier en tant que chemin d'accès » wraps the path in double quotes.
    const typed = input.value.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!typed) { notify('Impossible d’ouvrir ce dossier : chemin vide', 'negative'); return; }
    setOpening(true);
    try {
      await activate(typed, true);
      input.value = '';
    } catch (error) {
      notify(`Impossible d’ouvrir ce dossier : ${cleanIpcError(error)}`, 'negative');
    } finally {
      setOpening(false);
    }
  }, [activate, notify]);
```

In the JSX, right after the closing `</button>` of `#oa-open-folder-btn` and before `#oa-init-project-btn`, add:

```tsx
        <div className="mt-2 flex gap-1">
          <input
            id="oa-folder-path-input"
            ref={pathRef}
            type="text"
            placeholder="Chemin du dossier"
            aria-label="Chemin du dossier"
            title="Chemin absolu d’un dossier, puis Entrée ou « Ouvrir »"
            spellCheck={false}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleOpenTyped();
              }
            }}
            className="min-w-0 flex-1 rounded border border-gray-800 bg-gray-900 px-2 py-1 font-mono text-[11px] text-gray-200 outline-none focus:border-purple-600"
          />
          <button
            id="oa-folder-path-open"
            type="button"
            onClick={() => void handleOpenTyped()}
            disabled={opening}
            className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-60"
          >
            Ouvrir
          </button>
        </div>
```

- [ ] **Step 6: Type-check the renderer**

Run (from `electron/`): `npx tsc --noEmit -p renderer-src/tsconfig.json`
Expected: 0 errors.

- [ ] **Step 7: Extend `sidebar-visual.cjs`**

Replace the whole content of `electron/tests/sidebar-visual.cjs` with:

```javascript
// Run with Electron, not node. Loads the real preload.cjs + built renderer against a
// backend-request handler backed by a real (temp-dir) FoldersService — proves the
// Sidebar end to end: click → moves to the front of the history → survives a "restart"
// (a fresh FoldersService instance over the same temp home reads the same order back).
// Parity row 2 (2026-10-05): a path typed in « Chemin du dossier » opens the folder (quoted, forward slashes, or by
// Enter) through the same activate(); the entry shows its name, cut path and date; an empty, relative, missing or
// non-folder path is refused by a toast and activates nothing.
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" on a hidden BrowserWindow in this environment
// unless hardware acceleration is disabled first.
app.disableHardwareAcceleration();
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 8000, interval = 50, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// app.exit() can cut stdout before an async pipe write (common on Windows) actually
// reaches the OS — flush explicitly before exiting instead of racing it.
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-sidebar-'));
  const home = join(root, 'home');
  const a = join(root, 'project-a');
  const b = join(root, 'project-b');
  const c = join(root, 'project-c');
  const aFile = join(root, 'un-fichier.txt');
  await Promise.all([mkdir(home), mkdir(a), mkdir(b), mkdir(c)]);
  await writeFile(aFile, 'pas un dossier');
  const screenshotDir = process.env.OPENAGENT_SIDEBAR_SCREENSHOT_DIR || home;
  let win;
  try {
    const { FoldersService, canonicalFolderPath } = await import('../core/folders.mts');
    const { SettingsService } = await import('../core/settings.mts');
    const folders = new FoldersService(home);
    const settings = new SettingsService(home);
    // Seed history as if a previous session had opened a then b — b starts at the front.
    await folders.recordOpened(a);
    await folders.recordOpened(b);

    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'list_folders') return folders.list();
      if (request.op === 'activate_folder') {
        // As worker.mjs answers it: the history, the list, and the folder under the spelling the history stores.
        const list = await folders.recordOpened(request.payload.folder);
        return { history: [], folders: list, folder: await canonicalFolderPath(request.payload.folder) };
      }
      if (request.op === 'open-folder') return null;
      if (request.op === 'global-settings') return settings.publicGlobal();
      if (request.op === 'save-global-settings') return settings.saveGlobal(request.payload.patch);
      // ChatProvider (Tâche 7) also mounts alongside the Sidebar and fetches the active
      // folder's history — not under test here, just needs a quiet reply.
      if (request.op === 'messages') return [];
      throw new Error('opération inattendue dans le test sidebar : ' + request.op);
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 300));

    const js = code => win.webContents.executeJavaScript(code);
    const names = () => js("Array.from(document.querySelectorAll('.oa-folder-name')).map(el => el.textContent)");
    const activeName = () => js(`document.querySelector('[data-testid="oa-folder-entry"][data-active="true"]')?.querySelector('.oa-folder-name')?.textContent ?? null`);

    const namesBefore = await names();
    assert.deepEqual(namesBefore, ['project-b', 'project-a'], 'history loads in most-recently-used order on mount (restart)');
    await writeFile(join(screenshotDir, 'sidebar-before-click.png'), await capturePng(win));

    // Click the (currently second, inactive) project-a entry.
    await js("document.querySelector('[data-testid=\"oa-folder-entry\"][data-path$=\"project-a\"]').click()");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await names(), ['project-a', 'project-b'], 'clicking a history entry moves it to the front');
    assert.equal(await activeName(), 'project-a', 'the clicked folder is highlighted as active');

    // main.py's top bar shows only the basename after ▸, not the full path.
    const activePathText = await js("Array.from(document.querySelectorAll('span')).map(el => el.textContent).find(t => t?.startsWith('▸'))");
    assert.ok(activePathText?.includes('project-a'), 'the active folder basename is shown in the top bar');
    await writeFile(join(screenshotDir, 'sidebar-after-click.png'), await capturePng(win));

    // "Restart": a fresh FoldersService over the same temp home must see the same order —
    // this is a real disk read, not React state.
    assert.deepEqual((await new FoldersService(home).list()).map(e => e.name), ['project-a', 'project-b'], 'the new order actually persisted to disk');

    // ── Parity row 2: « Chemin du dossier » + « Ouvrir » ──────────────────────────
    const typePath = value => js(`(() => {
      const el = document.getElementById('oa-folder-path-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // Toasts already on screen are marked, so a refusal is matched only by the toast it raised itself.
    const markToasts = () => js(`document.querySelectorAll('[data-testid="oa-toast"]').forEach(el => { el.dataset.seen = '1'; })`);
    const newToast = pattern => waitFor(async () => {
      const fresh = await js(`[...document.querySelectorAll('[data-testid="oa-toast"]:not([data-seen])')].map(el => ({ text: el.textContent, kind: el.dataset.kind }))`);
      return fresh.find(toast => pattern.test(toast.text)) ?? null;
    }, { what: `a toast matching ${pattern}` });

    assert.equal(await js("document.getElementById('oa-folder-path-input')?.placeholder"), 'Chemin du dossier');
    assert.equal(await js("document.getElementById('oa-folder-path-open')?.textContent"), 'Ouvrir');

    // A valid path, typed the way Explorer copies it (quoted) and with forward slashes → active, first in the history.
    await typePath(`"${c.replaceAll('\\', '/')}"`);
    await js("document.getElementById('oa-folder-path-open').click()");
    await waitFor(async () => (await names())[0] === 'project-c', { what: 'project-c first in the history' });
    assert.deepEqual(await names(), ['project-c', 'project-a', 'project-b']);
    assert.equal(await activeName(), 'project-c', 'the typed folder is the active one');
    assert.equal(await js("document.getElementById('oa-folder-path-input').value"), '', 'the field is emptied once the folder is open');
    const [cEntry] = await new FoldersService(home).list();
    const canonicalC = await realpath(c);
    assert.equal(cEntry.path, canonicalC, 'recorded under its canonical path');
    const shownPath = canonicalC.length > 30 ? `${canonicalC.slice(0, 30)}…` : canonicalC;
    const shownDate = await js(`new Date(${JSON.stringify(cEntry.last_used)}).toLocaleDateString()`);
    const firstEntry = selector => js(`document.querySelector('[data-testid="oa-folder-entry"]').querySelector(${JSON.stringify(selector)}).textContent`);
    assert.equal(await firstEntry('.oa-folder-name'), 'project-c', 'the entry shows the folder name');
    assert.equal(await firstEntry('.oa-folder-path'), `${shownPath} · ${shownDate}`, 'the entry shows the (cut) path and the date');
    await writeFile(join(screenshotDir, 'sidebar-typed-path.png'), await capturePng(win));

    // Enter validates too.
    await typePath(a);
    await js(`document.getElementById('oa-folder-path-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
    await waitFor(async () => (await names())[0] === 'project-a', { what: 'project-a first again, by Enter' });
    assert.equal(await activeName(), 'project-a');

    // Refused: empty, relative, missing, a file — a clear toast, nothing activated, nothing recorded.
    const expectedOrder = ['project-a', 'project-c', 'project-b'];
    for (const [value, reason] of [['   ', /chemin vide/], ['relatif\\dossier', /absolu/], [join(root, 'absent'), /introuvable/], [aFile, /introuvable/]]) {
      await markToasts();
      await typePath(value);
      await js("document.getElementById('oa-folder-path-open').click()");
      const toast = await newToast(/^Impossible d’ouvrir ce dossier : /);
      assert.equal(toast.kind, 'negative', value);
      assert.match(toast.text, reason, value);
      assert.equal(toast.text.includes('Error invoking remote method'), false, `${value}: the worker's own reason, not the IPC wrapper`);
      assert.deepEqual(await names(), expectedOrder, `${value}: the history is unchanged`);
      assert.equal(await activeName(), 'project-a', `${value}: nothing else was activated`);
    }
    assert.deepEqual((await new FoldersService(home).list()).map(e => e.name), expectedOrder, 'nothing was recorded on disk');
    await writeFile(join(screenshotDir, 'sidebar-typed-refused.png'), await capturePng(win));

    process.stdout.write(`PASS sidebar click moves folder to front and persists; a typed path opens (quoted, forward slashes, Enter) and invalid ones are refused (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    if (!process.env.OPENAGENT_SIDEBAR_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL sidebar visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
```

In `electron/tests/run-sidebar-visual.cjs`, replace `timeout: 30000` with `timeout: 60000`.

- [ ] **Step 8: Build the renderer and run `sidebar-visual` once**

Run (from `electron/`): `npm run renderer:build`, then `npm run test:sidebar`. Run it **once**.
Expected: `PASS sidebar click moves folder to front and persists; a typed path opens …`. On failure, report the output and stop.

- [ ] **Step 9: Commit and push**

From the repository root:

```bash
git add electron/worker.mjs electron/renderer-src/src/ipc/bridge.ts electron/renderer-src/src/components/Sidebar.tsx electron/tests/worker-folders.test.mts electron/tests/sidebar-visual.cjs electron/tests/run-sidebar-visual.cjs
git commit -m "feat: open a folder by typing its path in the sidebar (« Chemin du dossier » + « Ouvrir », Enter too, quotes stripped) through the same activate_folder, which now answers the canonical folder; refusals shown as toasts with the worker's reason; name, path and date asserted" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 4: Window proofs for rows 6, 7, 14, 16 and 18, and the two defects they reveal

**Files:**
- Modify: `electron/renderer-src/src/components/InputBar.tsx:76-86` (`sendingRef`)
- Modify: `electron/renderer-src/src/state/export.ts` (`cleanIpcError`)
- Modify: `electron/tests/export-ui.test.mts` (1 test appended)
- Modify: `electron/tests/worker-tools.test.mts` (1 test appended)
- Rewrite: `electron/tests/chat-visual.cjs`
- Modify: `electron/tests/run-chat-visual.cjs:7` (timeout)
- Modify: `electron/tests/export-visual.cjs` (imports, helper, step 9)
- Modify: `electron/tests/theme-visual.cjs` (imports, helper, accent step)
- Modify: `electron/tests/run-theme-visual.cjs:7` (timeout)

**Interfaces:**
- Consumes (Task 2): the DOM `[data-testid="oa-tool-badge"][data-badge]`, `[data-testid="oa-tool-name"]` and `[data-testid="oa-tool-detail"]`; and `edit_file`'s diff (`-salut` / `+bonjour` lines).
- Consumes (Task 1): nothing.
- Produces: nothing used later; Task 5 cites the test names.

- [ ] **Step 1: Write the failing export toast test**

Append to `electron/tests/export-ui.test.mts`:

```typescript
test("performExport: a refusal relayed by Electron shows the worker's own message, without the IPC wrapper", async () => {
  const deps = fakeDeps({ exportConversation: async () => { throw new Error("Error invoking remote method 'backend-request': Error: Dossier introuvable"); } });
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(notices, [["Échec de l'export : Dossier introuvable", 'negative']]);
});
```

- [ ] **Step 2: Write the `search_ask` worker test (row 18, missing proof)**

Append to `electron/tests/worker-tools.test.mts`:

```typescript
// ── row 18: search_ask (2026-10-05) ──────────────────────────────────────────────
// fetch_url to the loopback is refused by the SSRF policy only WHEN IT RUNS: that error proves the tool ran, and no
// packet leaves the machine.
test('search_ask: true asks before a network tool runs — refused, it never runs; approved, it runs — and false (the default) runs it without asking', async t => {
  const fetch: Step = { tool: { name: 'fetch_url', args: { url: 'http://127.0.0.1:9/page' } } };
  const { worker, project, send } = await setup(t, [fetch, { text: 'a' }, fetch, { text: 'b' }, fetch, { text: 'c' }]);
  const RAN = 'Erreur : Adresse réseau interne ou privée refusée';
  const lastTool = async () => (await callWorker(worker, 'messages', { folder: project, branchId: 'main' })).filter((m: any) => m.role === 'tool').at(-1);

  const byDefault = await send(worker);
  await until(() => finished(byDefault.events), 'the default run');
  byDefault.stop();
  assert.equal(byDefault.events.some(e => e.kind === 'permission-request'), false, 'search_ask is false by default: no prompt');
  assert.ok(byDefault.events.some(e => e.kind === 'tool-start' && e.tool === 'fetch_url'));
  assert.equal((await lastTool()).content, RAN);

  await callWorker(worker, 'save-global-settings', { patch: { search_ask: true } });
  const refused = await send(worker, 'refuse');
  await until(() => refused.events.some(e => e.kind === 'permission-request'), 'the network prompt');
  const request = refused.events.find(e => e.kind === 'permission-request');
  assert.equal(request.tool, 'fetch_url');
  assert.equal(request.category, 'network');
  assert.equal(refused.events.some(e => e.kind === 'tool-start'), false, 'not run before the decision');
  await callWorker(worker, 'permission-decision', { runId: refused.runId, requestId: request.requestId, allow: false, always: false });
  await until(() => finished(refused.events), 'the refused run');
  refused.stop();
  assert.equal(refused.events.some(e => e.kind === 'tool-start'), false, 'a refused network tool never runs');
  assert.equal((await lastTool()).content, 'Erreur : Exécution refusée par les permissions');

  const approved = await send(worker, 'accepte');
  await until(() => approved.events.some(e => e.kind === 'permission-request'), 'the second network prompt');
  const second = approved.events.find(e => e.kind === 'permission-request');
  assert.equal(approved.events.some(e => e.kind === 'tool-start'), false, 'not run before the decision');
  await callWorker(worker, 'permission-decision', { runId: approved.runId, requestId: second.requestId, allow: true, always: false });
  await until(() => finished(approved.events), 'the approved run');
  approved.stop();
  assert.ok(approved.events.some(e => e.kind === 'tool-start' && e.tool === 'fetch_url'), 'approved: it runs');
  assert.equal((await lastTool()).content, RAN);
});
```

- [ ] **Step 3: Run them**

Run (from `electron/`): `node --experimental-strip-types --test tests/export-ui.test.mts tests/worker-tools.test.mts`

Expected:
- `export-ui.test.mts`: the new test FAILs. The notice is `Échec de l'export : Error invoking remote method 'backend-request': Error: Dossier introuvable`.
- `worker-tools.test.mts`: the `search_ask` test **PASSes**. It is a missing proof; `core/agent.mts:54` already implements the policy. If it fails, it is a real defect: fix `policy()` and record it in the bilan.

- [ ] **Step 4: Fix the export toast**

In `electron/renderer-src/src/state/export.ts`, add the import as the first line of the file:

```typescript
import { cleanIpcError } from '../ipc/errors.ts';
```

Replace:

```typescript
  } catch (error) {
    notify(`Échec de l'export : ${error instanceof Error ? error.message : 'erreur inconnue'}`, 'negative');
    return;
  }
```

with:

```typescript
  } catch (error) {
    // A refusal from the worker reaches the page wrapped by Electron (« Error invoking remote method … »): only the
    // worker's own reason is shown.
    notify(`Échec de l'export : ${error instanceof Error ? cleanIpcError(error) : 'erreur inconnue'}`, 'negative');
    return;
  }
```

- [ ] **Step 5: Fix the double send**

In `electron/renderer-src/src/components/InputBar.tsx`, replace lines 76-86:

```tsx
  const handleSend = useCallback(async () => {
    const el = textRef.current;
    // While a summary is being made the transcript is rewritten: a message sent now would be lost in it.
    // Checked BEFORE the box is emptied, so the typed text stays for when the compaction is over.
    if (!el || !el.value.trim() || state.agentRunning || state.compacting) return;
    const text = el.value;
    const files = attachments;
    el.value = '';
    setAttachments([]); // the files leave with the message (state.attached_files.clear())
    await send(text, files);
  }, [send, state.agentRunning, state.compacting, attachments]);
```

with:

```tsx
  // True from the moment a message leaves the box until send() has answered. `state.agentRunning` only turns true once
  // the worker accepted the turn, and the worker does not refuse a second turn in the same folder: an Enter pressed in
  // between, the box refilled, started two turns at once (parity row 7, 2026-10-05).
  const sendingRef = useRef(false);

  const handleSend = useCallback(async () => {
    const el = textRef.current;
    // While a summary is being made the transcript is rewritten: a message sent now would be lost in it.
    // Checked BEFORE the box is emptied, so the typed text stays for when the compaction — or the send — is over.
    if (!el || !el.value.trim() || sendingRef.current || state.agentRunning || state.compacting) return;
    const text = el.value;
    const files = attachments;
    sendingRef.current = true;
    el.value = '';
    setAttachments([]); // the files leave with the message (state.attached_files.clear())
    try {
      await send(text, files);
    } finally {
      sendingRef.current = false;
    }
  }, [send, state.agentRunning, state.compacting, attachments]);
```

`useRef` is already imported on line 1.

- [ ] **Step 6: Run the unit tests and type-check**

Run (from `electron/`): `node --experimental-strip-types --test tests/export-ui.test.mts`, then `npx tsc --noEmit -p renderer-src/tsconfig.json`, then `npx tsc --noEmit -p tsconfig.core.json`
Expected:
- export-ui: all PASS;
- renderer tsc: 0;
- core tsc: the 5 pre-existing errors only.

- [ ] **Step 7: Rewrite `chat-visual.cjs` (rows 6 and 7)**

Replace the whole content of `electron/tests/chat-visual.cjs` with:

````javascript
// Run with Electron, not node. Loads the real preload.cjs + built renderer, spawns the
// REAL worker.mjs (not a stub), and relays backend-message like main.cjs does — proves
// a real conversation end to end through the actual UI: open folder → type → send →
// streamed tool-start/message events → a real create_file write → assistant reply
// rendered as markdown, against a fake HTTP provider (same pattern as agent.test.mts).
// Parity rows 6 and 7 (2026-10-05): each tool card shows its name, badge and detail (path, command, query); an
// edit_file shows its diff in colour; a code block is highlighted and the view sits at the bottom; reopening the
// conversation keeps every card; an older conversation saved without names gets them back with a neutral badge; no
// request ever carries a card's name or category. Shift+Enter sends nothing; two quick Enter (the box refilled in
// between), or Enter during a turn, send exactly one request.
const { app, BrowserWindow, ipcMain } = require('electron');
// Fixes a real Electron 38→44 regression found while upgrading (Tâche 12):
// capturePage() throws "UnknownVizError" on a hidden BrowserWindow in this environment
// unless hardware acceleration is disabled first.
app.disableHardwareAcceleration();
const { Worker } = require('node:worker_threads');
require('./no-onboarding.cjs'); // side effect: see that file
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 8000, interval = 50, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// app.exit() can cut stdout before an async pipe write (common on Windows) actually
// reaches the OS — flush explicitly before exiting instead of racing it.
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const callsReply = (...calls) => ({ choices: [{ message: { content: '', tool_calls: calls }, finish_reason: 'tool_calls' }] });
const textReply = content => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const LONG_REPLY = Array.from({ length: 60 }, (_, i) => `Paragraphe ${i + 1}.`).join('\n\n');
// One answer per request, in order. Request 8 (« tour long ») is held 1.5 s so a message can be typed during it.
const SCRIPT = [
  callsReply(toolCall('call-1', 'create_file', { path: 'notes.md', content: 'salut' })),
  textReply('Fichier **notes.md** créé.'),
  callsReply(toolCall('call-2', 'edit_file', { path: 'notes.md', old_string: 'salut', new_string: 'bonjour' })),
  textReply('Modifié.'),
  callsReply(toolCall('call-3', 'run_command', { command: 'echo ok' }), toolCall('call-4', 'knowledge_search', { query: 'notes' })),
  textReply('Fait :\n\n```python\nprint("ok")\n```\n'),
  textReply('Un seul envoi.'),
  textReply(LONG_REPLY),
];
const HELD_REQUEST = 8;

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-chat-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const other = join(root, 'other');
  await Promise.all([mkdir(home), mkdir(project), mkdir(other)]);
  const screenshotDir = process.env.OPENAGENT_CHAT_SCREENSHOT_DIR || home;
  let win;
  let server;
  let worker;
  try {
    // This test is about the conversation flow; the write and shell prompts (asked by default since 2026-10-03) have
    // their own test, permission-visual.cjs. The user's saved choice is respected.
    const { SettingsService } = await import('../core/settings.mts');
    await new SettingsService(home).saveGlobal({ files_ask: false, shell_ask: false });
    const bodies = [];
    server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        bodies.push(JSON.parse(body));
        const index = bodies.length;
        const answer = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(SCRIPT[Math.min(index, SCRIPT.length) - 1]));
        };
        if (index === HELD_REQUEST) setTimeout(answer, 1500); else answer();
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    const callWorker = (op, payload) => new Promise((resolve, reject) => {
      const id = `${Date.now()}-${Math.random()}`;
      pending.set(id, { resolve, reject });
      worker.postMessage({ op, payload, id });
    });

    // What the stubbed native folder dialog answers: the project first, another folder to switch away and back.
    let dialogAnswer = project;
    ipcMain.handle('backend-request', async (_event, request) => {
      if (request.op === 'open-folder') return dialogAnswer;
      if (request.op === 'global-settings') return { theme: 'dark', accent_color: '#3b82f6', onboarding_done: true };
      if (request.op === 'save-global-settings') return {};
      const payload = request.op === 'send' ? { ...request.payload, connection } : request.payload;
      return callWorker(request.op, payload);
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(200);

    const js = code => win.webContents.executeJavaScript(code);
    const typeAndEnter = text => js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    const sendButton = () => js("document.getElementById('oa-send-btn')?.textContent");
    const idle = () => waitFor(async () => (await sendButton()) === '➤', { what: 'the send button back to idle' });
    const lastBubble = () => js("Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.textContent || ''");
    const cards = () => js(`[...document.querySelectorAll('[data-testid="oa-tool-message"]')].map(card => ({
      name: card.querySelector('[data-testid="oa-tool-name"]')?.textContent ?? null,
      badge: card.querySelector('[data-testid="oa-tool-badge"]')?.dataset.badge ?? null,
      detail: card.querySelector('[data-testid="oa-tool-detail"]')?.textContent ?? null,
    }))`);
    const topBarShows = name => js(`Array.from(document.querySelectorAll('span')).some(el => el.textContent?.startsWith('▸') && el.textContent.includes(${JSON.stringify(name)}))`);
    const openEntry = name => js(`document.querySelector('[data-testid="oa-folder-entry"][data-path$=${JSON.stringify(name)}]').click()`);
    const savedUserTexts = async () => (await callWorker('messages', { folder: project, branchId: 'main' })).filter(m => m.role === 'user').map(m => m.content);
    const inputValue = () => js("document.getElementById('oa-input-ta').value");

    // ── 1. Open the project through the real Sidebar button/dialog flow ──────────
    await js("document.getElementById('oa-open-folder-btn').click()");
    await waitFor(() => js("document.querySelector('[data-testid=\"oa-folder-entry\"]')?.textContent?.includes('project') || false"), { what: 'project opened' });
    assert.ok(await js("!!document.getElementById('oa-input-ta')"), 'the real InputBar is present once a folder is active');

    // ── 2. create_file: badge, name, detail; markdown; the real file ──────────────
    await typeAndEnter('crée un fichier notes.md');
    const userBubbleShown = await waitFor(() => js("Array.from(document.querySelectorAll('div')).some(el => el.textContent === 'crée un fichier notes.md')"));
    assert.ok(userBubbleShown, 'the user message renders immediately (optimistic, before any agent event)');
    await writeFile(join(screenshotDir, 'chat-1-sending.png'), await capturePng(win));

    await waitFor(() => js("!!document.querySelector('[data-testid=\"oa-tool-message\"]')"));
    const toolBadge = await js("document.querySelector('[data-testid=\"oa-tool-message\"]')?.textContent");
    assert.match(toolBadge, /WRITE/, 'the tool message shows the real WRITE category badge');
    assert.match(toolBadge, /create_file/, 'the tool message names the real tool that ran');
    await writeFile(join(screenshotDir, 'chat-2-tool-ran.png'), await capturePng(win));

    // Two AI bubbles exist by now: the first (empty content) from the tool-call turn,
    // the second with the actual final reply — always check the last one.
    const assistantText = await waitFor(async () => {
      const text = await lastBubble();
      return text.includes('créé') ? text : null;
    });
    assert.match(assistantText, /notes\.md/, 'the assistant reply (rendered markdown) mentions the created file');
    assert.ok(await js("!!Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.querySelector('strong')"),
      'markdown bold (**notes.md**) actually renders as a real <strong> element, not raw asterisks');
    await idle();
    assert.equal(await sendButton(), '➤', 'the send/stop button is back to its idle state once the run is done');
    await writeFile(join(screenshotDir, 'chat-3-done.png'), await capturePng(win));
    assert.equal(await readFile(join(project, 'notes.md'), 'utf8'), 'salut', 'create_file actually wrote the real file on disk, through the real UI click path');
    assert.deepEqual((await cards())[0], { name: 'create_file', badge: 'write', detail: 'notes.md' });
    assert.deepEqual(bodies[1].messages.filter(m => m.role === 'tool').map(m => Object.keys(m).sort()), [['content', 'role', 'tool_call_id']],
      'the request carries no name or category');

    // ── 3. edit_file: its diff, in colour ───────────────────────────────────────
    await typeAndEnter('remplace salut par bonjour');
    await waitFor(async () => (await lastBubble()).includes('Modifié.'), { what: 'the edit turn' });
    await idle();
    assert.equal(await readFile(join(project, 'notes.md'), 'utf8'), 'bonjour');
    assert.deepEqual((await cards())[1], { name: 'edit_file', badge: 'write', detail: 'notes.md' });
    const diffLines = await js(`[...[...document.querySelectorAll('[data-testid="oa-tool-message"]')][1].querySelectorAll('pre')].map(pre => ({ text: pre.textContent, className: pre.className }))`);
    assert.ok(diffLines.some(line => line.text === '-salut' && line.className.includes('text-red-400')), JSON.stringify(diffLines));
    assert.ok(diffLines.some(line => line.text === '+bonjour' && line.className.includes('text-green-400')), JSON.stringify(diffLines));
    await writeFile(join(screenshotDir, 'chat-4-diff.png'), await capturePng(win));

    // ── 4. run_command and a search: their detail; a code block is highlighted ───
    await typeAndEnter('lance echo puis cherche');
    await waitFor(async () => (await lastBubble()).includes('Fait'), { what: 'the command and search turn' });
    await idle();
    const live = await cards();
    assert.deepEqual(live.slice(2), [
      { name: 'run_command', badge: 'shell', detail: 'echo ok' },
      { name: 'knowledge_search', badge: 'read', detail: 'notes' },
    ]);
    assert.ok(await js("!!Array.from(document.querySelectorAll('[data-testid=\"oa-assistant-bubble\"]')).at(-1)?.querySelector('pre code.hljs')"),
      'a ```python block is rendered highlighted');

    // ── 5. Reopening the conversation keeps every card ──────────────────────────
    // Another folder first: clicking the active folder's own entry does not reload the chat (ChatProvider is keyed on it).
    dialogAnswer = other;
    await js("document.getElementById('oa-open-folder-btn').click()");
    await waitFor(async () => (await topBarShows('other')) && (await cards()).length === 0, { what: 'the other folder active' });
    await openEntry('project');
    await waitFor(async () => (await cards()).length === 4, { what: 'the reopened conversation' });
    assert.deepEqual(await cards(), live, 'name, badge and detail are all back after reopening');
    await writeFile(join(screenshotDir, 'chat-5-reopened.png'), await capturePng(win));

    // ── 6. A conversation saved before 2026-10-05: names recovered, neutral badge ─
    await callWorker('save-messages', {
      folder: project, branchId: 'main', messages: [
        { role: 'user', content: 'lis le vieux fichier' },
        { role: 'assistant', content: '', tool_calls: [toolCall('old-1', 'read_file', { path: 'legacy.txt' })] },
        { role: 'tool', tool_call_id: 'old-1', content: 'contenu ancien' },
        { role: 'assistant', content: 'Lu.' },
      ],
    });
    await openEntry('other');
    await waitFor(async () => (await topBarShows('other')) && (await cards()).length === 0, { what: 'the other folder again' });
    await openEntry('project');
    await waitFor(async () => (await lastBubble()).includes('Lu.'), { what: 'the older conversation shown' });
    assert.deepEqual(await cards(), [{ name: 'read_file', badge: 'neutral', detail: 'legacy.txt' }]);
    await writeFile(join(screenshotDir, 'chat-6-legacy.png'), await capturePng(win));

    // ── 7. Row 7: Shift+Enter sends nothing ─────────────────────────────────────
    // A synthetic event never performs the browser's default action (no new line appears): what is proven is that the
    // app leaves Shift+Enter to the textarea (not cancelled) while it cancels a plain Enter (below), and sends nothing.
    const beforeShift = bodies.length;
    const shift = await js(`(() => {
      const el = document.getElementById('oa-input-ta');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'ligne 1');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return { cancelled: event.defaultPrevented, value: el.value };
    })()`);
    assert.deepEqual(shift, { cancelled: false, value: 'ligne 1' }, 'Shift+Enter is left to the textarea and sends nothing');
    await pause(500);
    assert.equal(bodies.length, beforeShift, 'no request for Shift+Enter');

    // ── 8. Two quick Enter, the box refilled in between: one request ─────────────
    const cancelled = await js(`(() => {
      const el = document.getElementById('oa-input-ta');
      const set = text => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const enter = () => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      set('premier envoi');
      const first = enter();
      const second = enter();
      set('second envoi');
      const third = enter();
      return [first, second, third];
    })()`);
    assert.deepEqual(cancelled, [true, true, true], 'a plain Enter is always taken by the app, never a new line');
    await waitFor(async () => (await lastBubble()).includes('Un seul envoi.'), { what: 'the one turn' });
    await idle();
    await pause(500);
    assert.equal(bodies.length, beforeShift + 1, 'exactly one request for the quick double Enter');
    assert.equal(await inputValue(), 'second envoi', 'what was typed during the send stays in the box');
    const afterDouble = await savedUserTexts();
    assert.equal(afterDouble.filter(text => text === 'premier envoi').length, 1);
    assert.equal(afterDouble.includes('second envoi'), false);

    // ── 9. Enter during a turn: no request ──────────────────────────────────────
    await typeAndEnter('tour long');
    await waitFor(async () => (await sendButton()) === '■', { what: 'the turn running' });
    await waitFor(() => bodies.length === HELD_REQUEST, { what: 'the held request reached the model' });
    await typeAndEnter('pendant le tour');
    await pause(300);
    assert.equal(bodies.length, HELD_REQUEST, 'Enter during a turn sends nothing');
    await waitFor(async () => (await lastBubble()).includes('Paragraphe 60.'), { timeout: 10000, what: 'the long turn' });
    await idle();
    await pause(300);
    assert.equal(bodies.length, HELD_REQUEST, 'still one request for that turn');
    assert.equal(await inputValue(), 'pendant le tour', 'the refused text stays in the box');
    const afterLong = await savedUserTexts();
    assert.equal(afterLong.includes('pendant le tour'), false);
    assert.equal(afterLong.filter(text => text === 'tour long').length, 1);

    // ── 10. The view sits at the bottom of a conversation taller than the window ──
    await waitFor(async () => {
      const view = await js(`(() => {
        const el = document.querySelector('[data-testid="oa-chat-scroll"]');
        return { overflow: el.scrollHeight > el.clientHeight, gap: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) };
      })()`);
      return view.overflow && view.gap <= 2;
    }, { what: 'the view at the bottom of a long conversation' });
    await writeFile(join(screenshotDir, 'chat-7-long.png'), await capturePng(win));

    process.stdout.write(`PASS real conversation through the UI creates a file and renders markdown; tool cards (name, badge, detail, diff) survive a reopen; Shift+Enter and the double send proven (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (!process.env.OPENAGENT_CHAT_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL chat visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
````

In `electron/tests/run-chat-visual.cjs`, replace `timeout: 30000` with `timeout: 150000`.

- [ ] **Step 8: Add the export failure to `export-visual.cjs` (row 14)**

In `electron/tests/export-visual.cjs`, replace line 15:

```javascript
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir } = require('node:fs/promises');
```

with:

```javascript
const { mkdtemp, rm, mkdir, writeFile, readFile, readdir, rename } = require('node:fs/promises');
```

After the line `const pause = ms => new Promise(resolve => setTimeout(resolve, ms));` (line 36), add:

```javascript
// Windows refuses to rename a folder while a handle is open in it (EPERM/EBUSY/EACCES): git-status or the index may
// still hold one for a moment. Bounded: 5 s, then the error is thrown.
async function renameWhenFree(from, to) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await rename(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || Date.now() > deadline) throw error;
      await pause(200);
    }
  }
}
```

After step 8 (the line `await writeFile(join(screenshotDir, 'export-4-after.png'), await capturePng(win));`), add:

```javascript
    // ── 9. Parity row 14: the folder made unreachable, an export started from ⬇ → « Échec de l'export », nothing written ──
    // The background indexing activation started must be over before the folder is renamed.
    await waitFor(async () => (await callWorker('index-status', { folder: alpha })).state !== 'indexing', { timeout: 30000, what: 'indexing finished' });
    const moved = join(root, 'alpha-deplace');
    await renameWhenFree(alpha, moved);
    const openedBefore = opened.length;
    const entriesBefore = (await readdir(moved)).length;
    await click('#oa-export-btn');
    await waitFor(() => exists('[data-testid="oa-export-menu"]'), { what: 'export menu opens' });
    await click('#oa-export-md');
    const failure = await waitForNewestToast(/^Échec de l'export : /);
    assert.equal(failure.kind, 'negative');
    assert.equal(failure.text.includes('Error invoking remote method'), false, "the worker's own reason, not the IPC wrapper");
    assert.equal(opened.length, openedBefore, 'nothing was asked to open');
    assert.equal((await readdir(moved)).length, entriesBefore, 'no file was written in the folder');
    await writeFile(join(screenshotDir, 'export-5-failure.png'), await capturePng(win));
```

Replace the PASS line:

```javascript
    process.stdout.write(`PASS conversation export: real ⬇ click + palette, 3 real files on disk (headers, real tool tags, quoting, escape-once), toasts, refused folder (Electron ${process.versions.electron})\n`);
```

with:

```javascript
    process.stdout.write(`PASS conversation export: real ⬇ click + palette, 3 real files on disk (headers, real tool tags, quoting, escape-once), toasts, refused folder, failure toast through the UI (Electron ${process.versions.electron})\n`);
```

The runner's timeout (150 s) is unchanged.

- [ ] **Step 9: Add the accent change to `theme-visual.cjs` (row 16)**

In `electron/tests/theme-visual.cjs`, replace line 10:

```javascript
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
```

with:

```javascript
const { mkdtemp, rm, writeFile, readFile } = require('node:fs/promises');
```

After the `flush()` function (line 22), add:

```javascript
async function waitFor(fn, { timeout = 8000, interval = 50, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
```

After `assert.equal(persisted.theme, 'light', 'the toggle click actually persisted to disk, not just React state');`, add:

```javascript
    // ── Parity row 16: the accent chosen in Réglages > Apparence — applied to --accent, saved, kept after a reload ──
    const accentNow = () => win.webContents.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
    await win.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('oa-accent-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '#ff0000');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => (await accentNow()) === '#ff0000', { what: '--accent applied' });
    await waitFor(async () => (await new SettingsService(home).global()).accent_color === '#ff0000', { what: 'accent saved' });
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).accent_color, '#ff0000', 'written to config.json');
    await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await waitFor(async () => (await accentNow()) === '#ff0000', { what: 'the accent after a reload' });
    assert.equal(await win.webContents.executeJavaScript("document.documentElement.getAttribute('data-theme')"), 'light', 'the theme survives the reload too');
    const accentShot = await win.webContents.capturePage();
    await writeFile(join(screenshotDir, 'theme-accent.png'), accentShot.toPNG());
```

Replace the PASS line:

```javascript
    process.stdout.write(`PASS theme toggle applies to the DOM/CSS and persists to disk (Electron ${process.versions.electron})\n`);
```

with:

```javascript
    process.stdout.write(`PASS theme toggle applies to the DOM/CSS and persists to disk; accent #ff0000 applied, saved and kept after a reload (Electron ${process.versions.electron})\n`);
```

In `electron/tests/run-theme-visual.cjs`, replace `timeout: 30000` with `timeout: 60000`.

- [ ] **Step 10: Build the renderer, then run the three window tests once each**

Run (from `electron/`): `npm run renderer:build`, then each **once**, in this order:
1. `npm run test:chat` — expected `PASS real conversation through the UI …`;
2. `npm run test:export` — expected `PASS conversation export: … failure toast through the UI`;
3. `npm run test:theme` — expected `PASS theme toggle … accent #ff0000 …`.

On any failure, report the full output and stop: no second run. A test failure (as opposed to a product failure) is fixed and **reported to the user before any re-run**, which needs the user's agreement.

- [ ] **Step 11: Commit and push**

From the repository root:

```bash
git add electron/renderer-src/src/components/InputBar.tsx electron/renderer-src/src/state/export.ts electron/tests/export-ui.test.mts electron/tests/worker-tools.test.mts electron/tests/chat-visual.cjs electron/tests/run-chat-visual.cjs electron/tests/export-visual.cjs electron/tests/theme-visual.cjs electron/tests/run-theme-visual.cjs
git commit -m "test: window proofs for parity rows 6, 7, 14, 16 and 18 — cards (name, badge, detail, diff) through a reopen and an older transcript, code block and scroll, Shift+Enter, double send, export failure toast, accent #ff0000, search_ask; fixes a double send when the box is refilled before the worker answers, and the IPC wrapper in the export failure toast" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 5: Closure — full checks, matrix, bilan, lessons

**Files:**
- Modify: `tasks/todo.md:3` (header), `:17` (the open box), end of file (bilan)
- Modify: `tasks/lessons.md` (appended)

**Interfaces:**
- Consumes: every test name above, and the results of the single window runs of Tasks 1, 3 and 4.

- [ ] **Step 1: Full suite**

Run (from `electron/`): `timeout 900 node --experimental-strip-types --test tests/all.mts`. Run it once.
Expected: **803/803**, 0 failures. If the count differs, find out why (a test added or missing) before writing the bilan, and give the real figure there.

- [ ] **Step 2: Type-check both projects**

Run (from `electron/`): `npx tsc --noEmit -p tsconfig.core.json`, then `npx tsc --noEmit -p renderer-src/tsconfig.json`
Expected: core shows the 5 pre-existing errors only; renderer shows 0.

- [ ] **Step 3: Package and smoke-test**

Run (from `electron/`): `npm run package:win`, then `npm run test:package`. Run `test:package` **once**.
Expected:
- `package:win` exits with code 0;
- `test:package` passes;
- the built `app.asar` contains `core/file-filter.mts` and `core/unified-diff.mts`. Check with `npx asar list release/win-unpacked/resources/app.asar | grep -E "file-filter|unified-diff"`, or list the archive the way the previous bilan did.

Then confirm no `electron`/`openagent` process was left behind: `tasklist | grep -iE "electron|openagent"` prints nothing.

- [ ] **Step 4: Close the matrix box in `tasks/todo.md`**

Replace the open box (line 17, starting `- [ ] Finitions des lignes partielles de la matrice, hors lot par décision du 2026-10-04`) with the following. Keep only the clauses whose test passed; a row whose window test failed stays in an open box naming it:

```markdown
- [x] Finitions des lignes partielles de la matrice (lot « finitions de parité », 2026-10-05, spec `docs/superpowers/specs/2026-10-05-parity-finishings-design.md`) — preuve :
  - ligne 2 : `sidebar-visual.cjs` (chemin tapé entre guillemets et en « / », puis par Entrée ; refus d'un chemin vide, relatif, absent ou d'un fichier, sans rien activer ; nom, chemin tronqué et date assertés) ; `worker-folders.test.mts` « worker::activate_folder answers the folder under the spelling the history stores, whatever spelling was typed » ;
  - ligne 6 : `chat-visual.cjs` (nom, badge et détail des cartes `create_file`, `edit_file`, `run_command`, `knowledge_search` ; diff coloré ; cartes identiques après réouverture ; ancienne conversation : nom retrouvé, badge neutre ; bloc de code `pre code.hljs` ; vue en bas d'un long fil ; requête sans `name`/`category`) ; `tool-cards.test.mts` (3 tests) ; `unified-diff.test.mts` (4 tests) ; `workspace.test.mts` « edit_file answers its success line then a unified diff of the change, bounded with « [diff tronqué] » » ; `agent.test.mts` « a tool result is saved with its tool name and category, and neither field is ever sent to the provider » ; `request-context.test.mts` « a tool result goes out as role, tool_call_id and content only: its saved name and category stay on disk » ; `worker-tools.test.mts` « a saved tool result keeps its tool name and category, and the next request sends neither » ;
  - ligne 7 : `chat-visual.cjs` (Shift+Entrée laissé au champ, aucune requête ; deux Entrée rapides, zone re-remplie entre les deux : une seule requête ; Entrée pendant un tour : aucune requête, le texte reste) — défaut corrigé : le double envoi lançait deux tours dans le même dossier ;
  - ligne 14 : `export-visual.cjs` étape 9 (dossier renommé après activation, export depuis ⬇ → toast `negative` « Échec de l'export : … », rien d'ouvert ni d'écrit) ; `export-ui.test.mts` « performExport: a refusal relayed by Electron shows the worker's own message, without the IPC wrapper » — défaut corrigé : le toast montrait l'enveloppe IPC d'Electron ;
  - ligne 16 : `theme-visual.cjs` (accent `#ff0000` choisi dans Apparence → `--accent`, `config.json`, encore là après rechargement) ;
  - ligne 18 : `worker-tools.test.mts` « search_ask: true asks before a network tool runs — refused, it never runs; approved, it runs — and false (the default) runs it without asking » ;
  - ligne 30 : `semantic-index.test.mts` « re-indexing after a file is modified: the search finds the new content and the old one is gone from the store (parity row 30) » ; sécurité : `file-filter.test.mts` (2 tests), `semantic-index.test.mts` « indexFolder never indexes a secret file nor one the project ignores, and a rebuild purges them from an older index, backup copy included » et « searchCollection never returns a chunk of a secret or excluded file, even from an index written before the filter existed », `search-tools.test.mts` « semantic_search never renders a secret or ignored file, even from an index that still holds one », `worker-index-status.test.mts` « the automatic indexing applies the project's ignored patterns and the secret-file filter, and purges an older index of them », `worker-search-tools.test.mts` « worker::semantic_search applies the project's ignored patterns and hides secret files, even from an index that still holds them » ; `index-status-visual.cjs` relancé une fois.
```

Then replace line 3:

```markdown
## Migration 2026-09-14-electron-autonomous — LIVRÉE SAUF : finitions des lignes 2, 6, 7, 14, 16, 18 et 30 de la matrice de parité (hors lot par décision du 2026-10-04)
```

with `## Migration 2026-09-14-electron-autonomous — LIVRÉE`, **only if** every window test of Tasks 1, 3 and 4 and `test:package` passed on their single run.

Otherwise, write `## Migration 2026-09-14-electron-autonomous — LIVRÉE SAUF : <les lignes dont la preuve a échoué, et le test en cause>`.

The line « Ne pas annoncer la migration entièrement terminée tant que les cases ci-dessus restent ouvertes. » stays.

- [ ] **Step 5: Append the bilan at the END of `tasks/todo.md`**

Append, in French, the section below. Fill each measured value from Steps 1-3 and from Tasks 1-4's runs: suite count and duration, tsc counts, PASS/FAIL of each window test, and the commit hashes from `git log --oneline -6`.

```markdown
### Bilan du lot — finitions de parité (2026-10-05)

Conception : `docs/superpowers/specs/2026-10-05-parity-finishings-design.md` ; plan : `docs/superpowers/plans/2026-10-05-parity-finishings.md` ; audit : `docs/superpowers/specs/2026-10-04-parity-matrix-audit.md`.

**Sécurité — l'index ne voit plus les fichiers secrets ni ignorés :** le filtre des outils fichiers (`.env*`, `.git`, `.openagent`, `ignored_patterns`) et la liste des fichiers de clés des recherches (`secrets.json`, `credentials.json`, `id_rsa`…, `*.pem|key|p12|pfx`) vivent dans `core/file-filter.mts`, importé par `workspace.mts` et par l'index (jamais recopié) ; l'indexation automatique lit les `ignored_patterns` du projet ; la reconstruction purge l'ancien index, et supprime aussi la copie `codebase.json.pre-electron.bak` que `JsonStore` gardait de la première version (elle aurait conservé les morceaux secrets) ; `semantic_search` filtre encore à la lecture.

**Lignes fermées :** 2 (chemin tapé), 6 (cartes d'outil : détail, diff borné, nom/badge/détail après réouverture ; `name`/`category` jamais envoyés), 7 (Shift+Entrée, double envoi — défaut corrigé), 14 (toast d'échec par l'interface — défaut corrigé : enveloppe IPC), 16 (accent), 18 (`search_ask`), 30 (modifier puis réindexer). Preuves : la case de la liste ci-dessus.

**Décisions** : les 17 décisions de la section « Global Constraints » du plan, dont : l'index applique l'union filtre protégé + fichiers de clés (ce que cachent `grep_codebase`/`glob_files`) ; `read_file` reste inchangé ; détail par table d'outils, coupé à 120 caractères sans points de suspension ; diff borné marqueur compris (≤ 60 lignes, ≤ 4 000 caractères) ; badge neutre « OUTIL » pour une catégorie inconnue ou `extension` ; résultats de clôture (Stop) inchangés ; chemin tapé activé sous son chemin canonique ; Shift+Entrée prouvé par l'absence d'annulation (un événement synthétique n'insère pas de ligne).

**Vérifications finales (depuis `electron/`, 2026-10-05)** : suite complète une fois : <N>/<N> (781 + <ajoutés>), <durée> ; `tsc` cœur : les 5 erreurs préexistantes ; renderer : 0 ; `npm run package:win` : code 0 ; `npm run test:package`, une fois : <PASS/FAIL> ; tests à fenêtre, une fois chacun : `test:indexstatus` <…> (Tâche 1), `test:sidebar` <…> (Tâche 3), `test:chat` <…>, `test:export` <…>, `test:theme` <…> (Tâche 4) ; aucun processus `electron`/`openagent` laissé.

**Limites connues** :
- `read_file` lit encore `secrets.json` ou un `*.pem` par son nom (seules les recherches et l'index les cachent) — hors de ce lot ;
- le garde anti double envoi couvre le temps entre l'envoi et la réponse du worker ; les quelques millisecondes entre cette réponse et le rendu suivant ne le sont pas (hors de portée d'une touche humaine) ; le worker n'interdit toujours pas deux tours dans un même dossier ;
- l'export (`core/export.mts::detailFor`) garde la règle Python (path → command → query → arguments bruts), différente de la table des cartes ;
- un clic sur l'entrée du dossier déjà actif ne recharge pas la conversation ; `export-visual.cjs` s'appuie dessus à l'étape 1 sans que la lecture du code l'explique — non touché ;
- les résidus de la revue précédente restent hors scope (deux migrations d'affilée, redémarrage pendant une mise à jour prête ou une migration, export qui démarre les serveurs MCP, « Toujours » lié à la source de l'outil) ; modèles locaux HTTP (audit M4/M10).

**Commits et push** : Tâche 1 <hash>, Tâche 2 <hash>, Tâche 3 <hash>, Tâche 4 <hash>, clôture <hash>, poussés sur `origin/master` (`git status -sb` : `master...origin/master`, sans avance ni retard).
```

- [ ] **Step 6: Append the lessons to `tasks/lessons.md`**

Append these lines (format `date | ce qui a mal tourné | cause | règle`). Keep only those whose defect was confirmed by this lot's tests:

```markdown
2026-10-05 | L'index sémantique indexait `secrets.json` et les fichiers ignorés du projet, lisibles par le modèle via `semantic_search` | le filtre des outils fichiers était une fermeture locale de `workspaceTools()`, que l'index ne pouvait pas réutiliser ; il avait sa propre liste d'exclusions | Un filtre de sécurité vit dans un module partagé (`core/file-filter.mts`) importé par chaque lecteur ; jamais recopié, jamais enfermé dans un outil
2026-10-05 | La purge de l'index aurait laissé les morceaux secrets dans `codebase.json.pre-electron.bak` | `JsonStore.update` copie une fois pour toutes la première version de tout fichier qu'il réécrit | Un cache dérivé écrit par `JsonStore` supprime sa copie `.pre-electron.bak` à chaque reconstruction ; vérifier les copies de sauvegarde quand on purge une donnée sensible
2026-10-05 | Deux Entrée rapides, la zone re-remplie entre les deux, lançaient deux tours dans le même dossier | la garde ne lisait que `state.agentRunning`, vrai seulement après la réponse du worker, et le worker n'interdit pas deux tours | Une garde anti double envoi est un `ref` posé avant le premier `await` et vérifié avant de vider la zone, pas un état React
2026-10-05 | Le toast d'échec d'export affichait « Error invoking remote method 'backend-request': Error: … » | `performExport` affichait `error.message` sans `cleanIpcError` | Tout message d'erreur d'IPC affiché dans l'interface passe par `cleanIpcError`
```

- [ ] **Step 7: Commit and push the closure**

From the repository root:

```bash
git add tasks/todo.md tasks/lessons.md
git commit -m "docs: parity finishings delivered — matrix rows 2, 6, 7, 14, 16, 18 and 30 proven, secret and ignored files kept out of the semantic index; bilan and lessons" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
git status -sb
```

Expected: `## master...origin/master`, with no ahead or behind count. The user's unrelated docs changes are still listed as modified or untracked, untouched.

- [ ] **Step 8: Report, with BDC candidate drafts**

The final report to the user gives:
- the suite count;
- the tsc counts;
- each window test's single result;
- the commits;
- the header as written;
- the limits;
- the drafts below for `D:\BDC`. They are **drafts in the report only**: nothing is written to `D:\BDC`, and the user decides.
  - Drop a draft whose proof did not pass.
  - Search `D:\BDC` for an existing note on the same fact before proposing it, per the user's rules, and say if one exists.

Draft 1:

```markdown
---
statut: vérifié
source: dépôt openagent, core/json-store.mts + test « indexFolder never indexes a secret file… » (2026-10-05)
---
# Une sauvegarde « première version » d'un cache dérivé conserve ce que la purge retire

Un écrivain JSON atomique qui copie une seule fois l'original avant la première réécriture (`<fichier>.pre-electron.bak`, `COPYFILE_EXCL`) garde indéfiniment la PREMIÈRE version de tout fichier qu'il gère. Pour une donnée utilisateur, c'est voulu. Pour un cache reconstruit (index sémantique), cette copie conserve ce qu'une purge ultérieure retire — y compris des morceaux de fichiers secrets indexés avant l'ajout d'un filtre.

Règle : un cache dérivé supprime sa copie de sauvegarde à chaque reconstruction ; toute purge d'une donnée sensible vérifie aussi les copies de sauvegarde.

Comment on le sait : lecture de `JsonStore.update` (copie `COPYFILE_EXCL` avant écriture) ; le test de l'index a vérifié qu'après reconstruction le dossier de l'index ne contient plus que `codebase.json`.
```

Draft 2:

```markdown
---
statut: vérifié
source: spécification UI Events (W3C) — « untrusted events » ; observé dans chat-visual.cjs (2026-10-05)
---
# Un événement clavier synthétique n'exécute pas l'action par défaut du navigateur

`el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))` déclenche les écouteurs mais n'insère aucune ligne dans un `<textarea>` : un événement non fiable (`isTrusted === false`) ne déclenche pas d'action par défaut (seul `click` fait exception). Pour tester « Shift+Entrée ajoute une ligne », vérifier que l'application n'annule PAS l'événement (`event.defaultPrevented === false`) et qu'aucun effet (envoi) n'a lieu ; pour une vraie saisie, il faut des événements d'entrée natifs (Electron `webContents.sendInputEvent`, fenêtre focalisable).

Comment on le sait : spécification UI Events, section sur les événements non fiables ; observé : la valeur du champ inchangée après le `keydown` synthétique.
```

Draft 3:

```markdown
---
statut: vérifié
source: Electron 44.4.2, dépôt openagent (renderer-src/src/ipc/errors.ts, export-visual.cjs, 2026-10-05)
---
# Electron : une promesse rejetée par ipcMain.handle arrive préfixée dans le renderer

L'erreur que reçoit `ipcRenderer.invoke` quand le gestionnaire `ipcMain.handle` rejette porte le message `Error invoking remote method '<canal>': Error: <message d'origine>`. Tout message destiné à l'utilisateur doit retirer ce préfixe (ex. `raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')`).

Comment on le sait : le toast d'échec d'export l'affichait tel quel (test `export-ui.test.mts` puis `export-visual.cjs` étape 9, Electron 44.4.2).
```

Draft 4:

```markdown
---
statut: vérifié
source: dépôt openagent, InputBar.tsx + chat-visual.cjs étape 8 (React 19, 2026-10-05)
---
# React : une garde anti double envoi est un ref posé avant le premier await, pas un état

Deux gestionnaires d'événements exécutés dans le même tick voient le même état React : un `state.running` qui ne passe à vrai qu'après une réponse asynchrone (IPC, réseau) laisse passer un second envoi. Un `useRef` mis à `true` de façon synchrone avant le premier `await`, et vérifié avant de vider le champ, ferme la fenêtre ; le texte tapé entre-temps reste dans le champ.

Comment on le sait : deux `keydown` Entrée synchrones (champ re-rempli entre les deux) ne produisent plus qu'une requête au faux serveur (`chat-visual.cjs`).
```

---

## Self-Review

**Spec coverage:**
- Row 2:
  - the field and the button: Task 3 Step 5;
  - Enter: Step 5 `onKeyDown`;
  - refusal toasts, nothing activated: Step 7 loop;
  - the same `activate_folder`: Step 5 `activate(typed, true)`;
  - name, path and date asserted: Step 7.
- Row 6:
  - detail, cut to 120: Task 2 Steps 8-10 and the `tool-cards` tests;
  - diff, 60/4 000/marker: Task 2 Steps 5-6;
  - colour: `looksLikeDiff` kept, and `chat-visual` step 3;
  - `name`/`category` set by the agent loop: Step 7;
  - recovery for an old conversation, neutral badge: `withToolCards` and the neutral style;
  - never sent: `wireToolResult` plus the agent, worker and `chat-visual` assertions;
  - reload: `chat-visual` step 5;
  - old conversation: step 6.
- Row 30 and security:
  - same filter: Task 1 Steps 5-6;
  - purge: Step 7 plus the backup removal;
  - filter at read: `searchCollection` default plus `searchTools`;
  - modify-then-search: Step 2;
  - the worker wiring: Step 9 and the worker tests.
- Row 7: `chat-visual` steps 7-9, plus the InputBar fix.
- Row 14: `export-visual` step 9, plus the `export.ts` fix.
- Row 16: `theme-visual`.
- Row 18: the `worker-tools` `search_ask` test.
- Tests list:
  - each spec bullet has its test, named in Task 5 Step 4;
  - full suite, tsc, package and visual tests: each once, in their tasks plus Task 5.
- Closure: matrix box with named tests; header rule; bilan; lessons; BDC drafts in the report; push.
- Hors scope: untouched, and listed in the bilan.

**Placeholder scan:**
- Every code step has its full code.
- Task 5's bilan contains `<N>`, `<durée>`, `<hash>` and `<PASS/FAIL>`. These are values measured at execution, which the step tells the executor to fill. They are not code placeholders.

**Type consistency:**
- `searchExclusion` / `protectedPathMatcher` / `SENSITIVE_FILE`: the same names in `file-filter.mts`, `workspace.mts`, `semantic-index.mts`, `search-tools.mts` and the tests.
- `indexFolder(folder, home, onProgress?, ignoredPatterns = '')`: the worker passes the patterns 4th.
- `searchCollection(…, n, excluded)`: `search-tools` passes `excluded` 5th.
- `unifiedDiff` / `boundedDiff` / `DIFF_*`: the same in the module, `workspace.mts` and the tests.
- `toolDetail` / `callsById` / `toolCard` / `withToolCards` / `RenderedMessage` / `TOOL_DETAIL_MAX`: the same in `tool-cards.ts`, `reducer.ts` and the tests.
- `ToolMeta.detail`: used by `ChatView` as `meta.detail`.
- `ToolMessage`'s `detail` prop and its DOM test ids are the ones `chat-visual` reads.
- `activateFolder`'s reply `folder` is the same in the worker, `bridge.ts`, `Sidebar.tsx` and the `sidebar-visual` stub.
