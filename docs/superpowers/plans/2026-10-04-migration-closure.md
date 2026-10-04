# Migration Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Python app's data safe in the Electron app (R1–R4), close the three real parity gaps (window close → tray, `.py` plugins reported, the Outils tab never starts an MCP server), then close the migration checklist in `tasks/todo.md`.

**Architecture:**
- **Data (R1, R2, R4).** `core/folders.mts` stores every folder under one canonical key and merges duplicates on read. Retention (`core/cleanup.mts`) and the data-home migration (`core/data-dir.mts`) both move files through one new module, `core/safe-move.mts`: one `rename` on the same drive, otherwise a copy checked byte for byte, then removal of the source. `main.cjs` resolves the data home exactly as the worker does, so the vault follows a migration.
- **Display (R3).** The worker normalises `ai`/`human` to `assistant`/`user` everywhere it serves a history to the screen. It never rewrites the file on a read.
- **Window (gap 1).** In `main.cjs`, the window's `close` hides it unless `before-quit` has fired. Every real quit (`app.quit()` from the tray, electron-updater's `quitAndInstall`, CDP `Browser.close`) goes through `before-quit`. A Windows session end does not; Electron 44 ends the process itself.
- **Extensions (gaps 2, 3).** `core/plugin-loader.mts` reports `.py` files without importing them. `core/mcp-client.mts` returns each server's tool names. The worker remembers those names per server after each turn, and serves them to the Outils tab without starting anything.

**Tech Stack:**
- Electron 44.4.2 and Node 24: `--experimental-strip-types`, `worker_threads`, `node:test`.
- React 19, Vite 8, TypeScript 7.
- electron-builder 26 (NSIS).
- PowerShell 5.1 for the Win32 window messages in the end-to-end test.

**Spec:** `docs/superpowers/specs/2026-10-04-migration-closure-design.md` is the authority. The `file:line` evidence for gaps 1, 32 and 33 is in `docs/superpowers/specs/2026-10-04-parity-matrix-audit.md`.

## Global Constraints

- **Real tests, no mocks, RED first.** Use real files in a `mkdtemp` folder, a real `worker.mjs` in a `worker_threads` Worker, and the real MCP test server `tests/fixtures/fake-mcp-server.cjs`, which writes a witness file when it starts (`FAKE_MCP_MARKER`). UI proofs use real Electron windows, and the window lifecycle uses the real packaged executable. Every unit or worker test is run and seen failing before the implementation is written.
- **Windows open once.** Every test that opens a window (`*-visual.cjs`, `final-e2e*.cjs`, `test:package`) runs **once**. The user explicitly asked for this. On failure, report the output and stop; never re-run in a loop.
  - These tests are therefore not run RED. The RED proof of each change is its unit or worker test.
  - Each window test runs in the task that touches it, after the implementation. Task 5 does not run it again.
- **No user data.** The user's real data home (`%USERPROFILE%\.openagent`) and real projects are **never** touched.
  - Every worker gets `OPENAGENT_HOME=<temp>`. A worker thread's `os.homedir()` still reads the real OS environment, so a worker never runs without `OPENAGENT_HOME`.
  - `resolveMainDataHome` is tested with an explicit temporary user home.
- **Commits.**
  - Each task commits only its own files, with explicit `git add <paths>`, never `git add -A` or `git add .`.
  - The repository has unrelated uncommitted user docs changes that must stay untouched:
    - `docs/superpowers/plans/2026-04-27-*.md` (deleted);
    - `liste logique à suivre.txt`;
    - `docs/superpowers/specs/2026-09-14-electron-autonomous-design.md`;
    - the untracked `OK …` and `native-desktop` / `mcp-enhancement` files.
  - Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, passed as a last `-m` paragraph.
  - Push after each task's commit (`git push origin master`), per the user's standing instruction.
- **Registration and suite.**
  - Every new `*.test.mts` file is registered in `electron/tests/all.mts` as a new last line `import './<file>';`.
  - The full suite runs from `electron/` with `node --experimental-strip-types --test tests/all.mts`.
  - The **baseline is 726/726**. This lot adds 25 tests, so the expected total is **751/751**: Task 1 adds 10, Task 2 adds 8, Task 3 adds 1 and Task 4 adds 6.
- **tsc baselines.**
  - `npx tsc --noEmit -p tsconfig.core.json` shows the **5 pre-existing errors only**: local-engine.mts, local-provider.mts, pdf-loader.ts, local-provider.test.mts ×2.
  - `npx tsc --noEmit -p renderer-src/tsconfig.json` shows **0**.
- **Strings.** UI and log strings are French and exact. These come from the spec:
  - `Plugin Python non pris en charge : <nom>.py — à réécrire en .mjs`, where `<nom>.py` is the file name without its folder.
  - `non démarré — ses outils seront chargés au prochain message`.
  - The archive path is `<dossier de données>/retention-archive/<AAAA-MM-JJ>/<nom du projet>-<8 premiers caractères du SHA-256 du chemin canonique>/`.
  - The Contexte sentence chosen by this plan is `L’historique d’un projet inutilisé au-delà de cette durée est archivé dans le dossier de données (retention-archive), jamais supprimé.`
- **Packaging.** Any new file required by `main.cjs` goes into `build.files` in the same commit, and `npm run test:package` proves it.
  - This plan adds **no** such file. The tray menu template goes into `tray-icon.cjs`, which is already listed. `main.cjs` dynamically imports `core/data-dir.mts`, which is covered by `core/**/*`.
- **Rulings made while writing this plan.** Every task applies them, and the bilan lists them.
  1. **R1 key.** The key is `realpath` when the folder exists. Otherwise it is `path.resolve(path)`, which unifies separators and drops a trailing one; a relative entry is kept as written. Case is ignored under Windows (`toLowerCase()` of the key).
     - The entry kept is the canonical path. Its `last_used` is the most recent by **time** (`Date.parse`), not by string. Python wrote local `isoformat()` strings and Electron writes UTC `toISOString()`, so the strings do not compare.
     - `list()` sorts by time for the same reason.
     - `remove()` uses the same key.
  2. **R1 rewrite.** On a read, the file is rewritten (inside a `JsonStore.update` that merges again) only when the merged list differs from the valid entries as read. The existing `.pre-electron.bak` logic keeps the original and never overwrites it.
  3. **R2 day and hash.**
     - `<AAAA-MM-JJ>` is the **local** date of the cleanup run. The user is in France: a UTC date would put a run made just after midnight under the previous day.
     - The hash is the SHA-256 of the canonical path string as stored in `folders.json`.
  4. **R2 never overwrites.** If the archive already holds a file of that name, the move fails, the file stays in place, and the failure is logged (`[rétention] …`). The next day uses another folder.
  5. **R2 return value.** `cleanupOldFolders(folders, retentionDays, home, now = new Date())` returns `{ cleaned, failed }`.
     - The data home is a new parameter: the archive lives there.
     - `now` exists so a test can know the day.
  6. **R2 and R4 move one way, `core/safe-move.mts`.**
     - Same drive: `rename`.
     - `EXDEV`: copy (`cp` recursive for a folder), compare every file's SHA-256, then `rm` the source.
     - A copy that differs is removed and the source kept.
     - An existing destination is always refused, even though `rename` would replace a file under Windows.
     - This is a behaviour change for R4: a migration used to overwrite a same-named file in the new folder. It now reports it in `errors` and keeps both.
  7. **R3 serving points.** The spec names folder activation and branch loading. The `compacted` event also serves a history to the screen, so it is normalised too. `runSend` already normalised; it now shares the helper `servedMessages`.
  8. **R4 nested target.** A new folder chosen inside the current home is skipped as an entry. A folder that would contain the new folder is reported, not moved into itself.
  9. **R4 UI text.** The Général toast still says « fichier(s) migré(s) ». `moved` now counts top-level entries (a folder counts as one). `data-dir-visual.cjs` asserts `/migré/`, so the text is left unchanged rather than touching that test.
  10. **Gap 1 quit paths.**
      - Electron's CDP `Browser.close` calls `Browser::Get()->Quit()`, the same path as `app.quit()`. This was read in `shell/browser/ui/devtools_manager_delegate.cc` on Electron `main`.
      - `Browser::Quit` emits `before-quit`, then closes every window, and a cancelled close resets `is_quitting_` (`shell/browser/browser.cc`).
      - So `before-quit` sets `appQuitting = true` **before** its early return. The flag covers the tray's « Quitter », « Redémarrer maintenant » (electron-updater `BaseUpdater.quitAndInstall` → `this.app.quit()`, read in `node_modules`) and `Browser.close`.
  11. **Gap 1 session end.**
      - Electron 44.4.2 handles `WM_ENDSESSION` in `native_window_views_win.cc`, read at tag `v44.4.2`. It emits `session-end` on each window, then calls `TerminateCurrentProcessImmediately(0)` unless a quit is already in progress. No `close` event is involved, so the hide never blocks it.
      - No code is added for it, only a comment. The e2e test proves it by posting `WM_QUERYENDSESSION` then `WM_ENDSESSION`.
  12. **Gap 1, existing tests.** A grep found **no** existing test that closes the window and waits for the exit.
      - `final-e2e-lot3`…`lot13` quit with CDP `Browser.close`, which is `app.quit()` (ruling 10). `final-e2e`, `lot2`, `bridge-real`, `package-smoke`, `update-e2e` and `install-e2e` kill the process, quit through `quitAndInstall`, or leave it running.
      - The visual tests never load `main.cjs`: they build their own window and register `window-all-closed` as a no-op.
      - So no test is adapted. Their assertion message « the app exited after the window was closed » is now inaccurate wording. It is left alone so as not to re-run 11 packaged window tests for text, and the bilan records it.
  13. **Gap 1 tray clicks.** A native tray menu cannot be clicked from a test.
      - The menu becomes a pure template, `trayMenuTemplate({ open, quit })` in `tray-icon.cjs`. A unit test proves « Ouvrir openagent » → `open` and « Quitter » → `quit`.
      - In `main.cjs`, `open` is `showMainWindow` and `quit` is `() => app.quit()`.
      - The e2e test exercises both functions for real: a second launch calls `showMainWindow` (the `second-instance` handler), and `Browser.close` is `app.quit()`.
  14. **Gap 3 placement of the status.**
      - The spec says `plugin-list` « liste les serveurs MCP configurés sans les démarrer ». The Outils tab lists servers from `mcp-list`, so each `mcp-list` entry gets `tools: string[] | null`: `null` means no turn has started it; a list holds the names discovered by the last turn.
      - `plugin-list` no longer calls `nonPluginTools`. It checks plugin names against the built-in tools plus the remembered MCP names.
      - An untrusted project entry gets `tools: null` and shows no « non démarré » line: it stays « non approuvé ».
  15. **Gap 3 cache key.** The key is `serverIdentity` (command + args, or URL), now exported from `core/mcp-config.mts`. It is computed on the **expanded** config, as a turn runs it.
  16. **Gap 3 at quit.** MCP sessions are short-lived: one process per discovery and one per call, each killed with `killTree` right after use (`core/mcp-client.mts:36-86`). So only a call in flight can outlive the app.
      - Task 4 tests exactly that, through `main.cjs::stopWorker` on a real worker.
      - The fix (`stopAllMcpServers`) is applied **only if that test fails**, as the spec says. Its full code is in Task 4, Step 7.
  17. **Gap 2 scope.** `.py` files follow the same selection as `.mjs`: hidden files and `__init__*` are ignored, and project folders are scanned only once the project is trusted. A `.py` is never in the trust fingerprint, because it is never executed.
  18. **Closure.**
      - The « Vérifier chaque ligne de la matrice » box is rewritten to what the user decided: line-by-line check done, the three real gaps fixed. Then it is checked.
      - A **new open box** lists the finishing work of the 7 other partial lines. The spec puts those out of scope; they include line 6's reload regression, which is a real regression, not only a missing test.
      - The header therefore reads « LIVRÉE SAUF … » and names exactly that box.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `electron/core/safe-move.mts` | **create** | `moveEntry`, `copyThenRemove`, `sameContent`: lossless moves of a file or a tree, never over an existing path |
| `electron/core/folders.mts` | modify | canonical key, merge on read, single rewrite, dedupe in `recordOpened`/`remove`, sort by time |
| `electron/core/cleanup.mts` | rewrite | retention moves history files into `retention-archive/…` and never removes them |
| `electron/core/data-dir.mts` | modify | `migrateDataDir` moves every entry, folders included, through `moveEntry` |
| `electron/core/plugin-loader.mts` | modify | `.py` files reported with the exact error, never imported |
| `electron/core/mcp-client.mts` | modify | `mcpTools` also returns `servers: { target, toolNames }[]`; `stopAllMcpServers` only if Task 4's quit test fails |
| `electron/core/mcp-config.mts` | modify | export `serverIdentity` |
| `electron/worker.mjs` | modify | cleanup gets the data home; `servedMessages` (R3); `mcpToolNames` cache; `plugin-list` without MCP; `mcp-list` with `tools` |
| `electron/main.cjs` | modify | `resolveMainDataHome`; close hides; `appQuitting`; tray menu from the template; fixed comment |
| `electron/main.d.cts` | modify | declares `resolveMainDataHome` |
| `electron/tray-icon.cjs` | modify | `trayMenuTemplate({ open, quit })` |
| `electron/renderer-src/src/components/settings/ContextTab.tsx` | modify | retention sentence |
| `electron/renderer-src/src/components/settings/ToolsTab.tsx` | modify | per-server tools or « non démarré » line |
| `electron/renderer-src/src/ipc/bridge.ts` | modify | `tools?: string[] \| null` on server configs |
| `electron/package.json` | modify | `test:final-e2e-tray` script |
| `electron/tests/fixtures/fake-mcp-server.cjs` | modify | opt-in `FAKE_MCP_PID_FILE` and `FAKE_MCP_CALL_DELAY_MS` |
| tests | see each task | new: `safe-move.test.mts`, `main-data-home.test.mts`, `final-e2e-tray.cjs` |
| `tasks/todo.md`, `tasks/lessons.md` | modify | closure (Task 5) |

**Decomposition changes against the suggested one, and why:**
- **`core/safe-move.mts` is created in Task 1, not Task 2.** R2 (Task 1) and R4 (Task 2) need the same lossless move. Writing it once, with its own tests, in the first task that needs it avoids two copies of the rename/EXDEV/verify logic.
- **Task 3 creates no new `main.cjs` dependency.** The tray template goes into `tray-icon.cjs`, which is already in `build.files`. A `window-lifecycle.cjs` module would have added a packaging risk with no benefit, since the close handler needs `main.cjs`'s own quit state anyway.
- Otherwise the five tasks are as suggested.

---

### Task 1: R1 + R2 — folder history without duplicates, retention that archives

**Files:**
- Create: `electron/core/safe-move.mts`
- Create: `electron/tests/safe-move.test.mts`
- Modify: `electron/core/folders.mts` (whole file shown below)
- Rewrite: `electron/core/cleanup.mts`
- Modify: `electron/worker.mjs:86-89` (cleanup call)
- Modify: `electron/renderer-src/src/components/settings/ContextTab.tsx:94-107`
- Modify: `electron/tests/folders.test.mts` (imports + 4 tests appended)
- Modify: `electron/tests/cleanup.test.mts` (whole file shown below)
- Modify: `electron/tests/worker-cleanup.test.mts:1-47`
- Modify: `electron/tests/settings-tabs-visual.cjs:110` (one assertion)
- Modify: `electron/tests/all.mts` (register `safe-move.test.mts`)

**Interfaces:**
- Produces (`core/safe-move.mts`):
  - `moveEntry(src: string, dst: string): Promise<void>`: throws `la destination existe déjà` when `dst` exists. When it throws, `src` is intact.
  - `copyThenRemove(src: string, dst: string): Promise<void>`: the cross-drive path, exported for tests.
  - `sameContent(original: string, copy: string): Promise<boolean>`
- Produces (`core/folders.mts`):
  - `canonicalFolderPath(path: string): Promise<string>`
  - `folderKey(canonical: string): string`
  - `mergeFolderEntries(entries: { path: string; last_used: string }[]): Promise<{ path: string; last_used: string }[]>`
  - The `FoldersService` API is unchanged.
- Produces (`core/cleanup.mts`):
  - `ARCHIVE_DIR = 'retention-archive'`
  - `archiveDirectory(home: string, canonicalPath: string, date: Date): string`
  - `cleanupOldFolders(folders: FoldersService, retentionDays: number, home: string, now?: Date): Promise<{ cleaned: number; failed: number }>`
- Task 2 consumes `moveEntry` (R4).

- [ ] **Step 1: Write the failing `safe-move` tests**

Create `electron/tests/safe-move.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { removeAtEnd } from './teardown.mts';

const { moveEntry, copyThenRemove, sameContent } = await import('../core/safe-move.mts');

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-safe-move-'));
  removeAtEnd(t, root);
  return root;
}
/** A small tree with a binary file large enough to span several read chunks. */
async function seedTree(dir: string) {
  await mkdir(join(dir, 'sub', 'deeper'), { recursive: true });
  await writeFile(join(dir, 'a.json'), '{"a":1}');
  await writeFile(join(dir, 'sub', 'b.bin'), randomBytes(300_000));
  await writeFile(join(dir, 'sub', 'deeper', 'c.txt'), 'profond');
}
/** Every file under `dir`, by relative path, as base64 — two equal snapshots mean the same bytes everywhere. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[full.slice(dir.length)] = (await readFile(full)).toString('base64');
  }
  return out;
}

test('moveEntry moves a file and a whole directory tree on one drive, leaving nothing behind', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'f.txt'), 'contenu');
  await moveEntry(join(root, 'f.txt'), join(root, 'g.txt'));
  assert.equal(await readFile(join(root, 'g.txt'), 'utf8'), 'contenu');
  await assert.rejects(readFile(join(root, 'f.txt')), /ENOENT/);

  const src = join(root, 'tree');
  await seedTree(src);
  const before = await snapshot(src);
  await moveEntry(src, join(root, 'moved'));
  assert.deepEqual(await snapshot(join(root, 'moved')), before);
  await assert.rejects(readdir(src), /ENOENT/);
});

test('moveEntry never overwrites: an existing destination is refused and the source stays intact', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'mine.json'), 'mine');
  await writeFile(join(root, 'theirs.json'), 'theirs');
  await assert.rejects(moveEntry(join(root, 'mine.json'), join(root, 'theirs.json')), /la destination existe déjà/);
  assert.equal(await readFile(join(root, 'mine.json'), 'utf8'), 'mine');
  assert.equal(await readFile(join(root, 'theirs.json'), 'utf8'), 'theirs');
});

test('copyThenRemove — the path a move to another drive takes — copies every byte of a tree, checks it, then removes the source', async t => {
  const root = await fixture(t);
  const src = join(root, 'tree');
  await seedTree(src);
  const before = await snapshot(src);
  await copyThenRemove(src, join(root, 'copy'));
  assert.deepEqual(await snapshot(join(root, 'copy')), before);
  await assert.rejects(readdir(src), /ENOENT/);
  await writeFile(join(root, 'one.txt'), 'un');
  await writeFile(join(root, 'taken.txt'), 'pris');
  await assert.rejects(copyThenRemove(join(root, 'one.txt'), join(root, 'taken.txt')), /la destination existe déjà/);
  assert.equal(await readFile(join(root, 'one.txt'), 'utf8'), 'un', 'a refused copy keeps its source');
});

test('sameContent tells a faithful copy from one with a changed byte or a missing file', async t => {
  const root = await fixture(t);
  const a = join(root, 'a');
  await seedTree(a);
  await copyThenRemove(a, join(root, 'b'));
  await seedTree(a);
  const b = join(root, 'b');
  // seedTree writes a NEW random b.bin: a and b now differ in that file only.
  assert.equal(await sameContent(a, b), false, 'one changed file is enough to differ');
  await writeFile(join(b, 'sub', 'b.bin'), await readFile(join(a, 'sub', 'b.bin')));
  assert.equal(await sameContent(a, b), true);
  await writeFile(join(a, 'extra.txt'), 'x');
  assert.equal(await sameContent(a, b), false, 'a file missing from the copy is a difference');
});
```

Append to `electron/tests/all.mts`:

```typescript
import './safe-move.test.mts';
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/safe-move.test.mts`
Expected: FAIL, with `Cannot find module` naming `core/safe-move.mts`.

- [ ] **Step 3: Implement `core/safe-move.mts`**

Create `electron/core/safe-move.mts`:

```typescript
import { constants, createReadStream } from 'node:fs';
import { copyFile, cp, lstat, readdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

function digest(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** True when `copy` holds exactly what `original` holds: the same names at every level, the same bytes in every file
 * (compared by SHA-256, streamed — a data home can hold large files). A link has no bytes of its own to compare. */
export async function sameContent(original: string, copy: string): Promise<boolean> {
  const info = await lstat(original);
  let other: import('node:fs').Stats;
  try { other = await lstat(copy); } catch { return false; }
  if (info.isDirectory()) {
    if (!other.isDirectory()) return false;
    const [left, right] = await Promise.all([readdir(original), readdir(copy)]);
    if (left.length !== right.length) return false;
    const names = new Set(right);
    for (const name of left) {
      if (!names.has(name) || !(await sameContent(join(original, name), join(copy, name)))) return false;
    }
    return true;
  }
  if (info.isFile()) return other.isFile() && info.size === other.size && (await digest(original)) === (await digest(copy));
  return true;
}

/** The half of a move that crosses drives: copy, check every byte, then remove the source. A copy that fails or
 * differs is removed and the source kept — nothing is ever lost. Exported so a test can drive it on one drive. */
export async function copyThenRemove(src: string, dst: string): Promise<void> {
  if (await exists(dst)) throw new Error('la destination existe déjà');
  const info = await lstat(src);
  try {
    if (info.isDirectory()) await cp(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    else await copyFile(src, dst, constants.COPYFILE_EXCL);
    if (!(await sameContent(src, dst))) throw new Error('copie différente de l’original');
  } catch (error) {
    await rm(dst, { recursive: true, force: true });
    throw error;
  }
  await rm(src, { recursive: true });
}

/** Moves a file or a whole directory, never over something already at `dst` (fs.rename would replace a file under
 * Windows). Same drive: one rename. Another drive (EXDEV): copyThenRemove. When it throws, `src` is still in place. */
export async function moveEntry(src: string, dst: string): Promise<void> {
  if (await exists(dst)) throw new Error('la destination existe déjà');
  try {
    await rename(src, dst);
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error;
    await copyThenRemove(src, dst);
  }
}
```

- [ ] **Step 4: Run the `safe-move` tests**

Run: `cd electron && node --experimental-strip-types --test tests/safe-move.test.mts`
Expected: 4/4 PASS.

- [ ] **Step 5: Write the failing R1 tests**

In `electron/tests/folders.test.mts`, line 3, replace:

```typescript
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
```

with:

```typescript
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, stat } from 'node:fs/promises';
```

Append to `electron/tests/folders.test.mts`:

```typescript
test('R1: a folder recorded by Python (C:/…) and by this app (C:\\…) is ONE entry with the most recent date, written back once', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  const original = JSON.stringify([
    { path: real.replaceAll('\\', '/'), last_used: '2026-08-01T10:00:00.123456' },
    { path: real, last_used: '2026-10-03T08:00:00.000Z' },
  ], null, 2);
  await writeFile(join(home, 'folders.json'), original);
  const { FoldersService } = await import('../core/folders.mts');
  const service = new FoldersService(home);
  const list = await service.list();
  assert.deepEqual(list.map(entry => [entry.path, entry.last_used]), [[real, '2026-10-03T08:00:00.000Z']]);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'folders.json'), 'utf8')), [{ path: real, last_used: '2026-10-03T08:00:00.000Z' }], 'rewritten normalised');
  assert.equal(await readFile(join(home, 'folders.json.pre-electron.bak'), 'utf8'), original, 'the original is kept byte for byte');
  const written = (await stat(join(home, 'folders.json'))).mtimeMs;
  await service.list();
  assert.equal((await stat(join(home, 'folders.json'))).mtimeMs, written, 'written once: a merged file is not rewritten again');
});

test('R1: the most recent date wins whichever spelling holds it — compared as times, not as strings', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  // Python wrote local time without a zone; this app writes UTC. 2026-10-03T23:30 local is after 2026-10-03T08:00Z.
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: real, last_used: '2026-10-03T08:00:00.000Z' },
    { path: real.replaceAll('\\', '/'), last_used: '2026-10-03T23:30:00.000001' },
  ]));
  const { FoldersService } = await import('../core/folders.mts');
  assert.deepEqual((await new FoldersService(home).list()).map(entry => [entry.path, entry.last_used]), [[real, '2026-10-03T23:30:00.000001']]);
});

test('R1: recordOpened with the Python spelling of a known folder does not create a duplicate', async t => {
  const { home, a } = await fixture(t);
  const real = await realpath(a);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: real, last_used: '2026-01-01T00:00:00.000Z' }]));
  const { FoldersService } = await import('../core/folders.mts');
  const list = await new FoldersService(home).recordOpened(real.replaceAll('\\', '/'));
  assert.equal(list.length, 1);
  assert.equal(list[0].path, real);
  assert.notEqual(list[0].last_used, '2026-01-01T00:00:00.000Z', 'the date moved to now');
});

test('R1: two spellings of a folder that no longer exists merge too (separators, and case under Windows)', { skip: process.platform !== 'win32' }, async t => {
  const { home, root } = await fixture(t);
  const gone = join(root, 'Disparu', 'projet');
  await writeFile(join(home, 'folders.json'), JSON.stringify([
    { path: gone.replaceAll('\\', '/').toUpperCase(), last_used: '2026-01-01T00:00:00.000Z' },
    { path: gone + '\\', last_used: '2026-02-01T00:00:00.000Z' },
  ]));
  const { FoldersService } = await import('../core/folders.mts');
  const list = await new FoldersService(home).list();
  assert.equal(list.length, 1);
  assert.equal(list[0].last_used, '2026-02-01T00:00:00.000Z');
  assert.equal(list[0].path.toLowerCase(), gone.toLowerCase(), 'stored resolved, with \\ and no trailing separator');
});
```

- [ ] **Step 6: Write the failing R2 and cleanup tests**

Replace the whole of `electron/tests/cleanup.test.mts` with:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const old = join(root, 'old-project');
  const recent = join(root, 'recent-project');
  await Promise.all([home, old, recent].map(p => mkdir(p)));
  return { root, home, old, recent };
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
/** The local calendar day, as the archive names its folders (ruling 3). */
function localDay(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** <home>/retention-archive/<AAAA-MM-JJ>/<nom>-<8 premiers caractères du SHA-256 du chemin canonique>, computed here
 * independently of the module under test. */
async function expectedArchive(home: string, folder: string, now: Date) {
  const canonical = await realpath(folder);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return join(home, 'retention-archive', localDay(now), `${canonical.split(/[\\/]/).pop()}-${hash}`);
}

async function seedFoldersJson(home: string, entries: Array<{ path: string; last_used: string }>) {
  await writeFile(join(home, 'folders.json'), JSON.stringify(entries, null, 2));
}

async function seedConversation(folder: string) {
  const dir = join(folder, '.openagent');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'conversations.json'), JSON.stringify({ version: 1, branches: [{ id: 'main', label: 'Principale', messages: [{ role: 'user', content: 'salut' }], created_at: new Date().toISOString() }] }, null, 2));
}

test('R2: an expired project\'s history files are MOVED to <home>/retention-archive/<day>/<name>-<sha8>/, byte for byte; a recent one is untouched', async t => {
  const { home, old, recent } = await fixture(t);
  await seedFoldersJson(home, [
    { path: old, last_used: daysAgo(40) },
    { path: recent, last_used: daysAgo(1) },
  ]);
  await seedConversation(old);
  await seedConversation(recent);
  await writeFile(join(old, '.openagent', 'chat_history.json'), JSON.stringify([{ role: 'human', content: 'ancien' }]));
  const before = {
    current: await readFile(join(old, '.openagent', 'conversations.json')),
    legacy: await readFile(join(old, '.openagent', 'chat_history.json')),
  };
  const now = new Date();
  const target = await expectedArchive(home, old, now);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home, now);
  assert.deepEqual(result, { cleaned: 1, failed: 0 });
  assert.deepEqual((await readdir(target)).sort(), ['chat_history.json', 'conversations.json']);
  assert.deepEqual(await readFile(join(target, 'conversations.json')), before.current);
  assert.deepEqual(await readFile(join(target, 'chat_history.json')), before.legacy);
  await assert.rejects(readFile(join(old, '.openagent', 'conversations.json')), /ENOENT/);
  await assert.rejects(readFile(join(old, '.openagent', 'chat_history.json')), /ENOENT/);
  await assert.doesNotReject(readFile(join(recent, '.openagent', 'conversations.json')));
});

test('R2: a move that fails leaves the file in place, counts it as failed, and deletes nothing', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(40) }]);
  await seedConversation(old);
  const before = await readFile(join(old, '.openagent', 'conversations.json'));
  // The archive path is impossible: retention-archive is a FILE, so no folder can be created under it.
  await writeFile(join(home, 'retention-archive'), 'pas un dossier');
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home);
  assert.deepEqual(result, { cleaned: 0, failed: 1 });
  assert.deepEqual(await readFile(join(old, '.openagent', 'conversations.json')), before, 'still there, byte for byte');
});

test('R1 + R2: a project whose OLD Python entry expired but which was opened yesterday is left alone; a truly expired one is archived', async t => {
  const { home, old, recent } = await fixture(t);
  const recentReal = await realpath(recent);
  await seedFoldersJson(home, [
    { path: recentReal.replaceAll('\\', '/'), last_used: '2026-01-01T09:00:00.000001' }, // written by Python, long ago
    { path: recentReal, last_used: daysAgo(1) },                                          // written by this app yesterday
    { path: old, last_used: daysAgo(40) },
  ]);
  await seedConversation(recent);
  await seedConversation(old);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home);
  assert.deepEqual(result, { cleaned: 1, failed: 0 });
  await assert.doesNotReject(readFile(join(recent, '.openagent', 'conversations.json')), 'the merged entry is recent: nothing touched');
  await assert.rejects(readFile(join(old, '.openagent', 'conversations.json')), /ENOENT/);
});

test('cleanupOldFolders is a no-op when retentionDays is 0 (never)', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  await seedConversation(old);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 0, home);
  assert.deepEqual(result, { cleaned: 0, failed: 0 });
  await assert.doesNotReject(readFile(join(old, '.openagent', 'conversations.json')));
});

test('cleanupOldFolders skips a folder that no longer exists on disk without throwing', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  await seedConversation(old);
  await rm(old, { recursive: true, force: true });
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const result = await cleanupOldFolders(new FoldersService(home), 30, home);
  assert.deepEqual(result, { cleaned: 0, failed: 0 });
});

test('cleanupOldFolders leaves the folder history entry itself intact (only the conversation data is archived)', async t => {
  const { home, old } = await fixture(t);
  await seedFoldersJson(home, [{ path: old, last_used: daysAgo(400) }]);
  await seedConversation(old);
  const { FoldersService } = await import('../core/folders.mts');
  const { cleanupOldFolders } = await import('../core/cleanup.mts');
  const folders = new FoldersService(home);
  await cleanupOldFolders(folders, 30, home);
  const list = await folders.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].path, await realpath(old));
});
```

The last test now compares against `realpath(old)`. Stored entries are canonical after R1, and `mkdtemp` under `%TEMP%` can differ from its realpath (8.3 short names).

In `electron/tests/worker-cleanup.test.mts`, replace lines 1-47 (the imports, `callWorker`, `daysAgo` and the first test) with:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `test-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
function localDay(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test('worker startup ARCHIVES (never deletes) the conversation data of a project unused beyond the configured retention', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-cleanup-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const old = join(root, 'old-project');
  await Promise.all([mkdir(home), mkdir(old)]);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: old, last_used: daysAgo(400) }], null, 2));
  await mkdir(join(old, '.openagent'), { recursive: true });
  await writeFile(join(old, '.openagent', 'conversations.json'), JSON.stringify({ version: 1, branches: [{ id: 'main', label: 'Principale', messages: [{ role: 'user', content: 'vieux message' }], created_at: new Date().toISOString() }] }, null, 2));
  const original = await readFile(join(old, '.openagent', 'conversations.json'));
  const canonical = await realpath(old);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  });
  terminateAtEnd(t, worker);

  // The default retention is 30 days; a real op round-trip proves the worker has finished its
  // (awaited) startup cleanup before answering.
  const list = await callWorker(worker, 'list_folders', {});
  assert.equal(list.length, 1, 'the folder history entry itself must survive the cleanup');
  await assert.rejects(readFile(join(old, '.openagent', 'conversations.json')));
  const archived = join(home, 'retention-archive', localDay(new Date()), `old-project-${createHash('sha256').update(canonical).digest('hex').slice(0, 8)}`, 'conversations.json');
  assert.deepEqual(await readFile(archived), original, 'moved into the archive of the data home, byte for byte');
});
```

The second test, `…leaves conversation data alone when session_retention_days is 0`, stays as it is.

- [ ] **Step 7: Run them to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/folders.test.mts tests/cleanup.test.mts tests/worker-cleanup.test.mts`

Expected failures:
- The four `R1:` tests in `folders.test.mts` fail, with two entries listed instead of one.
- All the `cleanup.test.mts` tests fail on `deepEqual` of the result: the current function returns `{ cleaned }` with no `failed`, and deletes instead of archiving.
- The first `worker-cleanup` test fails with `ENOENT` on the archived file.

- [ ] **Step 8: Implement R1 in `core/folders.mts`**

Replace the whole of `electron/core/folders.mts` with:

```typescript
import { isAbsolute, join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { JsonStore } from './json-store.mts';

interface FolderEntry {
  path: string;
  last_used: string;
}
export interface FolderListItem extends FolderEntry {
  name: string;
}

const MAX_ENTRIES = 50;

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

function isValidEntry(value: unknown): value is FolderEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === 'string' && candidate.path.length > 0 && typeof candidate.last_used === 'string';
}

/** The path a folder is stored under: its real path when it exists, else the absolute path resolved (separators
 * unified, no trailing one) — `C:/a/b` written by the Python app and `C:\a\b` written by this app are one folder.
 * A relative entry (never written by either app) is kept as is: resolving it against the cwd would invent a folder. */
export async function canonicalFolderPath(path: string): Promise<string> {
  if (!isAbsolute(path)) return path;
  try { return await realpath(path); }
  catch { return resolve(path); }
}

/** Two spellings of one folder share this key: case is ignored under Windows, like its file system. */
export function folderKey(canonical: string): string {
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** last_used as a time: Python wrote local `isoformat()` strings, this app writes UTC — strings do not compare. */
function time(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** One entry per folder: duplicates are merged on the canonical key, keeping the canonical path and the most recent
 * last_used (as a time). First occurrence order is kept. */
export async function mergeFolderEntries(entries: FolderEntry[]): Promise<FolderEntry[]> {
  const byKey = new Map<string, FolderEntry>();
  for (const entry of entries) {
    const path = await canonicalFolderPath(entry.path);
    const key = folderKey(path);
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { path, last_used: entry.last_used });
    else if (time(entry.last_used) > time(seen.last_used)) seen.last_used = entry.last_used;
  }
  return [...byKey.values()];
}

async function mergedFrom(current: unknown): Promise<FolderEntry[]> {
  return mergeFolderEntries(Array.isArray(current) ? current.filter(isValidEntry) : []);
}

/** Recently-opened project folders, shown in the sidebar history. */
export class FoldersService {
  private home: string;
  private store = new JsonStore();
  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.home = home;
  }
  private path() {
    return join(this.home, 'folders.json');
  }
  private async validEntries(): Promise<FolderEntry[]> {
    const raw = await this.store.read<unknown>(this.path(), []);
    if (!Array.isArray(raw)) return [];
    const valid = raw.filter(isValidEntry).map(({ path, last_used }) => ({ path, last_used }));
    const merged = await mergeFolderEntries(valid);
    // R1: a folder recorded twice (the Python app wrote C:/…, this app C:\…), or once under a spelling that is not its
    // canonical one, is written back once, merged. JsonStore keeps the original as folders.json.pre-electron.bak.
    if (JSON.stringify(merged) !== JSON.stringify(valid)) await this.store.update<unknown>(this.path(), [], mergedFrom);
    return merged;
  }
  async list(): Promise<FolderListItem[]> {
    const entries = await this.validEntries();
    return entries
      .slice()
      .sort((a, b) => {
        const difference = time(b.last_used) - time(a.last_used);
        return Number.isNaN(difference) ? 0 : difference;
      })
      .map(entry => ({ path: entry.path, name: folderName(entry.path), last_used: entry.last_used }));
  }
  /** Forgets a folder in the sidebar history only — the project's files are never touched. */
  async remove(folder: string): Promise<FolderListItem[]> {
    const key = folderKey(await canonicalFolderPath(folder));
    await this.store.update<unknown>(this.path(), [], async current => (await mergedFrom(current)).filter(entry => folderKey(entry.path) !== key));
    return this.list();
  }
  async recordOpened(folder: string): Promise<FolderListItem[]> {
    if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
    let canonical: string;
    try {
      canonical = await realpath(folder);
    } catch {
      throw new Error('Dossier introuvable');
    }
    if (!(await lstat(canonical)).isDirectory()) throw new Error('Dossier introuvable');
    const now = new Date().toISOString();
    const key = folderKey(canonical);
    await this.store.update<unknown>(this.path(), [], async current => {
      const entries = (await mergedFrom(current)).filter(entry => folderKey(entry.path) !== key);
      entries.unshift({ path: canonical, last_used: now });
      return entries.slice(0, MAX_ENTRIES);
    });
    return this.list();
  }
}
```

- [ ] **Step 9: Implement R2 in `core/cleanup.mts`**

Replace the whole of `electron/core/cleanup.mts` with:

```typescript
import { lstat, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { metadataDirectory } from './json-store.mts';
import { moveEntry } from './safe-move.mts';
import type { FoldersService } from './folders.mts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_FILES = ['conversations.json', 'chat_history.json'];
export const ARCHIVE_DIR = 'retention-archive';

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `<home>/retention-archive/<AAAA-MM-JJ>/<nom du projet>-<8 premiers caractères du SHA-256 du chemin canonique>`.
 * The day is local (the cleanup's own day); the hash keeps two projects of the same name apart. */
export function archiveDirectory(home: string, canonicalPath: string, date: Date): string {
  const name = canonicalPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'projet';
  const hash = createHash('sha256').update(canonicalPath).digest('hex').slice(0, 8);
  return join(home, ARCHIVE_DIR, localDay(date), `${name}-${hash}`);
}

async function present(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

/**
 * Archives — never deletes — the conversation history (conversations.json, the Python app's chat_history.json) of
 * every project whose `last_used` is older than `retentionDays`: the files are MOVED into the data home's
 * retention-archive/ (core/safe-move.mts: rename, or a copy checked byte for byte across drives). A move that fails
 * leaves the file where it was and is logged. The folder-history entry itself is never touched, and nothing ever
 * empties retention-archive/. `retentionDays <= 0` means "keep forever" (no-op), the setting's `0` choice.
 */
export async function cleanupOldFolders(folders: FoldersService, retentionDays: number, home: string, now: Date = new Date()): Promise<{ cleaned: number; failed: number }> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { cleaned: 0, failed: 0 };
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  let cleaned = 0;
  let failed = 0;
  for (const entry of await folders.list()) {
    if (new Date(entry.last_used).getTime() >= cutoff) continue;
    let dir: string;
    try { dir = await metadataDirectory(entry.path); }
    catch { continue; }
    const target = archiveDirectory(home, entry.path, now);
    let moved = 0;
    for (const name of HISTORY_FILES) {
      const file = join(dir, name);
      try {
        if (!(await present(file))) continue;
        await mkdir(target, { recursive: true });
        await moveEntry(file, join(target, name));
        moved++;
      } catch (error) {
        failed++;
        console.error(`[rétention] ${file} n’a pas pu être archivé, il reste en place : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (moved) cleaned++;
  }
  return { cleaned, failed };
}
```

In `electron/worker.mjs`, replace lines 86-89:

```javascript
// Wipes conversation data of projects unused beyond session_retention_days (0 = keep forever).
// Run once at startup, before the worker starts taking requests — mirrors the previous NiceGUI
// app's own synchronous startup cleanup. Never let a corrupt config/folders file crash the worker.
await cleanupOldFolders(folders, (await settings.global().catch(() => ({ session_retention_days: 0 }))).session_retention_days).catch(() => {});
```

with:

```javascript
// Archives (core/cleanup.mts: moves into <dataHome>/retention-archive/, never deletes) the conversation history of
// projects unused beyond session_retention_days (0 = keep forever). Run once at startup, before the worker starts
// taking requests. Never let a corrupt config/folders file crash the worker.
await cleanupOldFolders(folders, (await settings.global().catch(() => ({ session_retention_days: 0 }))).session_retention_days, dataHome).catch(() => {});
```

- [ ] **Step 10: Run the R1/R2 tests and the folder-history neighbours**

Run: `cd electron && node --experimental-strip-types --test tests/safe-move.test.mts tests/folders.test.mts tests/cleanup.test.mts tests/worker-cleanup.test.mts tests/worker-folders.test.mts tests/worker-danger.test.mts tests/storage.test.mts`
Expected: all PASS.

- [ ] **Step 11: The Contexte sentence**

In `electron/renderer-src/src/components/settings/ContextTab.tsx`, replace:

```tsx
              <option value={0}>Indéfiniment</option>
            </select>
          </Row>
        </Group>
```

with:

```tsx
              <option value={0}>Indéfiniment</option>
            </select>
          </Row>
          <p data-testid="oa-retention-note" className="px-4 pb-3 text-xs text-gray-600">
            L’historique d’un projet inutilisé au-delà de cette durée est archivé dans le dossier de données (retention-archive), jamais supprimé.
          </p>
        </Group>
```

In `electron/tests/settings-tabs-visual.cjs`, after line 110 (`await setValue(q('session_retention_days'), 90);`), insert:

```javascript
    assert.equal(
      await js(`document.querySelector('[data-testid="oa-retention-note"]')?.textContent`),
      'L’historique d’un projet inutilisé au-delà de cette durée est archivé dans le dossier de données (retention-archive), jamais supprimé.',
      'the retention choice says history is archived, not deleted (R2)',
    );
```

- [ ] **Step 12: Type-check and build the renderer**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json; npx tsc --noEmit -p renderer-src/tsconfig.json; npm run renderer:build`
Expected:
- core shows the 5 pre-existing errors only;
- renderer shows 0;
- the Vite build exits 0.

- [ ] **Step 13: Run the touched window test ONCE**

Run: `cd electron && npm run test:settings-tabs`
Expected: a `PASS` line and exit code 0. On failure, keep the output for the report and stop. Do not re-run.

- [ ] **Step 14: Commit and push**

```bash
git add electron/core/safe-move.mts electron/core/folders.mts electron/core/cleanup.mts electron/worker.mjs electron/renderer-src/src/components/settings/ContextTab.tsx electron/tests/safe-move.test.mts electron/tests/folders.test.mts electron/tests/cleanup.test.mts electron/tests/worker-cleanup.test.mts electron/tests/settings-tabs-visual.cjs electron/tests/all.mts
git commit -m "fix: folder history keeps one entry per folder (Python C:/ and Electron C:\\ merged, most recent date), and retention moves old history into retention-archive instead of deleting it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 2: R3 + R4 — Python roles shown, the whole data home migrated, the vault follows

**Files:**
- Modify: `electron/worker.mjs` (`normalizeRole` area at :296-300, `runSend` :348, `runCompaction` :155, ops `activate_folder` :462-466 and `messages` :562)
- Modify: `electron/core/data-dir.mts` (whole file shown below)
- Modify: `electron/main.cjs:166-175` (data home), `:295` (exports)
- Modify: `electron/main.d.cts` (declaration)
- Create: `electron/tests/main-data-home.test.mts`
- Modify: `electron/tests/worker-folders.test.mts` (imports + 1 test)
- Modify: `electron/tests/worker-compact.test.mts` (1 test appended)
- Modify: `electron/tests/data-dir.test.mts` (imports + 3 tests)
- Modify: `electron/tests/restore-folder-visual.cjs` (import + section E + PASS line)
- Modify: `electron/tests/all.mts` (register `main-data-home.test.mts`)

**Interfaces:**
- Consumes: `moveEntry(src, dst)` from Task 1 (`core/safe-move.mts`).
- Produces (`main.cjs`): `resolveMainDataHome(env?: Record<string, string | undefined>, userHome?: string): Promise<string>`. It is `env.OPENAGENT_HOME` when set; otherwise it is `resolveDataHome(join(userHome, '.openagent'))`.
- Produces (`worker.mjs`, internal): `servedMessages(messages)` maps every `role` through `normalizeRole`.
- `migrateDataDir(currentHome, defaultHome, newDir)` keeps its signature and `{ moved, errors }`. `moved` counts top-level entries, a folder counting as one.

- [ ] **Step 1: Write the failing R3 tests**

In `electron/tests/worker-folders.test.mts`, line 5, replace:

```typescript
import { mkdtemp, mkdir } from 'node:fs/promises';
```

with:

```typescript
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
```

Append to `electron/tests/worker-folders.test.mts`:

```typescript
test('R3: a history saved by the Python app (roles human/ai) is served as user/assistant, and a read writes nothing', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-legacy-roles-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(join(project, '.openagent'), { recursive: true })]);
  const legacy = JSON.stringify([
    { role: 'human', content: 'question posée à l’ancienne app' },
    { role: 'ai', content: 'réponse de l’ancienne app' },
    { role: 'tool', content: 'sortie' },
  ]);
  await writeFile(join(project, '.openagent', 'chat_history.json'), legacy);

  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), {
    env: { ...process.env, OPENAGENT_HOME: home },
  }));
  const indexed = indexingSettled(worker, project);
  const activated = await callWorker(worker, 'activate_folder', { folder: project });
  assert.deepEqual(activated.history.map((m: any) => m.role), ['user', 'assistant', 'tool'], 'activation');
  const loaded = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  assert.deepEqual(loaded.map((m: any) => m.role), ['user', 'assistant', 'tool'], 'branch load');
  assert.equal(loaded[1].content, 'réponse de l’ancienne app');
  assert.equal(await readFile(join(project, '.openagent', 'chat_history.json'), 'utf8'), legacy, 'the Python file is not rewritten by a read');
  await assert.rejects(readFile(join(project, '.openagent', 'conversations.json')), /ENOENT/, 'and no new file is written by a read');
  await indexed;
});
```

Append to `electron/tests/worker-compact.test.mts`:

```typescript
test('R3: compacting a Python-era history (human/ai) announces user/assistant roles, like every place that serves a history', async t => {
  const { seed, compact } = await setup(t);
  await seed(Array.from({ length: 4 }, (_, i) => [say('human', `question ${i + 1}`), say('ai', `réponse ${i + 1}`)]).flat());
  const done = await (await compact()).outcome;
  assert.equal(done.kind, 'compacted', JSON.stringify(done));
  assert.deepEqual(done.messages.map((m: any) => m.role), ['assistant', 'user', 'assistant']);
});
```

- [ ] **Step 2: Write the failing R4 tests**

In `electron/tests/data-dir.test.mts`, line 3, replace:

```typescript
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
```

with:

```typescript
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
```

Append to `electron/tests/data-dir.test.mts`:

```typescript
/** Every file under `dir`, by relative path, as base64. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[full.slice(dir.length)] = (await readFile(full)).toString('base64');
  }
  return out;
}

test('R4: migrateDataDir moves the whole tree — knowledge/, tools/ and nested sub-folders — byte for byte', async t => {
  const { root, home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{"theme":"dark"}');
  await mkdir(join(home, 'knowledge'));
  await writeFile(join(home, 'knowledge', 'store.json'), '{"chunks":[]}');
  await mkdir(join(home, 'tools'));
  await writeFile(join(home, 'tools', 'outil.mjs'), 'export function getTools() { return []; }');
  await mkdir(join(home, 'cache', 'embeddings', 'deep'), { recursive: true });
  await writeFile(join(home, 'cache', 'embeddings', 'deep', 'v.bin'), Buffer.from([0, 1, 2, 250, 255]));
  const before = await snapshot(home);
  const newDir = join(root, 'new-home');
  const { migrateDataDir, resolveDataHome } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.deepEqual(result, { moved: 4, errors: [] }, 'config.json, knowledge, tools, cache');
  assert.deepEqual(await snapshot(newDir), before);
  assert.deepEqual(await readdir(home), ['redirect.json'], 'only the fixed pointer stays behind');
  assert.equal(await resolveDataHome(home), newDir);
});

test('R4: an entry that already exists in the new folder is reported and left in place, never overwritten', async t => {
  const { root, home } = await fixture(t);
  const newDir = join(root, 'new-home');
  await mkdir(newDir);
  await writeFile(join(home, 'config.json'), 'mine');
  await writeFile(join(newDir, 'config.json'), 'already there');
  await writeFile(join(home, 'folders.json'), '[]');
  const { migrateDataDir } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.equal(result.moved, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^config\.json : la destination existe déjà$/);
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), 'mine');
  assert.equal(await readFile(join(newDir, 'config.json'), 'utf8'), 'already there');
  assert.equal(await readFile(join(newDir, 'folders.json'), 'utf8'), '[]');
});

test('R4: a new folder chosen INSIDE the current home is not moved into itself', async t => {
  const { home } = await fixture(t);
  await writeFile(join(home, 'config.json'), '{}');
  await mkdir(join(home, 'tools'));
  await writeFile(join(home, 'tools', 'x.mjs'), '');
  const newDir = join(home, 'nouveau');
  const { migrateDataDir } = await import('../core/data-dir.mts');
  const result = await migrateDataDir(home, home, newDir);
  assert.deepEqual(result, { moved: 2, errors: [] });
  assert.deepEqual((await readdir(newDir)).sort(), ['config.json', 'tools']);
  assert.deepEqual((await readdir(home)).sort(), ['nouveau', 'redirect.json']);
});
```

Create `electron/tests/main-data-home.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

// main.cjs only registers IPC and the app lifecycle when it is the Electron entry point: as a library, its helpers run.
const { resolveMainDataHome } = createRequire(import.meta.url)('../main.cjs');

// Real authenticated encryption in place of the OS safeStorage, as in connections.test.mts.
function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
function callWorker(worker: Worker, op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `main-home-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('main uses OPENAGENT_HOME as is, exactly like the worker (tests only)', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'openagent-main-home-env-'));
  removeAtEnd(t, userHome);
  assert.equal(await resolveMainDataHome({ OPENAGENT_HOME: join(userHome, 'isolated') }, userHome), join(userHome, 'isolated'));
});

test('main follows ~/.openagent/redirect.json like the worker, and stays in ~/.openagent without one', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'openagent-main-home-redirect-'));
  removeAtEnd(t, userHome);
  const defaultHome = join(userHome, '.openagent');
  await mkdir(defaultHome);
  assert.equal(await resolveMainDataHome({}, userHome), defaultHome);
  const moved = join(userHome, 'ailleurs');
  await writeFile(join(defaultHome, 'redirect.json'), JSON.stringify({ data_dir: moved }));
  assert.equal(await resolveMainDataHome({}, userHome), moved);
});

test('R4: after a real migrate-data-dir, the vault the main process opens is in the new folder, with its key', { timeout: 30000 }, async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'openagent-main-home-vault-'));
  removeAtEnd(t, userHome);
  const defaultHome = join(userHome, '.openagent');
  const newDir = join(userHome, 'donnees-deplacees');
  await mkdir(join(defaultHome, 'knowledge'), { recursive: true });
  await writeFile(join(defaultHome, 'knowledge', 'store.json'), '{"chunks":[]}');
  const { Connections } = await import('../core/connections.mts');
  const cipher = encryption();
  await new Connections({ home: defaultHome, cipher, environment: {} }).save(null, { provider: 'openrouter', model: 'm', api_key: 'sk-VAULT-FOLLOWS' });

  // The worker's data home IS the temporary default home: OPENAGENT_HOME keeps it off the real ~/.openagent.
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: defaultHome } }));
  const result = await callWorker(worker, 'migrate-data-dir', { newDir });
  assert.deepEqual(result.errors, []);

  const mainHome = await resolveMainDataHome({}, userHome);
  assert.equal(mainHome, newDir, 'the main process resolves the redirect the migration wrote');
  const reopened = new Connections({ home: mainHome, cipher, environment: {} });
  assert.equal((await reopened.resolve(null)).api_key, 'sk-VAULT-FOLLOWS', 'the vault followed the data');
  await assert.rejects(readFile(join(defaultHome, 'connections.v1.json')), /ENOENT/, 'nothing left in the old folder');
  assert.equal(await readFile(join(newDir, 'knowledge', 'store.json'), 'utf8'), '{"chunks":[]}', 'sub-folders followed too');
});
```

Append to `electron/tests/all.mts`:

```typescript
import './main-data-home.test.mts';
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/worker-folders.test.mts tests/worker-compact.test.mts tests/data-dir.test.mts tests/main-data-home.test.mts`

Expected failures:
- The `R3:` worker-folders test gets roles `['human', 'ai', 'tool']`.
- The `R3:` compaction test gets `['assistant', 'human', 'ai']`.
- In `data-dir.test.mts`, the whole-tree test fails with `moved: 1` (only `config.json`), the existing-destination test fails because the file is overwritten, and the nested test fails.
- In `main-data-home.test.mts`, all three fail with `resolveMainDataHome is not a function`.

- [ ] **Step 4: Implement R3 in the worker**

In `electron/worker.mjs`, replace:

```javascript
function normalizeRole(role) {
  if (role === 'ai') return 'assistant';
  if (role === 'human') return 'user';
  return role;
}
```

with:

```javascript
function normalizeRole(role) {
  if (role === 'ai') return 'assistant';
  if (role === 'human') return 'user';
  return role;
}
/** R3: the Python app saved `ai`/`human`; the screen and the model request only know `assistant`/`user`. Applied
 * wherever a history is served (folder activation, branch load, a finished compaction, a turn) — never written back
 * by a read, so the file stays exactly as the Python app left it until the next real save. */
function servedMessages(messages) {
  return messages.map(message => ({ ...message, role: normalizeRole(message.role) }));
}
```

In `runSend`, replace:

```javascript
    const history = (keep === undefined ? saved : saved.slice(0, keep)).map(m => ({ ...m, role: normalizeRole(m.role) }));
```

with:

```javascript
    const history = servedMessages(keep === undefined ? saved : saved.slice(0, keep));
```

In `runCompaction`, replace:

```javascript
    outcome = { kind: 'compacted', messages: after };
```

with:

```javascript
    outcome = { kind: 'compacted', messages: servedMessages(after) };
```

In `handle`, replace:

```javascript
    if (op === 'activate_folder') {
      const list = await folders.recordOpened(payload.folder);
      result = { history: await conversations.messages(payload.folder, 'main').catch(() => []), folders: list };
      void triggerIndexing(payload.folder);
    }
```

with:

```javascript
    if (op === 'activate_folder') {
      const list = await folders.recordOpened(payload.folder);
      const history = await conversations.messages(payload.folder, 'main').catch(() => []);
      result = { history: servedMessages(history), folders: list };
      void triggerIndexing(payload.folder);
    }
```

and replace:

```javascript
    if (op === 'messages') result = await conversations.messages(payload.folder, payload.branchId || 'main');
```

with:

```javascript
    if (op === 'messages') result = servedMessages(await conversations.messages(payload.folder, payload.branchId || 'main'));
```

- [ ] **Step 5: Implement R4 in `core/data-dir.mts`**

Replace the whole of `electron/core/data-dir.mts` with:

```typescript
import { isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { JsonStore } from './json-store.mts';
import { moveEntry } from './safe-move.mts';

export interface MigrationResult {
  moved: number;
  errors: string[];
}

const REDIRECT_FILE = 'redirect.json';

function redirectPath(defaultHome: string): string {
  return join(defaultHome, REDIRECT_FILE);
}

/** Path identity: resolved, and case-insensitive under Windows. */
function samePath(a: string, b: string): boolean {
  const key = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return key(a) === key(b);
}
/** True when `inner` lies strictly below `outer`. */
function isInside(inner: string, outer: string): boolean {
  const rel = relative(resolve(outer), resolve(inner));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolves the real data home at startup. The fixed OS-default location (`~/.openagent`, never
 * itself relocated) always holds a tiny redirect.json once the user has moved their data
 * elsewhere — everything else (settings, connections, folder history…) lives at whatever it
 * points to. No redirect on disk means the default location IS the real home, as always.
 * main.cjs (the connections vault) and worker.mjs both resolve it through here.
 */
export async function resolveDataHome(defaultHome: string): Promise<string> {
  const store = new JsonStore();
  const pointer = await store.read<{ data_dir?: unknown }>(redirectPath(defaultHome), {});
  const dataDir = typeof pointer.data_dir === 'string' ? pointer.data_dir : '';
  return dataDir && isAbsolute(dataDir) ? dataDir : defaultHome;
}

/**
 * Moves EVERYTHING in `currentHome` — files and folders (knowledge/, tools/, caches, retention-archive/…) — into
 * `newDir` (created if needed), each entry through core/safe-move.mts (one rename on the same drive, a copy checked
 * byte for byte then the source removed across drives, never over an existing entry), then points the fixed
 * redirect at `defaultHome` to `newDir`, so the next start (worker AND main process) finds it there. An entry that
 * cannot move stays where it was and is listed in `errors`. A restart is required, as before.
 */
export async function migrateDataDir(currentHome: string, defaultHome: string, newDir: string): Promise<MigrationResult> {
  if (!isAbsolute(newDir)) throw new Error('Chemin absolu requis');
  await mkdir(newDir, { recursive: true });
  let moved = 0;
  const errors: string[] = [];
  if (!samePath(newDir, currentHome)) {
    let entries: string[] = [];
    try { entries = await readdir(currentHome); } catch { entries = []; }
    for (const name of entries) {
      if (name === REDIRECT_FILE) continue; // the pointer itself never moves with the data
      const src = join(currentHome, name);
      if (samePath(src, newDir)) continue; // the new folder, chosen inside the old one
      if (isInside(newDir, src)) { errors.push(`${name} : contient le nouveau dossier, non déplacé`); continue; }
      try {
        await moveEntry(src, join(newDir, name));
        moved++;
      } catch (error: any) {
        errors.push(`${name} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const store = new JsonStore();
  await store.update<Record<string, unknown>>(redirectPath(defaultHome), {}, () => ({ data_dir: newDir }));
  return { moved, errors };
}
```

- [ ] **Step 6: The main process resolves the data home like the worker**

In `electron/main.cjs`, replace:

```javascript
// Mirrors worker.mjs's OPENAGENT_HOME override — lets integration tests point the whole
// data layer at a temp directory instead of the real user's ~/.openagent.
function dataHome() {
  return process.env.OPENAGENT_HOME || path.join(homedir(), '.openagent');
}

async function createConnections() {
  const { Connections } = await import('./core/connections.mts');
  return new Connections({ home: dataHome(), cipher: safeStorage, environment: process.env });
}
```

with:

```javascript
/**
 * The data home, resolved exactly as worker.mjs resolves it: OPENAGENT_HOME (tests only) as is, otherwise
 * ~/.openagent followed through its redirect.json (Réglages › Général › Répertoire de données) — the connections
 * vault must live where the rest of the data went (R4). `env` and `userHome` are parameters for tests only.
 */
async function resolveMainDataHome(env = process.env, userHome = homedir()) {
  if (env.OPENAGENT_HOME) return env.OPENAGENT_HOME;
  const { resolveDataHome } = await import('./core/data-dir.mts');
  return resolveDataHome(path.join(userHome, '.openagent'));
}

async function createConnections() {
  const { Connections } = await import('./core/connections.mts');
  return new Connections({ home: await resolveMainDataHome(), cipher: safeStorage, environment: process.env });
}
```

and replace the last line:

```javascript
module.exports = { resolveSendPayload, createConnections, buildCsp, chooseLoadTarget, handleBackendRequest, stopWorker, isBackendOp, needsConnection, isExportFilename, notificationBodyFor };
```

with:

```javascript
module.exports = { resolveSendPayload, createConnections, resolveMainDataHome, buildCsp, chooseLoadTarget, handleBackendRequest, stopWorker, isBackendOp, needsConnection, isExportFilename, notificationBodyFor };
```

In `electron/main.d.cts`, after `export function createConnections(): Promise<unknown>;`, add:

```typescript

export function resolveMainDataHome(env?: Record<string, string | undefined>, userHome?: string): Promise<string>;
```

- [ ] **Step 7: Run the R3/R4 tests and the neighbours**

Run: `cd electron && node --experimental-strip-types --test tests/worker-folders.test.mts tests/worker-compact.test.mts tests/data-dir.test.mts tests/worker-data-dir.test.mts tests/main-data-home.test.mts tests/main-routing.test.mts tests/main-shutdown.test.mts tests/bridge-connection.test.mts tests/worker-send.test.mts tests/worker-keep.test.mts tests/worker-branches.test.mts tests/safe-move.test.mts`
Expected: all PASS.

- [ ] **Step 8: The window proof for R1 and R3 (`restore-folder-visual.cjs`)**

In `electron/tests/restore-folder-visual.cjs`, line 12, replace:

```javascript
const { mkdtemp, rm, mkdir, writeFile, rm: rmPath } = require('node:fs/promises');
```

with:

```javascript
const { mkdtemp, rm, mkdir, writeFile, realpath, rm: rmPath } = require('node:fs/promises');
```

Before the line `    process.stdout.write(\`PASS restore last folder: …` (the PASS line near the end), insert:

```javascript
    // ── E. data left by the Python app: folders.json holds the project as C:/… (Python, old) AND C:\… (this app,
    //       recent), and its chat_history.json has roles "human"/"ai" — one sidebar entry, and the old answers shown ──
    {
      const home = join(root, 'home-e');
      const legacy = join(root, 'legacy-e');
      await Promise.all([mkdir(home), mkdir(join(legacy, '.openagent'), { recursive: true })]);
      const real = await realpath(legacy);
      await writeFile(join(home, 'folders.json'), JSON.stringify([
        { path: real.replaceAll('\\', '/'), last_used: '2026-01-15T09:30:00.123456' },
        { path: real, last_used: new Date().toISOString() },
      ]));
      await writeFile(join(legacy, '.openagent', 'chat_history.json'), JSON.stringify([
        { role: 'human', content: 'question posée à l’ancienne app' },
        { role: 'ai', content: 'réponse de l’ancienne app' },
      ]));
      const session = await bootSession(home);
      try {
        await session.win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
        await waitFor(() => js(session.win, `!!document.querySelector('[data-testid="oa-folder-entry"][data-active="true"]')`), { what: 'the legacy project is restored' });
        assert.equal(await js(session.win, `document.querySelectorAll('[data-testid="oa-folder-entry"]').length`), 1, 'one sidebar entry for the two spellings (R1)');
        await waitFor(() => js(session.win, `[...document.querySelectorAll('[data-testid="oa-assistant-bubble"]')].some(e => e.textContent.includes(${JSON.stringify('réponse de l’ancienne app')}))`), { what: 'the Python reply (role "ai") is shown (R3)' });
        assert.equal(await js(session.win, `[...document.querySelectorAll('[data-testid="oa-user-bubble"]')].some(e => e.textContent.includes(${JSON.stringify('question posée à l’ancienne app')}))`), true, 'the Python question (role "human") is shown');
        await writeFile(join(screenshotDir, 'restore-e-legacy.png'), await capturePng(session.win));
      } finally { await teardown(session); }
    }

```

Then replace the PASS line:

```javascript
    process.stdout.write(`PASS restore last folder: real restore on cold start, disabled by setting, safe on a deleted folder, never overrides a manual click (Electron ${process.versions.electron})\n`);
```

with:

```javascript
    process.stdout.write(`PASS restore last folder: real restore on cold start, disabled by setting, safe on a deleted folder, never overrides a manual click, Python-era data shown once with its answers (Electron ${process.versions.electron})\n`);
```

The runner `run-restore-folder-visual.cjs` matches the prefix `PASS restore last folder`, so it needs no change.

- [ ] **Step 9: Type-check, build, run the touched window test ONCE**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json; npm run renderer:build; npm run test:restorefolder`
Expected:
- tsc shows the 5 pre-existing errors only;
- the build exits 0;
- the visual test prints `PASS restore last folder: …Python-era data shown once with its answers…` and exits 0.

Run the visual test once; on failure, report and stop. Look at `restore-e-legacy.png` and confirm the AI bubble is visible.

- [ ] **Step 10: Commit and push**

```bash
git add electron/worker.mjs electron/core/data-dir.mts electron/main.cjs electron/main.d.cts electron/tests/main-data-home.test.mts electron/tests/worker-folders.test.mts electron/tests/worker-compact.test.mts electron/tests/data-dir.test.mts electron/tests/restore-folder-visual.cjs electron/tests/all.mts
git commit -m "fix: Python-era replies (role ai/human) are shown wherever a history is served, the data-home migration moves every folder too, and the main process follows the redirect so the vault moves with the data" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 3: Gap 1 — closing the window sends the app to the tray

**Files:**
- Modify: `electron/tray-icon.cjs:64-68` (template + export)
- Modify: `electron/main.cjs` (require at :6, module state at :12-17, `createWindow` :64-86, tray :95-107, lifecycle :282-291)
- Modify: `electron/tests/tray-icon.test.mts` (1 test appended)
- Create: `electron/tests/final-e2e-tray.cjs`
- Modify: `electron/package.json` (script `test:final-e2e-tray`)

**Interfaces:**
- Produces (`tray-icon.cjs`): `trayMenuTemplate({ open, quit }: { open: () => void; quit: () => void }): Array<{ label?: string; type?: 'separator'; click?: () => void }>`
- `main.cjs` keeps its exports. It gains a module-level `appQuitting` flag, set by `before-quit`.

- [ ] **Step 1: Check by grep that no existing test closes the window and waits for the exit**

Run: `cd electron/tests && grep -n "Browser.close\|closeTarget\|window\.close\|WM_CLOSE\|CloseMainWindow\|Page\.close\|mainWindow" *.cjs *.mts`
Expected:
- Only the `Browser.close` calls inside the `quit()` helpers of `final-e2e-lot3.cjs` through `final-e2e-lot13.cjs`.
- Electron implements CDP `Browser.close` as `Browser::Get()->Quit()`, i.e. `app.quit()` (ruling 10). Those tests already quit the way the tray's « Quitter » does, so they keep passing and are **not** changed (ruling 12).
- If the grep shows anything else that closes a `main.cjs` window and waits for the process to end, stop and adapt that test: close, then call `Browser.close`, then wait for the exit.

- [ ] **Step 2: Write the failing tray-menu test**

Append to `electron/tests/tray-icon.test.mts`:

```typescript
test('the tray menu: « Ouvrir openagent » shows the window, « Quitter » is the real quit (main.cjs passes showMainWindow and app.quit)', () => {
  const { trayMenuTemplate } = require('../tray-icon.cjs');
  const open = () => {};
  const quit = () => {};
  const template = trayMenuTemplate({ open, quit });
  assert.deepEqual(template.map((item: any) => item.label ?? item.type), ['Ouvrir openagent', 'separator', 'Quitter']);
  assert.equal(template[0].click, open);
  assert.equal(template[2].click, quit);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd electron && node --experimental-strip-types --test tests/tray-icon.test.mts`
Expected: the new test FAILs with `trayMenuTemplate is not a function`. The 3 others PASS.

- [ ] **Step 4: Implement the template**

In `electron/tray-icon.cjs`, replace:

```javascript
function buildDiamondIconPng(size = 32) {
  return encodePng(size, size, diamondRgba(size));
}

module.exports = { buildDiamondIconPng, diamondRgba, encodePng };
```

with:

```javascript
function buildDiamondIconPng(size = 32) {
  return encodePng(size, size, diamondRgba(size));
}

/** The tray's context menu, as a template for Menu.buildFromTemplate. Pure, so a test can check which function each
 * item calls — a native tray menu cannot be clicked from a test. main.cjs passes showMainWindow and app.quit. */
function trayMenuTemplate({ open, quit }) {
  return [
    { label: 'Ouvrir openagent', click: open },
    { type: 'separator' },
    { label: 'Quitter', click: quit },
  ];
}

module.exports = { buildDiamondIconPng, diamondRgba, encodePng, trayMenuTemplate };
```

- [ ] **Step 5: Run the tray tests**

Run: `cd electron && node --experimental-strip-types --test tests/tray-icon.test.mts`
Expected: 4/4 PASS.

- [ ] **Step 6: Close hides, every real quit closes (`main.cjs`)**

In `electron/main.cjs`, replace:

```javascript
const { buildDiamondIconPng } = require('./tray-icon.cjs');
```

with:

```javascript
const { buildDiamondIconPng, trayMenuTemplate } = require('./tray-icon.cjs');
```

Replace:

```javascript
let updater;
let installUpdateNow;
const pending = new Map();
```

with:

```javascript
let updater;
let installUpdateNow;
// Set by 'before-quit' (see the app lifecycle below): from then on, closing the window really closes it.
let appQuitting = false;
const pending = new Map();
```

In `createWindow`, replace:

```javascript
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
}
```

with:

```javascript
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  // The cross hides the window instead of quitting, as the NiceGUI app did: the app, its worker and the tray icon
  // keep running. Only a real quit closes it — the tray's « Quitter » (app.quit), « Redémarrer maintenant »
  // (electron-updater's quitAndInstall calls app.quit) and CDP Browser.close (Electron's Browser::Quit) all emit
  // 'before-quit' first, which sets appQuitting.
  const win = mainWindow;
  win.on('close', event => {
    if (appQuitting) return;
    event.preventDefault();
    win.hide();
  });
}
```

Replace:

```javascript
// A system-tray icon so the app can keep running in the background after the window is closed,
// like the previous NiceGUI app's pystray-based tray. Kept alive on the module-level `tray`
// variable — Electron garbage-collects (and silently hides) a Tray with no other reference.
function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(buildDiamondIconPng(32)));
  tray.setToolTip('◈ openagent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir openagent', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}
```

with:

```javascript
// The system-tray icon. The window's cross only hides the window (createWindow): the app, its worker and this icon
// keep running, like the previous NiceGUI app's pystray-based tray. « Ouvrir openagent » or a click on the icon
// shows the window again; « Quitter » is the real quit. Kept alive on the module-level `tray` variable — Electron
// garbage-collects (and silently hides) a Tray with no other reference.
function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(buildDiamondIconPng(32)));
  tray.setToolTip('◈ openagent');
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate({ open: showMainWindow, quit: () => app.quit() })));
  tray.on('click', showMainWindow);
}
```

Replace:

```javascript
    // Whatever way the app quits, the worker is shut down properly first so no dev server outlives it.
    // After "Redémarrer maintenant" the worker is already stopped (backend undefined): the quit goes straight on.
    let quitting = false;
    app.on('before-quit', event => {
      if (quitting || (!backend && !stoppingBackend)) return;
      event.preventDefault();
      quitting = true;
      (backend ? stopBackend() : stoppingBackend).finally(() => app.quit());
    });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

with:

```javascript
    // Whatever way the app quits, the worker is shut down properly first so no dev server outlives it.
    // After "Redémarrer maintenant" the worker is already stopped (backend undefined): the quit goes straight on.
    // appQuitting is set FIRST, before the early return: that quit path (no worker left) must close the window too.
    // A Windows session end (log off, shutdown) does not come through here: Electron 44 emits 'session-end' on the
    // window, then ends the process itself (native_window_views_win.cc, WM_ENDSESSION) — no 'close' event, so the
    // hide in createWindow never holds it back.
    let quitting = false;
    app.on('before-quit', event => {
      appQuitting = true;
      if (quitting || (!backend && !stoppingBackend)) return;
      event.preventDefault();
      quitting = true;
      (backend ? stopBackend() : stoppingBackend).finally(() => app.quit());
    });
    // Only reached once a real quit closed the window: the cross alone never closes it any more.
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 7: Run the `main.cjs` library tests (no window)**

Run: `cd electron && node --experimental-strip-types --test tests/main-shutdown.test.mts tests/main-routing.test.mts tests/renderer-loading.test.mts tests/bridge-connection.test.mts tests/tray-icon.test.mts tests/main-data-home.test.mts tests/updater.test.mts`
Expected: all PASS. `main.cjs` is still requirable as a library.

- [ ] **Step 8: Write the end-to-end proof on the packaged app**

Create `electron/tests/final-e2e-tray.cjs`:

```javascript
// Plain Node script. Final end-to-end proof for parity row 1 (« fermer envoie dans la zone de notification »): spawns
// the REAL packaged executable (real main.cjs, real worker, real tray icon) on an isolated data home and drives the
// window the way Windows does — WM_CLOSE is what the title-bar cross sends. What it proves:
//   - the cross HIDES the window: the process, the worker and the page keep running;
//   - launching the app again shows the hidden window (main.cjs's 'second-instance' handler is showMainWindow, the
//     very function behind the tray's « Ouvrir openagent »);
//   - CDP Browser.close — Electron's Browser::Quit, the same quit as the app.quit() behind the tray's « Quitter » and
//     electron-updater's quitAndInstall — really ends the process, exit code 0;
//   - a Windows session end (WM_QUERYENDSESSION, then WM_ENDSESSION) ends it too.
// The native tray menu cannot be clicked from here: tray-icon.test.mts proves which function each item calls.
// Every window here is opened ONCE; on failure the output is reported, nothing is retried.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { httpGetJson, waitFor, Cdp } = require('./cdp-helper.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WM_CLOSE = 0x0010;
const WM_QUERYENDSESSION = 0x0011;
const WM_ENDSESSION = 0x0016;
// user32 from PowerShell 5.1. The here-string's closing '@ must start its line.
const USER32 = `Add-Type -Namespace OA -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
'@
`;

/** Runs a PowerShell script (passed encoded: no quoting issue) and resolves with its trimmed output. */
function powershell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', reject);
    ps.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(`powershell exit ${code}: ${err.trim()}`))));
  });
}
const mainWindowHandle = pid => powershell(`(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`).then(Number);
const isVisible = hwnd => powershell(`${USER32}[OA.U]::IsWindowVisible([System.IntPtr]::new(${hwnd}))`).then(out => out === 'True');
const post = (hwnd, message, wParam = 0) => powershell(`${USER32}[void][OA.U]::PostMessage([System.IntPtr]::new(${hwnd}), ${message}, [System.IntPtr]::new(${wParam}), [System.IntPtr]::Zero)`);

async function main() {
  const proofDir = process.env.OPENAGENT_E2E_PROOF_DIR;
  if (!proofDir) throw new Error('OPENAGENT_E2E_PROOF_DIR must be set (where the log is written)');
  await mkdir(proofDir, { recursive: true });
  const log = [];
  const record = line => { log.push(line); process.stdout.write(line + '\n'); };

  const root = await mkdtemp(join(tmpdir(), 'openagent-tray-'));
  const home = join(root, 'home');
  const userData = join(root, 'userdata');
  await Promise.all([mkdir(home), mkdir(userData)]);
  const exePath = path.join(__dirname, '..', 'release', 'win-unpacked', 'openagent.exe');
  // OPENAGENT_USERDATA_DIR makes main.cjs key its single-instance lock on this temp folder: every launch below shares
  // the lock with each other and never with a real running openagent.
  const env = { ...process.env, OPENAGENT_HOME: home, OPENAGENT_USERDATA_DIR: userData, OPENAGENT_DISABLE_UPDATES: '1' };
  const childOutput = [];
  const running = new Set();
  let debugPort = 9860;

  function spawnApp(extraArgs) {
    const child = spawn(exePath, [...extraArgs, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => childOutput.push(`[stdout ${child.pid}] ${d}`));
    child.stderr.on('data', d => childOutput.push(`[stderr ${child.pid}] ${d}`));
    const instance = { child, exited: false, cdp: null, port: null, hwnd: 0 };
    instance.exitPromise = new Promise(resolve => child.on('exit', code => { instance.exited = true; running.delete(instance); resolve(code); }));
    running.add(instance);
    return instance;
  }
  async function launch() {
    const port = debugPort++;
    const instance = spawnApp([`--remote-debugging-port=${port}`]);
    instance.port = port;
    const pages = await waitFor(async () => {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
      return list.length > 0 && list[0].title === 'openagent' ? list : null;
    }, { timeout: 20000, what: 'the packaged app page' });
    instance.cdp = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await instance.cdp.send('Runtime.enable');
    await waitFor(() => instance.cdp.evaluate(`document.body.textContent.includes('Ouvre un dossier pour commencer')`), { timeout: 15000, what: 'the interface is rendered' });
    instance.hwnd = await waitFor(() => mainWindowHandle(instance.child.pid), { timeout: 10000, what: 'the app window handle' });
    return instance;
  }
  const exitWithin = (instance, ms) => Promise.race([instance.exitPromise, sleep(ms).then(() => 'timeout')]);
  const workerAnswers = async instance => Array.isArray(await instance.cdp.evaluate(`window.openagent.request({ op: 'list_folders' })`, true));

  let app;
  try {
    app = await launch();
    assert.equal(await isVisible(app.hwnd), true, 'the window starts visible');
    record(`PROOF 1 — packaged app launched (pid=${app.child.pid}), window ${app.hwnd} visible`);

    await post(app.hwnd, WM_CLOSE);
    await waitFor(async () => !(await isVisible(app.hwnd)), { timeout: 10000, what: 'the window hidden after WM_CLOSE' });
    await sleep(1500);
    assert.equal(app.exited, false, 'the process is still running after the cross');
    assert.equal(await workerAnswers(app), true, 'the worker still answers (list_folders) with the window hidden');
    const pagesWhileHidden = await httpGetJson(`http://127.0.0.1:${app.port}/json`);
    assert.ok(pagesWhileHidden.some(page => page.type === 'page' && page.title === 'openagent'), 'the page is still alive');
    record('PROOF 2 — WM_CLOSE (the cross) hid the window; process, worker and page still alive');

    const second = spawnApp([]);
    assert.equal(await exitWithin(second, 15000), 0, 'the second launch hands off and exits with code 0');
    await waitFor(() => isVisible(app.hwnd), { timeout: 10000, what: 'the hidden window shown again by the second launch' });
    assert.equal(app.exited, false);
    record('PROOF 3 — a second launch exited (code 0) and showed the hidden window again (showMainWindow, the tray « Ouvrir » function)');

    app.cdp.close();
    const version = await httpGetJson(`http://127.0.0.1:${app.port}/json/version`);
    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    await browser.send('Browser.close').catch(() => {});
    assert.equal(await exitWithin(app, 20000), 0, 'Browser.close (= app.quit, the tray « Quitter » path) ends the process with code 0');
    record('PROOF 4 — Browser.close (Browser::Quit = app.quit) closed the window for real: exit code 0');

    const third = await launch();
    third.cdp.close();
    await post(third.hwnd, WM_QUERYENDSESSION, 0);
    await post(third.hwnd, WM_ENDSESSION, 1);
    assert.equal(await exitWithin(third, 10000), 0, 'a Windows session end ends the app, code 0');
    record('PROOF 5 — WM_QUERYENDSESSION + WM_ENDSESSION (Windows session end) ended the app: exit code 0');

    await writeFile(join(proofDir, 'tray-log.txt'), log.join('\n') + '\n');
    process.stdout.write('PASS final end-to-end verification of close-to-tray on the packaged app\n');
  } catch (error) {
    if (childOutput.length) process.stderr.write(`Packaged app output leading up to the failure:\n${childOutput.join('')}\n`);
    throw error;
  } finally {
    for (const instance of [...running]) { try { instance.cdp?.close(); } catch { /* already closed */ } if (!instance.exited) instance.child.kill(); }
    await sleep(500);
    if (!process.env.OPENAGENT_E2E_KEEP_TEMP) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  process.stderr.write(`FAIL final e2e tray: ${error.stack || error}\n`);
  process.exitCode = 1;
});
```

In `electron/package.json`, after the line `"test:final-e2e-lot13": "node tests/final-e2e-lot13.cjs",`, add:

```json
    "test:final-e2e-tray": "node tests/final-e2e-tray.cjs",
```

- [ ] **Step 9: Package, then run the end-to-end proof ONCE**

Run: `cd electron && npm run package:win`
Expected: exit code 0, with `release/win-unpacked/openagent.exe` rebuilt.

Run: `cd electron && OPENAGENT_E2E_PROOF_DIR="$TEMP/openagent-proof-tray" npm run test:final-e2e-tray`
Expected: `PROOF 1` to `PROOF 5`, then `PASS final end-to-end verification of close-to-tray on the packaged app`, exit code 0.

Run it once. If it fails, report the failing PROOF and the app output, and stop. PROOF 5 depends on Electron's own `WM_ENDSESSION` handling (ruling 11). If only PROOF 5 fails, report it as such; PROOFs 1–4 are the spec's requirements.

- [ ] **Step 10: Commit and push**

```bash
git add electron/tray-icon.cjs electron/main.cjs electron/tests/tray-icon.test.mts electron/tests/final-e2e-tray.cjs electron/package.json
git commit -m "feat: the window's cross hides the app to the tray; only the tray's Quitter, the update restart or the Windows session end quit it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 4: Gaps 32 + 33 — `.py` plugins reported, the Outils tab never starts an MCP server

**Files:**
- Modify: `electron/core/plugin-loader.mts:38-46` (file selection) and `:91-114` (load loop)
- Modify: `electron/core/mcp-client.mts:213-246` (`mcpTools`)
- Modify: `electron/core/mcp-config.mts:230-234` (export `serverIdentity`)
- Modify: `electron/worker.mjs` (import at :32; tools at :178-233; `plugin-list` at :432-444)
- Modify: `electron/renderer-src/src/ipc/bridge.ts:185-186`
- Modify: `electron/renderer-src/src/components/settings/ToolsTab.tsx:231-249`
- Modify: `electron/tests/fixtures/fake-mcp-server.cjs` (PID file, call delay)
- Modify: `electron/tests/plugin-loader.test.mts` (2 tests)
- Modify: `electron/tests/worker-plugin.test.mts` (1 test)
- Modify: `electron/tests/mcp-client.test.mts` (1 test)
- Modify: `electron/tests/worker-mcp.test.mts` (imports + 2 tests)
- Modify: `electron/tests/worker-trust.test.mts:120-128` (inverted assertion)
- Modify: `electron/tests/plugin-visual.cjs`, `electron/tests/mcp-visual.cjs` (assertions)
- Only if Step 6 fails: `electron/core/mcp-client.mts` (`stopAllMcpServers`) and `electron/worker.mjs` (`shutdown` op)

**Interfaces:**
- Produces (`plugin-loader.mts`): `pythonPluginError(name: string): string`. It returns `Plugin Python non pris en charge : ${name} — à réécrire en .mjs`.
- Produces (`mcp-client.mts`):
  - `interface McpServerTools { target: McpTarget; toolNames: string[] }`
  - `mcpTools(...)` returns `{ tools, errors, servers: McpServerTools[] }`.
- Produces (`mcp-config.mts`): `serverIdentity(server: { command: string; args: string[] } | { url: string }): string`.
- Produces (worker `mcp-list` reply): every entry has `tools: string[] | null`.
- Produces (`bridge.ts`): `tools?: string[] | null` on `StdioServerConfig` and `RemoteServerConfig`.
- Conditional: `stopAllMcpServers(): Promise<void>` in `mcp-client.mts`.

- [ ] **Step 1: Write the failing gap 2 tests**

Append to `electron/tests/plugin-loader.test.mts`:

```typescript
test('a legacy .py plugin is reported in each of the three directories by its file name, and never loaded', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'echo.mjs'), VALID_PLUGIN);
  await writeFile(join(home, 'tools', 'meteo.py'), 'def get_tools():\n    return []\n');
  await writeFile(join(home, 'tools', '__init__.py'), '');
  await writeFile(join(home, 'tools', '.cache.py'), '');
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', 'projet.py'), 'def get_tools():\n    return []\n');
  await mkdir(join(project, '.openagent', 'tools'), { recursive: true });
  await writeFile(join(project, '.openagent', 'tools', 'interne.py'), 'def get_tools():\n    return []\n');

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.deepEqual(tools.map(tool => tool.name), ['echo_plugin']);
  // Exactly these errors: no import was even attempted (Node would add an "Unknown file extension" error of its own).
  assert.deepEqual(errors, [
    'Plugin Python non pris en charge : meteo.py — à réécrire en .mjs',
    'Plugin Python non pris en charge : projet.py — à réécrire en .mjs',
    'Plugin Python non pris en charge : interne.py — à réécrire en .mjs',
  ]);
});

test('a .py in an untrusted project is not even listed — the same trust rule as a .mjs — while a global one is', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'meteo.py'), '');
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', 'projet.py'), '');
  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { errors } = await loadPlugins(project, home, { includeProject: false });
  assert.deepEqual(errors, ['Plugin Python non pris en charge : meteo.py — à réécrire en .mjs']);
});
```

Append to `electron/tests/worker-plugin.test.mts`:

```typescript
test('worker::plugin-list reports a legacy .py plugin of the data home as an error to port, and never loads it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-plugin-py-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'good.mjs'), `export function getTools() { return [{ name: 'good_tool', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' }]; }`);
  await writeFile(join(home, 'tools', 'meteo.py'), 'def get_tools():\n    return []\n');

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  terminateAtEnd(t, worker);

  for (const folder of [project, null]) {
    const result = await callWorker(worker, 'plugin-list', { folder });
    assert.deepEqual(result.tools, ['good_tool'], `folder=${folder}`);
    assert.deepEqual(result.errors, ['Plugin Python non pris en charge : meteo.py — à réécrire en .mjs'], `folder=${folder}`);
  }
});
```

- [ ] **Step 2: Write the failing gap 3 tests**

In `electron/tests/fixtures/fake-mcp-server.cjs`, replace:

```javascript
// Opt-in: proves a server really was (or was never) started — written before anything else runs.
if (process.env.FAKE_MCP_MARKER) require('node:fs').writeFileSync(process.env.FAKE_MCP_MARKER, 'started');
```

with:

```javascript
// Opt-in: proves a server really was (or was never) started — written before anything else runs.
if (process.env.FAKE_MCP_MARKER) require('node:fs').writeFileSync(process.env.FAKE_MCP_MARKER, 'started');
// Opt-in: one line per started process, its PID — lets a test check every process this server ever ran is gone.
if (process.env.FAKE_MCP_PID_FILE) require('node:fs').appendFileSync(process.env.FAKE_MCP_PID_FILE, `${process.pid}\n`);
```

and replace:

```javascript
  } else if (method === 'tools/call') {
    const name = params?.name;
```

with:

```javascript
  } else if (method === 'tools/call') {
    // Opt-in: a call that takes this long (discovery stays fast) — a call still in flight when the app quits.
    const callDelay = Number(process.env.FAKE_MCP_CALL_DELAY_MS || 0);
    if (callDelay) await new Promise(resolve => setTimeout(resolve, callDelay));
    const name = params?.name;
```

Append to `electron/tests/mcp-client.test.mts`:

```typescript
test('mcpTools also says which tools each server exposed — a server that crashed has no entry', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const good = config();
  const crashed = config({ FAKE_MCP_CRASH: '1' });
  const { servers, errors } = await mcpTools([good, crashed]);
  assert.equal(errors.length, 1);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].target, good);
  assert.deepEqual(servers[0].toolNames, ['mcp_echo', 'mcp_boom']);
});
```

In `electron/tests/worker-mcp.test.mts`, replace lines 5 and 9:

```typescript
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
```

```typescript
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
```

with:

```typescript
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
```

```typescript
import { removeAtEnd, terminateAtEnd } from './teardown.mts';
import { createRequire } from 'node:module';

// main.cjs as a library: the very function the app runs on quit (worker 'shutdown', then terminate).
const { stopWorker } = createRequire(import.meta.url)('../main.cjs');
```

Append to `electron/tests/worker-mcp.test.mts`:

```typescript
async function exists(file: string) {
  try { await readFile(file); return true; } catch { return false; }
}
function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 15000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
/** A real model: request 1 asks for mcp_echo when `callTool`, every other request ends the turn. */
async function model(t: any, callTool: boolean) {
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(callTool && count === 1
        ? { choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'mcp_echo', arguments: JSON.stringify({ text: 'x' }) } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  const port = (server.address() as { port: number }).port;
  return { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
}

test('the Outils tab never starts an MCP server: plugin-list and mcp-list leave it stopped; a turn starts it and its tools are remembered', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-not-started-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const marker = join(root, 'mcp-started.txt');
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{ id: 'fake', command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_MARKER: marker }, added_at: new Date().toISOString() }]));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  await callWorker(worker, 'plugin-list', { folder: project });
  await callWorker(worker, 'plugin-list', { folder: null });
  const before = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(await exists(marker), false, 'neither plugin-list nor mcp-list started the server');
  assert.equal(before[0].tools, null, 'not started: no tools to show yet');

  const connection = await model(t, false);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'bonjour', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  await waitUntilDone(events);
  stop();
  assert.equal(events.at(-1).kind, 'done', JSON.stringify(events.at(-1)));
  assert.equal(await exists(marker), true, 'the turn started it');
  assert.deepEqual((await callWorker(worker, 'mcp-list', { folder: project }))[0].tools, ['mcp_echo', 'mcp_boom']);
  assert.deepEqual((await callWorker(worker, 'mcp-list', {}))[0].tools, ['mcp_echo', 'mcp_boom'], 'the same server, no active folder');

  await rm(marker);
  await callWorker(worker, 'plugin-list', { folder: project });
  await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(await exists(marker), false, 'showing the remembered tools never restarts the server');
});

test('quitting the app (main.cjs::stopWorker) stops the MCP server a turn left in the middle of a call', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-mcp-quit-'));
  removeAtEnd(t, root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const pidFile = join(root, 'mcp-pids.txt');
  await writeFile(join(home, 'mcp.json'), JSON.stringify([{
    id: 'slow', command: process.execPath, args: [FAKE_MCP_SERVER],
    env: { FAKE_MCP_PID_FILE: pidFile, FAKE_MCP_CALL_DELAY_MS: '60000' }, added_at: new Date().toISOString(),
  }]));
  const worker = terminateAtEnd(t, new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } }));
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });
  const pids = async () => {
    try { return (await readFile(pidFile, 'utf8')).split('\n').filter(Boolean).map(Number); } catch { return []; }
  };

  const connection = await model(t, true);
  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'appelle mcp_echo', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  t.after(stop);
  // One process for the discovery (closed right after it), one for the call — still running: the call takes 60 s.
  await until(async () => events.some(e => e.kind === 'tool-start') && (await pids()).length >= 2, 'the MCP call in flight');
  const started = await pids();
  assert.ok(started.some(isAlive), `the server answering the call runs before the quit (pids ${started.join(', ')})`);

  await stopWorker(worker, 3000);
  await until(() => started.every(pid => !isAlive(pid)), `every MCP process gone after the quit (pids ${started.join(', ')})`, 10000);
});
```

In `electron/tests/worker-trust.test.mts`, replace lines 120-128:

```typescript
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  const trusted = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(trusted.tools, ['marker_tool']);
  assert.deepEqual(trusted.untrusted, []);
  const trustedServers = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(trustedServers.find((server: any) => server.scope === 'project').trusted, true, 'the project entry is listed as trusted once approved');
  assert.equal(await exists(pluginMarker), true, 'loaded once trusted');
  assert.equal(await exists(mcpMarker), true, 'started once trusted');
});
```

with:

```typescript
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  const trusted = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(trusted.tools, ['marker_tool']);
  assert.deepEqual(trusted.untrusted, []);
  const trustedServers = await callWorker(worker, 'mcp-list', { folder: project });
  const projectEntry = trustedServers.find((server: any) => server.scope === 'project');
  assert.equal(projectEntry.trusted, true, 'the project entry is listed as trusted once approved');
  assert.equal(projectEntry.tools, null, 'listed, not started: no turn has run it yet');
  assert.equal(await exists(pluginMarker), true, 'loaded once trusted');
  assert.equal(await exists(mcpMarker), false, 'the Outils tab (plugin-list, mcp-list) never starts an MCP server, even once trusted');
  const afterTrust = await turn(worker, project, connection);
  assert.equal(afterTrust.at(-1).kind, 'done');
  assert.equal(await exists(mcpMarker), true, 'started by the next turn, once trusted');
  const listedAfterTurn = await callWorker(worker, 'mcp-list', { folder: project });
  assert.deepEqual(listedAfterTurn.find((server: any) => server.scope === 'project').tools, ['mcp_echo', 'mcp_boom'], 'its tools are shown once a turn discovered them');
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/plugin-loader.test.mts tests/worker-plugin.test.mts tests/mcp-client.test.mts tests/worker-mcp.test.mts tests/worker-trust.test.mts`

Expected failures:
- The two `.py` loader tests: `errors` is `[]`.
- The worker `.py` test: `errors` is `[]`.
- The `mcpTools also says…` test: `servers` is undefined.
- The `Outils tab never starts…` test: the marker exists after `plugin-list`.
- The trust test: `the Outils tab … never starts` fails on the marker.

The quit test (`quitting the app…`) **may already pass**: MCP sessions are closed with `killTree` when the aborted call unwinds (ruling 16). Note whether it passes or fails; Step 7 depends on it.

- [ ] **Step 4: Implement gap 2 (`core/plugin-loader.mts`)**

Replace:

```typescript
async function pluginFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter(entry => entry.isFile() && PLUGIN_EXTENSIONS.has(extname(entry.name)) && !entry.name.startsWith('.') && !entry.name.startsWith('__init__'))
    .map(entry => join(dir, entry.name))
    .sort();
}
```

with:

```typescript
async function directoryFiles(dir: string): Promise<import('node:fs').Dirent[]> {
  try { return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('__init__')); }
  catch { return []; }
}

async function pluginFiles(dir: string): Promise<string[]> {
  return (await directoryFiles(dir))
    .filter(entry => PLUGIN_EXTENSIONS.has(extname(entry.name)))
    .map(entry => join(dir, entry.name))
    .sort();
}

/** The previous app's Python plugins in `dir`, selected like the .mjs ones (no hidden file, no __init__) — never
 * imported, never executed: only reported so the user knows they must be ported (parity row 32). */
async function pythonPluginNames(dir: string): Promise<string[]> {
  return (await directoryFiles(dir))
    .filter(entry => extname(entry.name).toLowerCase() === '.py')
    .map(entry => entry.name)
    .sort();
}

export function pythonPluginError(name: string): string {
  return `Plugin Python non pris en charge : ${name} — à réécrire en .mjs`;
}
```

In `loadPlugins`, replace:

```typescript
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
      }
    }
  }
  return { tools, errors };
}
```

with:

```typescript
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
      }
    }
    for (const name of await pythonPluginNames(dir)) errors.push(pythonPluginError(name));
  }
  return { tools, errors };
}
```

- [ ] **Step 5: Implement gap 3 (`mcp-config.mts`, `mcp-client.mts`, worker, UI)**

In `electron/core/mcp-config.mts`, replace:

```typescript
/** A server's identity for merge purposes: command+args (stdio) or url (remote) — not `name`,
 * since global entries (added via the UI's single command-line field) have none. */
function serverIdentity(server: McpServerConfig): string {
```

with:

```typescript
/** A server's identity for merge purposes: command+args (stdio) or url (remote) — not `name`,
 * since global entries (added via the UI's single command-line field) have none. Also the key under which
 * worker.mjs remembers the tools a turn discovered on a server (the Outils tab never starts one). */
export function serverIdentity(server: { command: string; args: string[] } | { url: string }): string {
```

In `electron/core/mcp-client.mts`, replace the block from `/** Discovers every configured server's tools in parallel,` through the end of `mcpTools` (lines 213-246) with:

```typescript
/** What one server exposed when a turn discovered it. worker.mjs remembers it for the Outils tab, which never starts
 * a server itself (parity row 33). */
export interface McpServerTools {
  target: McpTarget;
  toolNames: string[];
}

/** Discovers every configured server's tools in parallel, isolating a broken/slow/crashing server
 * from the rest — one bad entry in the MCP config must never keep the others from loading, the
 * same isolation agent.py's own try/except-per-server already had. Works identically for stdio and
 * remote (sse/http) targets. `servers` lists, per server that answered, the names of its tools. */
export async function mcpTools(
  targets: McpTarget[],
  options: { discoveryTimeoutMs?: number; callTimeoutMs?: number } = {},
): Promise<{ tools: AgentTool[]; errors: string[]; servers: McpServerTools[] }> {
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const errors: string[] = [];
  const servers: McpServerTools[] = [];
  const perServer = await Promise.all(targets.map(async target => {
    const missing = isRemoteTarget(target) ? !target.url?.trim() : !target.command?.trim();
    if (missing) { errors.push(`MCP : ${isRemoteTarget(target) ? 'URL' : 'commande'} absente`); return []; }
    let session: Session;
    try {
      session = await initialize(target, discoveryTimeoutMs);
    } catch (error) {
      errors.push(`MCP ${targetLabel(target)}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    try {
      const result = await session.request('tools/list', {});
      const remote: McpRemoteTool[] = Array.isArray(result?.tools) ? result.tools : [];
      const tools = remote.filter(t => typeof t.name === 'string' && t.name).map(t => toAgentTool(target, t, callTimeoutMs));
      servers.push({ target, toolNames: tools.map(tool => tool.name) });
      return tools;
    } catch (error) {
      errors.push(`MCP ${targetLabel(target)}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    } finally {
      await session.close();
    }
  }));
  return { tools: perServer.flat(), errors, servers };
}
```

In `electron/worker.mjs`, replace:

```javascript
import { McpConfigStore, readProjectMcpConfig, mergeServerConfigs, redactSecrets, expandServerPlaceholders } from './core/mcp-config.mts';
```

with:

```javascript
import { McpConfigStore, readProjectMcpConfig, mergeServerConfigs, redactSecrets, expandServerPlaceholders, serverIdentity } from './core/mcp-config.mts';
```

After `const sessionAllowed = new Set();` and `const allowKey = …;` (before `function forgetSessionAllowed`), insert:

```javascript
// Parity row 33: what each MCP server exposed the last time a TURN started it, keyed by serverIdentity (command +
// args, or URL, as the turn ran it — placeholders expanded). Only a turn starts a server; the Outils tab
// (plugin-list, mcp-list) only reads this map.
const mcpToolNames = new Map();
/** A server's tools as the Outils tab shows them: the names a turn discovered, or null when no turn started it. */
const rememberedTools = server => mcpToolNames.get(serverIdentity(server)) ?? null;
```

Replace the whole `nonPluginTools` function:

```javascript
/** Built-in + MCP tools for a real project folder — the project's .mcp.json servers only once the
 * project is trusted (never started or contacted before). */
async function nonPluginTools(folder, effective, projectTrust) {
  const projectServers = projectTrust.contentTrusted ? await readProjectMcpConfig(folder) : [];
  const merged = mergeServerConfigs(await mcpConfig.list(), projectServers);
  const { tools: mcpDiscovered, errors: mcpErrors } = await mcpTools(merged);
  // A broken/unreachable MCP server never blocks the turn or surfaces to the chat — same
  // server-log-only isolation agent.py's own logging.getLogger("openagentic.mcp").warning had.
  for (const error of mcpErrors) console.error(`[mcp] ${error}`);
  const builtIn = [
    ...await workspaceTools(folder, effective.ignored_patterns),
    ...await memoryTools(folder, dataHome),
    ...await gitTools(folder),
    ...projectTools(folder),
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome),
  ];
  return [...builtIn, ...mcpToolsBeside(mcpDiscovered, builtIn)];
}
```

with:

```javascript
/** The MCP servers a turn in `folder` runs: the global ones, plus the project's .mcp.json once the project is
 * trusted (never started or contacted before). Reading the config starts nothing. */
async function mcpServersFor(folder, projectTrust) {
  const projectServers = projectTrust.contentTrusted ? await readProjectMcpConfig(folder) : [];
  return mergeServerConfigs(await mcpConfig.list(), projectServers);
}

/** The built-in tools for a real project folder — building them starts no process. */
async function builtInTools(folder, effective) {
  return [
    ...await workspaceTools(folder, effective.ignored_patterns),
    ...await memoryTools(folder, dataHome),
    ...await gitTools(folder),
    ...projectTools(folder),
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome),
  ];
}

/** Built-in + MCP tools for a turn: the MCP servers are started here, and only here, to discover their tools. */
async function nonPluginTools(folder, effective, projectTrust) {
  const { tools: mcpDiscovered, errors: mcpErrors, servers } = await mcpTools(await mcpServersFor(folder, projectTrust));
  for (const { target, toolNames } of servers) mcpToolNames.set(serverIdentity(target), toolNames);
  // A broken/unreachable MCP server never blocks the turn or surfaces to the chat — same
  // server-log-only isolation agent.py's own logging.getLogger("openagentic.mcp").warning had.
  for (const error of mcpErrors) console.error(`[mcp] ${error}`);
  const builtIn = await builtInTools(folder, effective);
  return [...builtIn, ...mcpToolsBeside(mcpDiscovered, builtIn)];
}
```

In `mcpServersForDisplay`, replace:

```javascript
async function mcpServersForDisplay(folder) {
  const global = await mcpConfig.list();
  if (!folder) return global;
```

with:

```javascript
async function mcpServersForDisplay(folder) {
  // Every entry carries `tools` (rememberedTools): the names a turn discovered, or null — never started here.
  const global = (await mcpConfig.list()).map(server => ({ ...server, tools: rememberedTools(server) }));
  if (!folder) return global;
```

Then replace:

```javascript
  if (!contentTrusted) return [...global, ...asWritten.map(server => ({ ...server, trusted: false }))];
  const byId = new Map(asWritten.map(server => [server.id, server]));
  const merged = mergeServerConfigs(global, asWritten.map(server => expandServerPlaceholders(server)));
  return merged.map(server => (server.scope === 'project' ? { ...(byId.get(server.id) ?? server), trusted: true } : server));
}
```

with:

```javascript
  if (!contentTrusted) return [...global, ...asWritten.map(server => ({ ...server, trusted: false, tools: null }))];
  const byId = new Map(asWritten.map(server => [server.id, server]));
  const merged = mergeServerConfigs(global, asWritten.map(server => expandServerPlaceholders(server)));
  // The tools are looked up on the EXPANDED entry (what a turn runs); the entry shown stays as written.
  return merged.map(server => (server.scope === 'project' ? { ...(byId.get(server.id) ?? server), trusted: true, tools: rememberedTools(server) } : server));
}
```

In `handle`, replace the `plugin-list` `else` branch:

```javascript
      } else {
        const projectTrust = await trust.evaluate(folder);
        const effective = await settings.effective(folder, { approvedRelaxations: projectTrust.approvedRelaxations });
        const { tools, errors } = await pluginToolsBeside(folder, await nonPluginTools(folder, effective, projectTrust), projectTrust);
        result = { tools: tools.map(t => t.name), errors, untrusted: projectTrust.contentTrusted ? [] : projectTrust.inventory.plugins };
      }
```

with:

```javascript
      } else {
        const projectTrust = await trust.evaluate(folder);
        const effective = await settings.effective(folder, { approvedRelaxations: projectTrust.approvedRelaxations });
        // Parity row 33: the Outils tab never starts an MCP server. Plugin names are checked against the built-in tools
        // and the MCP tool names a turn already discovered — a server not started yet has no name to collide with.
        const remembered = (await mcpServersFor(folder, projectTrust)).flatMap(server => mcpToolNames.get(serverIdentity(server)) ?? []);
        const others = [...await builtInTools(folder, effective), ...remembered.map(name => ({ name }))];
        const { tools, errors } = await pluginToolsBeside(folder, others, projectTrust);
        result = { tools: tools.map(t => t.name), errors, untrusted: projectTrust.contentTrusted ? [] : projectTrust.inventory.plugins };
      }
```

In `electron/renderer-src/src/ipc/bridge.ts`, replace lines 185-186:

```typescript
export interface StdioServerConfig { id: string; name?: string; scope: 'global' | 'project'; command: string; args: string[]; env?: Record<string, string>; added_at?: string; trusted?: boolean }
export interface RemoteServerConfig { id: string; name?: string; scope: 'global' | 'project'; type: 'sse' | 'http'; url: string; headers?: Record<string, string>; added_at?: string; trusted?: boolean }
```

with:

```typescript
// `tools` (mcp-list only): the tool names the last turn discovered on this server, or null when no turn started it.
export interface StdioServerConfig { id: string; name?: string; scope: 'global' | 'project'; command: string; args: string[]; env?: Record<string, string>; added_at?: string; trusted?: boolean; tools?: string[] | null }
export interface RemoteServerConfig { id: string; name?: string; scope: 'global' | 'project'; type: 'sse' | 'http'; url: string; headers?: Record<string, string>; added_at?: string; trusted?: boolean; tools?: string[] | null }
```

In `electron/renderer-src/src/components/settings/ToolsTab.tsx`, replace:

```tsx
                {servers.map(server => (
                  <div key={server.id} data-testid="oa-mcp-entry" data-scope={server.scope} className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${server.trusted === false ? 'opacity-50' : ''}`} style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                    <span className="truncate font-mono text-xs text-blue-400">
                      {server.scope === 'project' && <span data-testid="oa-mcp-project-badge" className="mr-1 rounded bg-purple-900 px-1 text-[10px] text-purple-300">projet</span>}
                      {server.trusted === false && <span data-testid="oa-mcp-untrusted-badge" className="mr-1 rounded bg-gray-800 px-1 text-[10px] text-gray-400">non approuvé</span>}
                      {serverLabel(server)}
                      {secretNames(server) && <span data-testid="oa-mcp-secret-names" className="ml-2 font-sans text-[10px] text-gray-500">{secretNames(server)}</span>}
                    </span>
                    <button
                      data-testid="oa-mcp-remove"
                      onClick={() => void handleRemove(server.id)}
                      disabled={server.scope === 'project'}
                      className="shrink-0 text-xs text-gray-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                      title={server.scope === 'project' ? 'Géré par .mcp.json, pas depuis l’app' : 'Retirer'}
                    >
                      ✕
                    </button>
                  </div>
                ))}
```

with:

```tsx
                {servers.map(server => (
                  <div key={server.id} data-testid="oa-mcp-entry" data-scope={server.scope} className={`flex flex-col gap-1 rounded px-2 py-1 ${server.trusted === false ? 'opacity-50' : ''}`} style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-blue-400">
                        {server.scope === 'project' && <span data-testid="oa-mcp-project-badge" className="mr-1 rounded bg-purple-900 px-1 text-[10px] text-purple-300">projet</span>}
                        {server.trusted === false && <span data-testid="oa-mcp-untrusted-badge" className="mr-1 rounded bg-gray-800 px-1 text-[10px] text-gray-400">non approuvé</span>}
                        {serverLabel(server)}
                        {secretNames(server) && <span data-testid="oa-mcp-secret-names" className="ml-2 font-sans text-[10px] text-gray-500">{secretNames(server)}</span>}
                      </span>
                      <button
                        data-testid="oa-mcp-remove"
                        onClick={() => void handleRemove(server.id)}
                        disabled={server.scope === 'project'}
                        className="shrink-0 text-xs text-gray-500 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-30"
                        title={server.scope === 'project' ? 'Géré par .mcp.json, pas depuis l’app' : 'Retirer'}
                      >
                        ✕
                      </button>
                    </div>
                    {/* Opening this tab never starts a server: its tools are those a turn discovered, if any. */}
                    {server.trusted !== false && (Array.isArray(server.tools) ? (
                      <span data-testid="oa-mcp-tools" className="truncate font-mono text-[10px] text-gray-400">
                        {server.tools.length ? server.tools.join(', ') : 'aucun outil'}
                      </span>
                    ) : (
                      <span data-testid="oa-mcp-not-started" className="text-[10px] text-gray-500">non démarré — ses outils seront chargés au prochain message</span>
                    ))}
                  </div>
                ))}
```

- [ ] **Step 6: Run the gap 2/3 tests and the extension neighbours**

Run: `cd electron && node --experimental-strip-types --test tests/plugin-loader.test.mts tests/worker-plugin.test.mts tests/mcp-client.test.mts tests/worker-mcp.test.mts tests/worker-trust.test.mts tests/mcp-config.test.mts tests/project-trust.test.mts tests/main-shutdown.test.mts`
Expected:
- all PASS, apart from the possible quit test failure below;
- `worker-mcp.test.mts`'s `quitting the app…` test either PASSes (go to Step 8) or FAILs with `timed out waiting for every MCP process gone after the quit` (go to Step 7).

- [ ] **Step 7: ONLY if the quit test failed: stop every live MCP process at shutdown**

In `electron/core/mcp-client.mts`, replace:

```typescript
import { spawn } from 'node:child_process';
```

with:

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
```

Before `/** A short-lived JSON-RPC 2.0 session over stdio`, insert:

```typescript
// Every stdio MCP process still running (a discovery or a call in flight), so the app can stop them when it quits:
// a worker thread's termination does not end the processes it spawned.
const liveChildren = new Set<ChildProcess>();

/** Kills every MCP process still running, whole process trees included — called by worker.mjs's 'shutdown'. */
export async function stopAllMcpServers(): Promise<void> {
  await Promise.all([...liveChildren].map(child => killTree(child).catch(() => {})));
  liveChildren.clear();
}
```

In `openStdioSession`, replace:

```typescript
    windowsHide: true,
  });
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
```

with:

```typescript
    windowsHide: true,
  });
  liveChildren.add(child);
  child.on('exit', () => liveChildren.delete(child));
  child.on('error', () => liveChildren.delete(child));
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
```

In `electron/worker.mjs`, replace:

```javascript
import { mcpTools } from './core/mcp-client.mts';
```

with:

```javascript
import { mcpTools, stopAllMcpServers } from './core/mcp-client.mts';
```

and in the `shutdown` op replace:

```javascript
      for (const run of active.values()) run.controller.abort();
      await stopAllServers();
      result = { stopped: true };
```

with:

```javascript
      for (const run of active.values()) run.controller.abort();
      // MCP processes too: a call in flight would otherwise outlive the app (its session closes only when it unwinds).
      await Promise.all([stopAllServers(), stopAllMcpServers()]);
      result = { stopped: true };
```

Re-run: `cd electron && node --experimental-strip-types --test tests/worker-mcp.test.mts tests/mcp-client.test.mts tests/main-shutdown.test.mts tests/worker-tools.test.mts`
Expected: all PASS. The bilan records that the test failed first and was fixed.

- [ ] **Step 8: Window assertions (`plugin-visual.cjs`, `mcp-visual.cjs`)**

In `electron/tests/plugin-visual.cjs`, replace:

```javascript
  await writeFile(join(home, 'tools', 'broken.mjs'), `export const notGetTools = true;`);
```

with:

```javascript
  await writeFile(join(home, 'tools', 'broken.mjs'), `export const notGetTools = true;`);
  await writeFile(join(home, 'tools', 'legacy.py'), 'def get_tools():\n    return []\n');
```

and replace:

```javascript
    await waitFor(() => exists('[data-testid="oa-plugin-error"]'), { what: 'the broken plugin error is shown' });
    assert.match(await text('[data-testid="oa-plugin-error"]'), /broken\.mjs/);
```

with:

```javascript
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid="oa-plugin-error"]').length`)) === 2, { what: 'the broken plugin and the legacy .py are both reported' });
    const pluginErrors = await js(`[...document.querySelectorAll('[data-testid="oa-plugin-error"]')].map(e => e.textContent)`);
    assert.ok(pluginErrors.some(error => /broken\.mjs/.test(error)), `the broken .mjs is reported — got ${JSON.stringify(pluginErrors)}`);
    assert.ok(pluginErrors.some(error => error.endsWith('Plugin Python non pris en charge : legacy.py — à réécrire en .mjs')), `the legacy .py is reported as to port — got ${JSON.stringify(pluginErrors)}`);
    assert.equal(await js(`[...document.querySelectorAll('[data-testid="oa-plugin-entry"]')].some(e => e.textContent.includes('legacy'))`), false, 'and never loaded');
```

In `electron/tests/mcp-visual.cjs`, replace:

```javascript
    assert.match(await text('[data-testid="oa-mcp-entry"]'), /npx.*server-filesystem/);
```

with:

```javascript
    assert.match(await text('[data-testid="oa-mcp-entry"]'), /npx.*server-filesystem/);
    assert.equal(await text('[data-testid="oa-mcp-not-started"]'), 'non démarré — ses outils seront chargés au prochain message', 'listed without being started (parity row 33)');
```

and replace:

```javascript
    assert.equal(projectEntryRemoveDisabled, true, 'a project-scope server cannot be removed from the UI');
```

with:

```javascript
    assert.equal(projectEntryRemoveDisabled, true, 'a project-scope server cannot be removed from the UI');
    assert.equal(await exists('[data-testid="oa-mcp-entry"][data-scope="project"] [data-testid="oa-mcp-not-started"]'), false, 'an unapproved project server is « non approuvé », not « non démarré »: no message will start it');
```

- [ ] **Step 9: Type-check, build, run the two touched window tests ONCE each**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json; npx tsc --noEmit -p renderer-src/tsconfig.json; npm run renderer:build`
Expected: core shows the 5 pre-existing errors only, the renderer shows 0, and the build exits 0.

Run: `cd electron && npm run test:plugins`
Expected: `PASS plugin section…`, exit code 0.

Run: `cd electron && npm run test:mcp`
Expected: `PASS mcp tab…`, exit code 0.

Run each once; on failure, report and stop. Look at `plugin-1-list.png` and `mcp-2-added.png`.

- [ ] **Step 10: Commit and push**

If Step 7 was **not** needed:

```bash
git add electron/core/plugin-loader.mts electron/core/mcp-client.mts electron/core/mcp-config.mts electron/worker.mjs electron/renderer-src/src/ipc/bridge.ts electron/renderer-src/src/components/settings/ToolsTab.tsx electron/tests/fixtures/fake-mcp-server.cjs electron/tests/plugin-loader.test.mts electron/tests/worker-plugin.test.mts electron/tests/mcp-client.test.mts electron/tests/worker-mcp.test.mts electron/tests/worker-trust.test.mts electron/tests/plugin-visual.cjs electron/tests/mcp-visual.cjs
git commit -m "fix: legacy .py plugins are reported as to port and never loaded, and the Outils tab lists MCP servers without starting them (tools shown once a turn discovered them)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

If Step 7 **was** needed, use the same `git add` line, and this message instead:

```bash
git commit -m "fix: legacy .py plugins are reported as to port and never loaded, the Outils tab lists MCP servers without starting them, and quitting stops an MCP call still in flight" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

---

### Task 5: Closure — full verification, checklist, bilan

**Files:**
- Modify: `tasks/todo.md` (header line 3, checklist lines 5-16, paragraph lines 18-19, bilan appended at the end)
- Modify: `tasks/lessons.md` (one line appended)

**Interfaces:**
- Consumes: the commits of Tasks 1–4, and the outputs of every run below. The bilan quotes the numbers actually read, never these expectations.

- [ ] **Step 1: Full suite**

Run: `cd electron && node --experimental-strip-types --test tests/all.mts`
Expected: **751/751** pass (726 + 25). Record the exact numbers. If any test fails, stop. Fix only a real defect of this lot, then re-run the suite; the suite opens no window.

- [ ] **Step 2: tsc, both projects**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json; npx tsc --noEmit -p renderer-src/tsconfig.json`
Expected:
- core shows exactly the 5 pre-existing errors: local-engine.mts, local-provider.mts, pdf-loader.ts, local-provider.test.mts ×2;
- the renderer shows 0.

- [ ] **Step 3: Package, then the package smoke test ONCE**

Run: `cd electron && npm run package:win`
Expected: exit code 0. The renderer is rebuilt; Task 4 changed it after Task 3's package.

Run: `cd electron && npm run test:package`
Expected: `PASS packaged executable launches outside npm start and loads the real UI`.
- This proves the packaged `main.cjs` starts with its dynamic import of `core/data-dir.mts` and the new `trayMenuTemplate`.
- Run it once; on failure, report and stop.

- [ ] **Step 4: Confirm every window test touched by this lot ran exactly once, and do not run any again**

| Test | Task | Command |
|---|---|---|
| `settings-tabs-visual.cjs` | Task 1, Step 13 | `npm run test:settings-tabs` |
| `restore-folder-visual.cjs` | Task 2, Step 9 | `npm run test:restorefolder` |
| `final-e2e-tray.cjs` | Task 3, Step 9 | `npm run test:final-e2e-tray` |
| `plugin-visual.cjs` | Task 4, Step 9 | `npm run test:plugins` |
| `mcp-visual.cjs` | Task 4, Step 9 | `npm run test:mcp` |
| `package-smoke.cjs` | Step 3 above | `npm run test:package` |

Record each result (PASS, or the reported failure) for the bilan.

- [ ] **Step 5: Rewrite the migration checklist and its header in `tasks/todo.md`**

Line 3: replace

```markdown
## Migration 2026-09-14-electron-autonomous — CONCEPTION, NON LIVRÉE
```

with the header below. This assumes every proof of Steps 1–4 passed. If one failed, write instead `## Migration 2026-09-14-electron-autonomous — NON LIVRÉE : <the failed proof, named exactly>`.

```markdown
## Migration 2026-09-14-electron-autonomous — LIVRÉE SAUF : finitions des lignes 2, 6, 7, 14, 16, 18 et 30 de la matrice de parité (dernière case, hors lot par décision du 2026-10-04)
```

Replace the line beginning `- [ ] Stockage Node :` with:

```markdown
- [x] Stockage Node : migrations sauvegardées, settings globaux/projet distincts, secrets, isolation de projets et branches ; tests temporaires. — preuve : reprise des données Python vérifiée en lecture seule sur une copie du dossier réel (2026-10-04, résumé dans `docs/superpowers/specs/2026-10-04-migration-closure-design.md`) : réglages, connexion et conversations se chargent, chaque première écriture garde `.pre-electron.bak` ; les quatre risques relevés sont corrigés et testés (R1 historique des dossiers sans doublons, R2 rétention qui archive au lieu d'effacer, R3 rôles `ai`/`human` affichés, R4 migration complète du dossier de données, coffre compris) : Bilan du lot — clôture de la migration (2026-10-04) ; sauvegarde avant transformation : `storage.test.mts` « atomic updates preserve every concurrent increment and the original backup » ; réglages global/projet : Bilan du lot — confiance par projet (2026-10-02) ; secrets : Bilan du lot — MCP enrichi (2026-10-01) ; branches : `worker-branches.test.mts`, `final-e2e-lot4.cjs`.
```

Replace the line beginning `- [ ] Modèles locaux, téléchargements,` with:

```markdown
- [x] Modèles locaux `.gguf` intégrés, index/BDC, extensions et MCP sans Python (catalogue Hugging Face, Ollama, LM Studio abandonnés le 2026-09-27) — preuve : modèles locaux (Bilan du lot fournisseur local `.gguf`, 2026-09-27) ; index/BDC (Bilan du lot — `index_status` …, 2026-09-30 → 2026-10-01) ; extensions (Bilan du lot — système de plugins Node, 2026-10-01), anciens plugins `.py` signalés et jamais chargés (Bilan du lot — clôture de la migration (2026-10-04)) ; MCP (Bilan du lot — MCP enrichi, 2026-10-01), l'onglet Outils ne démarre plus aucun serveur (même bilan de clôture).
```

Replace the line beginning `- [ ] Vérifier chaque ligne de la matrice de parité` with:

```markdown
- [x] Vérifier chaque ligne de la matrice de parité et corriger ses vrais écarts. — preuve : audit ligne à ligne `docs/superpowers/specs/2026-10-04-parity-matrix-audit.md` (23 prouvées, 5 décisions délibérées, 10 partielles) ; les trois vrais écarts corrigés et testés dans le Bilan du lot — clôture de la migration (2026-10-04) : ligne 1 (la croix envoie dans la zone de notification), ligne 32 (plugins `.py` signalés), ligne 33 (l'onglet Outils ne démarre pas les serveurs MCP). Les finitions des sept autres lignes partielles sont la dernière case.
```

Replace the line beginning `- [ ] Commit/push des changements propres` with the following. Fill `<commits>` with the hashes printed by `git log --oneline -6` for this lot's commits, Tasks 1 to 5:

```markdown
- [x] Commit/push des changements propres et preuves de validation. — preuve : commits du lot de clôture <commits> poussés sur `origin/master` ; suite, tsc, `package:win` et `test:package` dans le Bilan du lot — clôture de la migration (2026-10-04). Les modifications de docs non commitées de l'utilisateur restent volontairement en l'état.
- [ ] Finitions des lignes partielles de la matrice, hors lot par décision du 2026-10-04 — reste : ligne 2 (saisie d'un chemin absente ; chemin et date jamais assertés) ; ligne 6 (détail d'outil absent, diff d'édition absent, badge d'outil perdu au rechargement d'une conversation — une régression —, blocs de code et défilement non testés) ; ligne 7 (Shift+Entrée et double envoi non testés) ; ligne 14 (toast d'échec d'export non prouvé dans l'interface) ; ligne 16 (changement d'accent non testé) ; ligne 18 (`search_ask` non testé) ; ligne 30 (fichier modifié puis réindexé non testé). Détail et tests proposés : `docs/superpowers/specs/2026-10-04-parity-matrix-audit.md`, « Lignes non prouvées ».
```

Replace the two-line paragraph after the list:

```markdown
Le shell Electron/pont Python précédent existe encore ; ses anciennes cases cochées
ne prouvaient ni la parité ni l'autonomie. Ne pas annoncer la migration terminée.
```

with:

```markdown
Le pont Python a été retiré (2109f99) ; l'application Python reste atteignable au tag `python-final`.
Ne pas annoncer la migration entièrement terminée tant que la dernière case reste ouverte.
```

- [ ] **Step 6: Append the bilan at the END of `tasks/todo.md`**

Append the section below. Bracketed fields are filled from the outputs recorded in Steps 1–4 and in Tasks 1–4; nothing is written that was not observed.

```markdown

### Bilan du lot — clôture de la migration (2026-10-04)

Conception : `docs/superpowers/specs/2026-10-04-migration-closure-design.md` ; plan : `docs/superpowers/plans/2026-10-04-migration-closure.md` ; audit : `docs/superpowers/specs/2026-10-04-parity-matrix-audit.md`.

**Données Python sûres :**
- R1 — `folders.json` : chaque entrée est ramenée à une clé canonique (`realpath`, sinon chemin résolu ; casse ignorée sous Windows), les doublons fusionnés en gardant la date la plus récente (comparée en temps : Python écrivait l'heure locale, Electron l'heure UTC) ; le fichier est réécrit une fois, l'original reste dans `folders.json.pre-electron.bak`. Tests : `folders.test.mts` (4 tests « R1: »), `cleanup.test.mts` « R1 + R2 … ».
- R2 — la rétention déplace `conversations.json` et `chat_history.json` dans `<dossier de données>/retention-archive/<AAAA-MM-JJ>/<nom>-<sha8>/` (jour local, SHA-256 du chemin canonique) ; jamais `rm` ; un déplacement impossible laisse le fichier en place et est journalisé `[rétention]`. Phrase ajoutée sous le choix de rétention (Réglages › Contexte). Tests : `cleanup.test.mts`, `worker-cleanup.test.mts`, `settings-tabs-visual.cjs` [résultat].
- R3 — `ai`/`human` servis comme `assistant`/`user` à l'activation, au chargement d'une branche, à la fin d'une compaction et dans un tour ; le fichier n'est pas réécrit par une lecture. Tests : `worker-folders.test.mts` « R3: … », `worker-compact.test.mts` « R3: … », `restore-folder-visual.cjs` section E [résultat].
- R4 — `migrateDataDir` déplace tout, sous-dossiers compris (`core/safe-move.mts` : `rename` sur le même disque, sinon copie vérifiée octet par octet puis suppression ; jamais par-dessus une entrée existante) ; `main.cjs::resolveMainDataHome` suit `redirect.json` comme le worker, le coffre suit. Tests : `data-dir.test.mts`, `safe-move.test.mts`, `main-data-home.test.mts`.

**Écarts de parité comblés :**
- Ligne 1 — la croix masque la fenêtre (app, worker, icône actifs) ; « Ouvrir » / clic sur l'icône / relance la réaffichent ; « Quitter », « Redémarrer maintenant » et la fin de session Windows quittent. Commentaire faux de `main.cjs` corrigé. Preuve : `final-e2e-tray.cjs` sur l'exécutable packagé [PROOF 1 à 5 : résultats] ; `tray-icon.test.mts` (menu : « Ouvrir openagent » → `showMainWindow`, « Quitter » → `app.quit`).
- Ligne 32 — un `.py` dans `<données>/tools`, `<projet>/tools` ou `<projet>/.openagent/tools` (projet approuvé) est signalé `Plugin Python non pris en charge : <nom>.py — à réécrire en .mjs` et jamais importé. Tests : `plugin-loader.test.mts`, `worker-plugin.test.mts`, `plugin-visual.cjs` [résultat].
- Ligne 33 — `plugin-list` et `mcp-list` ne démarrent aucun serveur ; un serveur démarré par un tour affiche ses outils mémorisés, les autres « non démarré — ses outils seront chargés au prochain message ». Le test de `worker-trust.test.mts` qui assertait le démarrage est inversé. Arrêt à la fermeture : [« le test passait sans correction » OU « le test échouait ; corrigé par `stopAllMcpServers` dans l'op `shutdown` »]. Tests : `worker-mcp.test.mts` (2), `mcp-client.test.mts`, `worker-trust.test.mts`, `mcp-visual.cjs` [résultat].

**Décisions prises en écrivant le plan** : les 18 décisions de la section « Global Constraints » du plan, dont : jour local de l'archive ; jamais d'écrasement (y compris à la migration, qui écrasait avant un fichier de même nom) ; normalisation aussi à la fin d'une compaction ; outils MCP exposés dans `mcp-list` (champ `tools`) ; aucun test e2e existant adapté (ils quittent par `Browser.close`, qui est `app.quit()` dans Electron), leur message « the app exited after the window was closed » restant une formulation inexacte.

**Vérifications finales (depuis `electron/`)** :
- suite complète : [N]/[N] ;
- `tsc` cœur : [5 erreurs préexistantes seulement] ; renderer : [0] ;
- `npm run package:win` : [sortie] ; `npm run test:package`, lancé une seule fois : [résultat] ;
- tests à fenêtre de ce lot, chacun lancé une seule fois : `test:settings-tabs` [résultat], `test:restorefolder` [résultat], `test:final-e2e-tray` [résultat], `test:plugins` [résultat], `test:mcp` [résultat].

**Ce que ce lot ne couvre pas** : les finitions des lignes 2, 6, 7, 14, 16, 18 et 30 de la matrice (dernière case de la migration) ; le vidage de `retention-archive/` (jamais automatique, volontairement) ; une notification « l'app tourne toujours » à la première fermeture ; l'export d'une conversation démarre encore les serveurs MCP (il appelle `registerTools` pour les catégories d'outils) — hors des trois écarts, à décider ; une migration entre deux disques n'a été prouvée qu'en pilotant `copyThenRemove` sur un seul disque (aucun second disque dans les tests) ; `test:install` et les e2e `final-e2e*` antérieurs n'ont pas été relancés.
```

- [ ] **Step 7: Append the lesson to `tasks/lessons.md`**

Append this line:

```markdown
2026-10-04 | `folders.json` gardait chaque projet deux fois (`C:/…` écrit par Python, `C:\…` par Electron) et la rétention effaçait l'historique d'un projet ouvert la veille, parce que la vieille entrée Python avait expiré | `recordOpened` ne dédupliquait que sur la chaîne exacte, et le nettoyage faisait `rm` au lieu d'archiver | Une clé de chemin persistée se compare toujours sous forme canonique (`realpath`, sinon chemin résolu, casse ignorée sous Windows) et ses dates comme des temps, jamais comme des chaînes ; une purge automatique de données utilisateur déplace dans une archive, jamais `rm`
```

- [ ] **Step 8: Commit and push**

```bash
git add tasks/todo.md tasks/lessons.md
git commit -m "docs: migration checklist closed with its proofs, and the bilan of the migration-closure lot (Python data made safe, parity rows 1, 32 and 33)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```

- [ ] **Step 9: Capitalise the general facts in `D:\BDC`**

Read `D:\BDC\Accueil.md` and `D:\BDC\Conventions.md` first; they decide the note format. Search the vault for an existing note on Electron's quit behaviour before creating one. Then record these two facts, with `statut: vérifié`:

1. **CDP `Browser.close` quits an Electron app; it does not close a window.**
   - Electron's `DevToolsManagerDelegate` maps it to `Browser::Get()->Quit()`, the same path as `app.quit()`: `before-quit`, then every window closed, and a cancelled close cancels the quit.
   - How we know: `shell/browser/ui/devtools_manager_delegate.cc` and `shell/browser/browser.cc` read on GitHub on 2026-10-04, plus `final-e2e-tray.cjs` PROOF 4.
2. **On Windows, Electron 44.4.2 ends the process on `WM_ENDSESSION`.**
   - It first emits `session-end` on each window, then calls `TerminateCurrentProcessImmediately(0)` unless a quit is already in progress. No `close` event and no `before-quit` are involved.
   - How we know: `shell/browser/native_window_views_win.cc` at tag `v44.4.2`, plus `final-e2e-tray.cjs` PROOF 5.

Commit and push `D:\BDC` according to its own conventions, adding only the note file(s) written.

---

## Self-Review

**1. Spec coverage**

| Spec point | Where |
|---|---|
| R1 canonical key, merge with most recent date, rewrite once with `.pre-electron.bak`, `recordOpened` same key, cleanup sees merged entries | Task 1, Steps 5, 8; cleanup test « R1 + R2 » |
| R2 move to `retention-archive/<day>/<name>-<sha8>/`, never `rm`, failure leaves the file and logs, nothing empties the archive, Contexte sentence | Task 1, Steps 6, 9, 11 |
| R3 `ai`→`assistant`, `human`→`user` on activation and branch load; file not rewritten | Task 2, Steps 1, 4 (plus compaction, ruling 7) |
| R4 whole tree with verified copy; main resolves the data home like the worker; vault follows | Task 2, Steps 2, 5, 6 |
| Gap 1 close hides; Ouvrir, click and relaunch show; Quitter, update restart and session end quit; clean path unchanged; comment fixed | Task 3, Steps 2–8 |
| Gap 1 existing tests adapted | Task 3, Step 1 (none found, ruling 12) |
| Gap 2 `.py` reported with the exact string, never run, trust rules as `.mjs` | Task 4, Steps 1, 4, 8 |
| Gap 3 `plugin-list` starts nothing; cached tools vs « non démarré … »; discovery on a turn; inverted test; quit stops MCP processes | Task 4, Steps 2, 5–8 |
| Tests: suite, tsc, `package:win`, `test:package` | Task 5, Steps 1–3 |
| Closure: checklist boxes with proof, models box rewritten verbatim, header LIVRÉE or exactly what remains | Task 5, Step 5 |
| Audit report « versé » | already committed in `6d0a7a1` (`docs/superpowers/specs/2026-10-04-parity-matrix-audit.md`); nothing to do |
| Out of scope (7 partial lines, archive emptying, first-close notification) | recorded in the bilan and the new open box |

**2. Placeholder scan.** No TBD or TODO, and every code step carries its code. The bracketed fields in the Task 5 bilan, and `<commits>`, are execution results by nature: suite counts, run outcomes and commit hashes. Each says where its value comes from.

**3. Type consistency.**
- `cleanupOldFolders(folders, retentionDays, home, now?)` → `{ cleaned, failed }` is used identically in `cleanup.mts`, `worker.mjs` and the tests.
- `moveEntry` / `copyThenRemove` / `sameContent` are defined in Task 1 and consumed in Task 2.
- `resolveMainDataHome(env?, userHome?)` is the same in `main.cjs`, `main.d.cts` and `main-data-home.test.mts`.
- `trayMenuTemplate({ open, quit })` is the same in `tray-icon.cjs`, `main.cjs` and `tray-icon.test.mts`.
- `mcpTools(...).servers: { target, toolNames }[]` matches between `mcp-client.mts`, the worker and `mcp-client.test.mts`.
- `serverIdentity` is exported once and used in the worker.
- `tools: string[] | null` is the same in the worker, `bridge.ts`, `ToolsTab.tsx` and the tests.
- `pythonPluginError(name)` and the literal strings in the tests agree.
