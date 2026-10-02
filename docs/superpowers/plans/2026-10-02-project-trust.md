# Project Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing a project brings that can run code or widen the agent's permissions — its plugins, its `.mcp.json` servers, its permission relaxations — is applied until the user approves that project, with the approval remembered per content fingerprint.

**Architecture:** One central read-only module, `core/project-trust.mts` (`ProjectTrustService`), inventories a project's sensitive content WITHOUT importing or running any of it, fingerprints it, and keeps a user-level registry (`<data home>/trusted-projects.json`). `worker.mjs` asks it once per turn / per Outils-tab request and only then decides what to load: `loadPlugins` gains an `includeProject` switch, project `.mcp.json` servers only join the merge when trusted, and `SettingsService.effective` applies a project relaxation only when its exact value was approved. A non-blocking banner (`ProjectTrustBanner.tsx`) and a row in the Outils tab let the user decide.

**Tech Stack:** TypeScript `.mts` run by Node's type stripping (Node v24), `node:crypto` SHA-256, the existing `JsonStore`, React 19 + Tailwind renderer, real Electron for UI proof.

**Spec:** `docs/superpowers/specs/2026-10-02-project-trust-design.md`

## Global Constraints

- The registry lives at `<data home>/trusted-projects.json`, keyed by the project's `realpath`. It is NEVER written inside a project.
- Fail closed, never open: a missing/corrupt registry, an unreadable plugin file, or an unresolvable project path means "not approved" — never "approved".
- A project's plugin files are never imported (their top-level code never runs) and its `.mcp.json` servers are never spawned or contacted until the project is trusted. Global content (`<data home>/tools`, `<data home>/mcp.json`) is never gated.
- Relaxation = a project value more permissive than the global one: `shell_ask`/`files_ask`/`search_ask` `false` while the global is `true` (only with `override_permissions: true`); `permission_mode` less strict than global (severity `strict` > `demander` > `auto`, only with `override_permissions: true`); `agent_mode` `auto` while the global is `ask` or `plan`. A stricter-or-equal project value is never a relaxation and always applies.
- A relaxation applies only when its current project value equals the approved value for that field.
- An app-made write (the persistent "Toujours" of `permission-decision`, `save-project-settings`, and the folder branch of `save_settings`) approves ONLY the fields it wrote — never a value the repository already contained.
- "Ignorer" refuses only what is pending: it never revokes an already-approved relaxation, nor flips already-trusted content.
- A trust decision carries the `token` the user was shown; a stale token is refused with `Le contenu du projet a changé depuis l’affichage : relis la liste avant de décider.`
- Ruling made while writing this plan (the spec says the corrupt registry is "not rewritten blindly, the next decision rewrites it, JsonStore keeping a backup", but `JsonStore.update` itself throws on unreadable JSON): a corrupt registry is MOVED ASIDE to `trusted-projects.json.corrupt-<timestamp>` (kept, never deleted) by the next decision, which then writes a fresh registry.
- Every new behavior gets a real test written first: real temp folders, real files, real worker threads, real child processes, real Electron — no mocks.
- Each new test file is registered in `electron/tests/all.mts` in the task that creates it.

---

### Task 1: `SettingsService` — relaxations and gated `effective()`

**Files:**
- Modify: `electron/core/settings.mts` (add exports after `projectRules`, replace `effective()` at lines 115-123)
- Create: `electron/tests/settings-relaxations.test.mts`
- Modify: `electron/tests/all.mts` (register the new file)

**Interfaces:**
- Produces: `export type Relaxations = Record<string, { project: unknown; global: unknown }>`
- Produces: `export const RELAXABLE_KEYS: readonly string[]` — `['permission_mode', 'shell_ask', 'files_ask', 'search_ask', 'agent_mode']`
- Produces: `export function relaxationsOf(global: Record<string, any>, project: Record<string, any>): Relaxations`
- Produces: `SettingsService.effective(folder: string, options?: { approvedRelaxations?: Record<string, unknown> }): Promise<Record<string, any>>` — without `approvedRelaxations`, NO relaxation applies.

- [ ] **Step 1: Write the failing tests**

Create `electron/tests/settings-relaxations.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-relaxations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const { SettingsService } = await import('../core/settings.mts');
  return { home, project, settings: new SettingsService(home) };
}

test('relaxationsOf lists only values more permissive than the global ones', async () => {
  const { relaxationsOf, globalDefaults, projectDefaults } = await import('../core/settings.mts');
  const global = { ...globalDefaults, shell_ask: true, files_ask: false, permission_mode: 'demander', agent_mode: 'ask' };
  const project = {
    ...projectDefaults, override_permissions: true,
    shell_ask: false, files_ask: false, search_ask: true, permission_mode: 'auto', agent_mode: 'auto',
  };
  assert.deepEqual(relaxationsOf(global, project), {
    permission_mode: { project: 'auto', global: 'demander' },
    shell_ask: { project: false, global: true },
    agent_mode: { project: 'auto', global: 'ask' },
  });
});

test('relaxationsOf ignores permission fields when override_permissions is off, and stricter values always', async () => {
  const { relaxationsOf, globalDefaults, projectDefaults } = await import('../core/settings.mts');
  const global = { ...globalDefaults, shell_ask: true, permission_mode: 'demander', agent_mode: 'plan' };
  assert.deepEqual(relaxationsOf(global, { ...projectDefaults, shell_ask: false, permission_mode: 'auto' }), {});
  assert.deepEqual(relaxationsOf(global, { ...projectDefaults, override_permissions: true, permission_mode: 'strict' }), {});
  assert.deepEqual(relaxationsOf(global, { ...projectDefaults, agent_mode: 'ask' }), {}, 'ask and plan are both read-only');
});

test('effective() ignores a repo-shipped relaxation unless its exact value was approved', async t => {
  const { project, settings } = await fixture(t);
  await settings.saveProject(project, { override_permissions: true, shell_ask: false, permission_mode: 'auto' });

  const untrusted = await settings.effective(project);
  assert.equal(untrusted.shell_ask, true, 'global default applies');
  assert.equal(untrusted.permission_mode, 'demander', 'global default applies');

  const partly = await settings.effective(project, { approvedRelaxations: { shell_ask: false, permission_mode: 'strict' } });
  assert.equal(partly.shell_ask, false, 'approved at this exact value');
  assert.equal(partly.permission_mode, 'demander', 'approved value differs from the current one');
});

test('effective() always applies a stricter project value, without any approval', async t => {
  const { project, settings } = await fixture(t);
  await settings.saveProject(project, { override_permissions: true, files_ask: true, permission_mode: 'strict' });
  const effective = await settings.effective(project);
  assert.equal(effective.files_ask, true);
  assert.equal(effective.permission_mode, 'strict');
});

test('effective() keeps a read-only global agent_mode against a project "auto" unless approved', async t => {
  const { project, settings } = await fixture(t);
  await settings.saveGlobal({ agent_mode: 'ask' });
  await settings.saveProject(project, { agent_mode: 'auto' });
  assert.equal((await settings.effective(project)).agent_mode, 'ask');
  assert.equal((await settings.effective(project, { approvedRelaxations: { agent_mode: 'auto' } })).agent_mode, 'auto');
});
```

Register it in `electron/tests/all.mts` — add as the last line:

```typescript
import './settings-relaxations.test.mts';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/settings-relaxations.test.mts`
Expected: FAIL — `relaxationsOf` is not exported, and `effective()` still applies `shell_ask: false` / `permission_mode: 'auto'` from the project and `agent_mode: 'auto'`.

- [ ] **Step 3: Implement**

In `electron/core/settings.mts`, add right after the `projectRules` constant:

```typescript
export type Relaxations = Record<string, { project: unknown; global: unknown }>;
/** Fields a project can use to make the agent MORE permissive than the global settings. */
export const RELAXABLE_KEYS: readonly string[] = [...Object.keys(permissionRules), 'agent_mode'];
const PERMISSION_MODE_RANK: Record<string, number> = { auto: 0, demander: 1, strict: 2 };
const READ_ONLY_MODES = new Set(['ask', 'plan']);

/** True when using `project` for `key` instead of `global` would make the agent more permissive. */
function isRelaxation(key: string, project: unknown, global: unknown): boolean {
  if (key === 'shell_ask' || key === 'files_ask' || key === 'search_ask') return project === false && global === true;
  if (key === 'permission_mode') return PERMISSION_MODE_RANK[String(project)] < PERMISSION_MODE_RANK[String(global)];
  if (key === 'agent_mode') return project === 'auto' && READ_ONLY_MODES.has(String(global));
  return false;
}

/** What a project's own config.json would relax, field by field — the part a repository could ship to
 * switch off confirmations. A stricter-or-equal value is not listed: it needs no approval. */
export function relaxationsOf(global: Config, project: Config): Relaxations {
  const result: Relaxations = {};
  if (project.override_permissions) {
    for (const key of Object.keys(permissionRules)) {
      if (Object.hasOwn(project, key) && isRelaxation(key, project[key], global[key])) {
        result[key] = { project: project[key], global: global[key] };
      }
    }
  }
  if (project.agent_mode !== 'inherit' && isRelaxation('agent_mode', project.agent_mode, global.agent_mode)) {
    result.agent_mode = { project: project.agent_mode, global: global.agent_mode };
  }
  return result;
}
```

Replace the whole `effective()` method of `SettingsService` with:

```typescript
  /** A project value applies when it is stricter-or-equal to the global one, or when it is a
   * relaxation the user approved at exactly this value (core/project-trust.mts). Without
   * `approvedRelaxations`, no relaxation applies: a repository cannot ship its own permissions. */
  async effective(folder: string, { approvedRelaxations = {} }: { approvedRelaxations?: Record<string, unknown> } = {}) {
    const [global, project] = await Promise.all([this.global(), this.project(folder)]);
    const result = { ...global, ...project };
    const allowed = (key: string, value: unknown) => !isRelaxation(key, value, global[key]) || approvedRelaxations[key] === value;
    for (const key of Object.keys(permissionRules)) {
      const fromProject = project.override_permissions && Object.hasOwn(project, key) && allowed(key, project[key]);
      result[key] = fromProject ? project[key] : global[key];
    }
    const mode = project.agent_mode === 'inherit' ? global.agent_mode : project.agent_mode;
    result.agent_mode = allowed('agent_mode', mode) ? mode : global.agent_mode;
    return result;
  }
```

(`project` is `{ ...projectDefaults, ...saved }` and `projectDefaults` holds no permission key, so `Object.hasOwn(project, key)` is true only for a value actually saved in the project's `config.json` — the same condition the previous `{ ...global, ...project }` spread used.)

- [ ] **Step 4: Run the tests to verify they pass, and the settings regression tests**

Run: `cd electron && node --experimental-strip-types --test tests/settings-relaxations.test.mts tests/storage.test.mts`
Expected: all PASS (`storage.test.mts` uses `agent_mode: 'ask'` over a global `'plan'` — both read-only, not a relaxation, so unchanged).

- [ ] **Step 5: Type-check**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json`
Expected: only the 5 pre-existing errors (`local-engine.mts`, `local-provider.mts`, `pdf-loader.ts`, `local-provider.test.mts` ×2) — nothing new.

- [ ] **Step 6: Commit**

```bash
cd electron
git add core/settings.mts tests/settings-relaxations.test.mts tests/all.mts
git commit -m "feat: project settings can no longer relax permissions or agent mode without approval"
```

---

### Task 2: Plugin loader — `includeProject` and `projectPluginFiles`; MCP fixture marker

**Files:**
- Modify: `electron/core/plugin-loader.mts` (`loadPlugins` signature and its directory loop; add `projectPluginFiles`)
- Modify: `electron/tests/fixtures/fake-mcp-server.cjs` (one opt-in line after line 6)
- Test: `electron/tests/plugin-loader.test.mts` (append)

**Interfaces:**
- Produces: `loadPlugins(folder: string | null, home: string, options?: { includeProject?: boolean }): Promise<PluginLoadResult>` — `includeProject` defaults to `true` (unchanged behavior); `false` scans only `<home>/tools`.
- Produces: `export async function projectPluginFiles(folder: string, home: string): Promise<string[]>` — absolute paths of the plugin files the project itself brings (its `tools/` and `.openagent/tools/`), selected exactly as `loadPlugins` selects them, a directory physically equal to `<home>/tools` excluded; never imports anything.
- Produces (fixture): env `FAKE_MCP_MARKER=<path>` makes `fake-mcp-server.cjs` write that file as soon as it starts.

- [ ] **Step 1: Write the failing tests**

Append to `electron/tests/plugin-loader.test.mts` (it already has `fixture(t)` returning `{ root, home, project }` and imports `mkdir`, `writeFile`, `readFile`, `rm`, `join`):

```typescript
const markerPlugin = (marker: string, name: string) => `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export function getTools() { return [{ name: ${JSON.stringify(name)}, description: 'x', properties: {}, execute: async () => 'ok' }]; }
`;

test('includeProject: false never imports a project plugin, but still loads the global ones', async t => {
  const { root, home, project } = await fixture(t);
  const marker = join(root, 'project-plugin-ran.txt');
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', 'marker.mjs'), markerPlugin(marker, 'project_tool'));
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'echo.mjs'), VALID_PLUGIN);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home, { includeProject: false });
  assert.deepEqual(errors, []);
  assert.deepEqual(tools.map(tool => tool.name), ['echo_plugin']);
  await assert.rejects(readFile(marker), /ENOENT/, 'the project plugin top-level code never ran');
});

test('projectPluginFiles lists what loadPlugins would import from the project, without importing it', async t => {
  const { root, home, project } = await fixture(t);
  const marker = join(root, 'listed-plugin-ran.txt');
  await mkdir(join(project, 'tools', 'nested'), { recursive: true });
  await mkdir(join(project, '.openagent', 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', 'b.mjs'), markerPlugin(marker, 'b_tool'));
  await writeFile(join(project, 'tools', 'a.mts'), markerPlugin(marker, 'a_tool'));
  await writeFile(join(project, 'tools', '.hidden.mjs'), 'export {}');
  await writeFile(join(project, 'tools', '__init__.mjs'), 'export {}');
  await writeFile(join(project, 'tools', 'notes.txt'), 'not a plugin');
  await writeFile(join(project, 'tools', 'nested', 'deep.mjs'), 'export {}');
  await writeFile(join(project, '.openagent', 'tools', 'meta.mjs'), 'export {}');

  const { projectPluginFiles } = await import('../core/plugin-loader.mts');
  assert.deepEqual(await projectPluginFiles(project, home), [
    join(project, 'tools', 'a.mts'),
    join(project, 'tools', 'b.mjs'),
    join(project, '.openagent', 'tools', 'meta.mjs'),
  ]);
  await assert.rejects(readFile(marker), /ENOENT/, 'listing imports nothing');
});

test('projectPluginFiles treats <project>/.openagent/tools as global when it IS the data home tools directory', async t => {
  const { project } = await fixture(t);
  const home = join(project, '.openagent');
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'mine.mjs'), 'export {}');
  const { projectPluginFiles } = await import('../core/plugin-loader.mts');
  assert.deepEqual(await projectPluginFiles(project, home), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/plugin-loader.test.mts`
Expected: the 3 new tests FAIL — `projectPluginFiles` is not exported, and `includeProject: false` is ignored (the project plugin is imported, the marker file exists).

- [ ] **Step 3: Implement**

In `electron/core/plugin-loader.mts`, change the `loadPlugins` signature and its outer loop:

```typescript
export async function loadPlugins(
  folder: string | null,
  home: string,
  { includeProject = true }: { includeProject?: boolean } = {},
): Promise<PluginLoadResult> {
  if (!isAbsolute(home)) throw new Error('Chemins absolus requis');
  if (folder !== null && !isAbsolute(folder)) throw new Error('Chemins absolus requis');
  const tools: AgentTool[] = [];
  const errors: string[] = [];
  const registered = new Set<string>();
  // A project not approved yet (core/project-trust.mts): its directories are not even scanned —
  // importing a file runs its top-level code.
  const dirs = includeProject ? await pluginDirectories(folder, home) : [join(home, 'tools')];
  for (const dir of dirs) {
```

(the body of the loop is unchanged.) Then add after `loadPlugins`:

```typescript
/** The plugin files a project itself brings (its tools/ and .openagent/tools/), selected exactly as
 * loadPlugins selects them and listed WITHOUT importing anything — what core/project-trust.mts
 * fingerprints and shows. A project directory that is physically <home>/tools is global content. */
export async function projectPluginFiles(folder: string, home: string): Promise<string[]> {
  if (!isAbsolute(home) || !isAbsolute(folder)) throw new Error('Chemins absolus requis');
  const globalDir = join(home, 'tools');
  const dirs = (await pluginDirectories(folder, home)).filter(dir => dir !== globalDir);
  return (await Promise.all(dirs.map(pluginFiles))).flat();
}
```

(`pluginDirectories` always lists `join(home, 'tools')` first, under that exact string, and drops any later directory with the same `realpath` — so the filter removes the global directory and nothing else.)

In `electron/tests/fixtures/fake-mcp-server.cjs`, add right after line 6 (`if (process.env.FAKE_MCP_CRASH === '1') process.exit(1);`):

```javascript
// Opt-in: proves a server really was (or was never) started — written before anything else runs.
if (process.env.FAKE_MCP_MARKER) require('node:fs').writeFileSync(process.env.FAKE_MCP_MARKER, 'started');
```

- [ ] **Step 4: Run the tests to verify they pass, plus the suites using the fixture**

Run: `cd electron && node --experimental-strip-types --test tests/plugin-loader.test.mts tests/mcp-client.test.mts`
Expected: all PASS (existing tests unchanged; the fixture change is opt-in).

- [ ] **Step 5: Type-check**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json`
Expected: only the 5 pre-existing errors.

- [ ] **Step 6: Commit**

```bash
cd electron
git add core/plugin-loader.mts tests/plugin-loader.test.mts tests/fixtures/fake-mcp-server.cjs
git commit -m "feat: plugin loader can skip project directories and list project plugins without importing them"
```

---

### Task 3: `core/project-trust.mts` — inventory, fingerprint, registry, decisions

**Files:**
- Create: `electron/core/project-trust.mts`
- Create: `electron/tests/project-trust.test.mts`
- Modify: `electron/tests/all.mts` (register the new file)

**Interfaces:**
- Consumes: `relaxationsOf`, `RELAXABLE_KEYS`, `Relaxations`, `SettingsService` (Task 1, `./settings.mts`); `projectPluginFiles(folder, home)` (Task 2, `./plugin-loader.mts`); `readProjectMcpConfig(folder, { expandEnv: false })`, `McpServerConfig` (existing, `./mcp-config.mts`); `JsonStore` (existing).
- Produces:
  ```typescript
  export type TrustState = 'none' | 'pending' | 'trusted' | 'ignored';
  export type TrustDecision = 'trusted' | 'ignored';
  export interface ProjectInventory { plugins: string[]; mcpServers: McpServerConfig[]; relaxations: Relaxations }
  export interface ProjectTrust {
    state: TrustState; changed: boolean; token: string;
    contentTrusted: boolean; approvedRelaxations: Record<string, unknown>;
    inventory: ProjectInventory;
  }
  export class ProjectTrustService {
    constructor(home: string, settings: SettingsService);
    evaluate(folder: string): Promise<ProjectTrust>;
    decide(folder: string, decision: TrustDecision, token: string): Promise<ProjectTrust>;
    revoke(folder: string): Promise<ProjectTrust>;
    approveRelaxations(folder: string, fields: Record<string, unknown>): Promise<void>;
  }
  ```
  `inventory.plugins` are project-relative paths with `/` separators (e.g. `tools/build.mjs`). `inventory.mcpServers` are the `.mcp.json` entries as written (placeholders not expanded, values NOT redacted — the worker redacts before the renderer).

- [ ] **Step 1: Write the failing tests**

Create `electron/tests/project-trust.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const { SettingsService } = await import('../core/settings.mts');
  const { ProjectTrustService } = await import('../core/project-trust.mts');
  const settings = new SettingsService(home);
  return { root, home, project, settings, trust: new ProjectTrustService(home, settings), ProjectTrustService };
}
const markerPlugin = (marker: string, name: string) => `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export function getTools() { return [{ name: ${JSON.stringify(name)}, description: 'x', properties: {}, execute: async () => 'ok' }]; }
`;
async function addPlugin(project: string, file: string, body: string) {
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', file), body);
}

test('a project bringing nothing sensitive is in state "none"', async t => {
  const { project, trust } = await fixture(t);
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'none');
  assert.equal(result.contentTrusted, false);
  assert.deepEqual(result.inventory, { plugins: [], mcpServers: [], relaxations: {} });
});

test('a project plugin makes the project pending, and evaluating it never runs it', async t => {
  const { root, project, trust } = await fixture(t);
  const marker = join(root, 'ran.txt');
  await addPlugin(project, 'build.mjs', markerPlugin(marker, 'build_tool'));
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.changed, false);
  assert.equal(result.contentTrusted, false);
  assert.deepEqual(result.inventory.plugins, ['tools/build.mjs']);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test('.mcp.json servers are listed as written; an .mcp.json with no valid server is inert', async t => {
  const { project, trust } = await fixture(t);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { broken: { nothing: true } } }));
  assert.equal((await trust.evaluate(project)).state, 'none');

  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['--token=${SECRET_X}'] } } }));
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.inventory.mcpServers.length, 1);
  assert.deepEqual((result.inventory.mcpServers[0] as any).args, ['--token=${SECRET_X}']);
});

test('trusting with the shown token approves the content; the registry lives in the data home only', async t => {
  const { home, project, trust, settings, ProjectTrustService } = await fixture(t);
  await addPlugin(project, 'build.mjs', 'export {}');
  const shown = await trust.evaluate(project);
  const after = await trust.decide(project, 'trusted', shown.token);
  assert.equal(after.state, 'trusted');
  assert.equal(after.contentTrusted, true);
  assert.equal((await new ProjectTrustService(home, settings).evaluate(project)).state, 'trusted', 'persisted');
  assert.ok((await readdir(home)).includes('trusted-projects.json'));
  await assert.rejects(readFile(join(project, '.openagent', 'trusted-projects.json')), /ENOENT/);
});

test('adding, editing or removing a plugin after approval makes the project pending again', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await addPlugin(project, 'b.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);

  await addPlugin(project, 'a.mjs', 'export const edited = 1;');
  let result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.changed, true);
  assert.equal(result.contentTrusted, false);

  await trust.decide(project, 'trusted', result.token);
  await addPlugin(project, 'c.mjs', 'export {}');
  assert.equal((await trust.evaluate(project)).state, 'pending', 'added');

  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  await rm(join(project, 'tools', 'c.mjs'));
  assert.equal((await trust.evaluate(project)).state, 'pending', 'removed');
});

test('a decision with a stale token is refused', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  const shown = await trust.evaluate(project);
  await addPlugin(project, 'a.mjs', 'export const swapped = 1;');
  await assert.rejects(trust.decide(project, 'trusted', shown.token), /a changé depuis l’affichage/);
  assert.equal((await trust.evaluate(project)).contentTrusted, false);
});

test('"ignored" is remembered for this fingerprint and never trusts the content', async t => {
  const { home, project, trust, settings, ProjectTrustService } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  const after = await trust.decide(project, 'ignored', (await trust.evaluate(project)).token);
  assert.equal(after.state, 'ignored');
  assert.equal(after.contentTrusted, false);
  assert.equal((await new ProjectTrustService(home, settings).evaluate(project)).state, 'ignored');
});

test('a relaxation-only project: pending, then ignored stays ignored, trusted approves the values', async t => {
  const { project, trust, settings } = await fixture(t);
  await settings.saveProject(project, { override_permissions: true, shell_ask: false });
  const shown = await trust.evaluate(project);
  assert.equal(shown.state, 'pending');
  assert.deepEqual(shown.inventory.relaxations, { shell_ask: { project: false, global: true } });

  const ignored = await trust.decide(project, 'ignored', shown.token);
  assert.equal(ignored.state, 'ignored', 'not pending forever');
  assert.deepEqual(ignored.approvedRelaxations, {});

  const trusted = await trust.decide(project, 'trusted', ignored.token);
  assert.equal(trusted.state, 'trusted');
  assert.deepEqual(trusted.approvedRelaxations, { shell_ask: false });
});

test('approveRelaxations approves only the fields given, never what the repository already shipped', async t => {
  const { project, trust, settings } = await fixture(t);
  await settings.saveGlobal({ files_ask: true });
  await settings.saveProject(project, { override_permissions: true, shell_ask: false, files_ask: false });
  await trust.approveRelaxations(project, { files_ask: false, custom_prompt: 'ignored: not relaxable' });
  const result = await trust.evaluate(project);
  assert.deepEqual(result.approvedRelaxations, { files_ask: false });
  assert.equal(result.state, 'pending', 'shell_ask is still waiting for a decision');
});

test('"Ignorer" refuses only what is pending: approved content and relaxations stay approved', async t => {
  const { project, trust, settings } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await settings.saveGlobal({ files_ask: true });
  await settings.saveProject(project, { override_permissions: true, files_ask: false });
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);

  await settings.saveProject(project, { shell_ask: false });
  const pending = await trust.evaluate(project);
  assert.equal(pending.state, 'pending');
  const after = await trust.decide(project, 'ignored', pending.token);
  assert.equal(after.state, 'ignored');
  assert.equal(after.contentTrusted, true, 'the already-trusted plugins stay trusted');
  assert.deepEqual(after.approvedRelaxations, { files_ask: false }, 'the approved relaxation stays approved');
});

test('revoke forgets everything about the project', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  const after = await trust.revoke(project);
  assert.equal(after.state, 'pending');
  assert.equal(after.contentTrusted, false);
});

test('a corrupt registry approves nothing; the next decision keeps it aside and writes a fresh one', async t => {
  const { home, project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await writeFile(join(home, 'trusted-projects.json'), '{ not json');
  const shown = await trust.evaluate(project);
  assert.equal(shown.state, 'pending');
  const after = await trust.decide(project, 'trusted', shown.token);
  assert.equal(after.state, 'trusted');
  const kept = (await readdir(home)).filter(name => name.startsWith('trusted-projects.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(join(home, kept[0]), 'utf8'), '{ not json');
});

test('the registry is keyed by the real path: the same project reached through a junction is the same project', async t => {
  const { root, project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  const link = join(root, 'link');
  await symlink(project, link, 'junction');
  assert.equal((await trust.evaluate(link)).state, 'trusted');
});
```

Register it in `electron/tests/all.mts` — add as the last line:

```typescript
import './project-trust.test.mts';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/project-trust.test.mts`
Expected: FAIL — `../core/project-trust.mts` does not exist.

- [ ] **Step 3: Implement**

Create `electron/core/project-trust.mts`:

```typescript
import { createHash } from 'node:crypto';
import { readFile, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { JsonStore } from './json-store.mts';
import { projectPluginFiles } from './plugin-loader.mts';
import { readProjectMcpConfig, type McpServerConfig } from './mcp-config.mts';
import { RELAXABLE_KEYS, relaxationsOf, type Relaxations, type SettingsService } from './settings.mts';

export type TrustState = 'none' | 'pending' | 'trusted' | 'ignored';
export type TrustDecision = 'trusted' | 'ignored';
export interface ProjectInventory { plugins: string[]; mcpServers: McpServerConfig[]; relaxations: Relaxations }
export interface ProjectTrust {
  state: TrustState;
  /** A content decision exists, but for another fingerprint: the plugins/.mcp.json changed since. */
  changed: boolean;
  /** What the user was shown. decide() refuses a token that no longer matches the project. */
  token: string;
  contentTrusted: boolean;
  approvedRelaxations: Record<string, unknown>;
  inventory: ProjectInventory;
}
interface TrustRecord {
  content?: { decision: TrustDecision; fingerprint: string; decided_at: string };
  approved_relaxations?: Record<string, unknown>;
  ignored_relaxations?: Record<string, unknown>;
}
type Registry = Record<string, TrustRecord>;
type ContentStatus = 'none' | 'pending' | TrustDecision;

const CHANGED_MESSAGE = 'Le contenu du projet a changé depuis l’affichage : relis la liste avant de décider.';
const RELAXABLE = new Set(RELAXABLE_KEYS);

function isRegistry(value: unknown): value is Registry {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Lists and hashes what a project brings, WITHOUT importing or running any of it. */
async function scanContent(folder: string, home: string) {
  const files = await projectPluginFiles(folder, home);
  const plugins = files.map(file => relative(folder, file).split(sep).join('/'));
  const parts: Array<[string, Buffer]> = [];
  for (let i = 0; i < files.length; i++) parts.push([plugins[i], await readFile(files[i])]);
  const mcpServers = await readProjectMcpConfig(folder, { expandEnv: false });
  // An .mcp.json that yields no valid server starts nothing: inert, nothing to approve.
  if (mcpServers.length) parts.push(['.mcp.json', await readFile(join(folder, '.mcp.json'))]);
  parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let fingerprint: string | null = null;
  if (parts.length) {
    const hash = createHash('sha256');
    for (const [name, bytes] of parts) hash.update(`${name}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
    fingerprint = hash.digest('hex');
  }
  return { fingerprint, plugins, mcpServers };
}

/**
 * Per-project approval of what a project brings that can run code or widen the agent's permissions:
 * its plugin files, its .mcp.json servers, its permission relaxations. Read-only toward the project
 * (nothing of it is ever imported or run here); the registry lives in the user's data home, keyed
 * by the project's real path — never in the project, which could otherwise ship its own approval.
 * Every failure resolves to "not approved".
 */
export class ProjectTrustService {
  private readonly home: string;
  private readonly settings: SettingsService;
  private readonly store = new JsonStore();
  constructor(home: string, settings: SettingsService) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.home = home;
    this.settings = settings;
  }
  private path() {
    return join(this.home, 'trusted-projects.json');
  }

  private async recordFor(folder: string): Promise<TrustRecord> {
    try {
      const value = await this.store.read<unknown>(this.path(), {});
      if (!isRegistry(value)) return {};
      return value[await realpath(folder)] ?? {};
    } catch (error) {
      console.error(`[trust] registre illisible, rien n'est approuvé : ${error instanceof Error ? error.message : error}`);
      return {};
    }
  }

  /** A corrupt registry is moved aside (kept, never deleted) so the decision can still be written. */
  private async change(folder: string, update: (record: TrustRecord) => TrustRecord | undefined) {
    const key = await realpath(folder);
    const apply = () => this.store.update<unknown>(this.path(), {}, current => {
      const all: Registry = isRegistry(current) ? { ...current } : {};
      const next = update(all[key] ?? {});
      if (next) all[key] = next;
      else delete all[key];
      return all;
    });
    try {
      await apply();
    } catch (error) {
      if (!(error instanceof Error && /JSON illisible/.test(error.message))) throw error;
      await rename(this.path(), `${this.path()}.corrupt-${Date.now()}`);
      await apply();
    }
  }

  private async assess(folder: string) {
    if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
    const [global, project] = await Promise.all([this.settings.global(), this.settings.project(folder)]);
    const relaxations = relaxationsOf(global, project);
    let scan: Awaited<ReturnType<typeof scanContent>> | null = null;
    try { scan = await scanContent(folder, this.home); }
    catch (error) { console.error(`[trust] contenu du projet illisible, non approuvé : ${error instanceof Error ? error.message : error}`); }
    const record = await this.recordFor(folder);
    const fingerprint = scan?.fingerprint ?? null;
    const contentStatus: ContentStatus =
      scan === null ? 'pending'
      : fingerprint === null ? 'none'
      : record.content?.fingerprint === fingerprint ? record.content.decision
      : 'pending';
    const approved = record.approved_relaxations ?? {};
    const ignored = record.ignored_relaxations ?? {};
    const entries = Object.entries(relaxations);
    const pendingRelaxation = entries.some(([key, { project: value }]) => approved[key] !== value && ignored[key] !== value);
    const refusedRelaxation = entries.some(([key, { project: value }]) => approved[key] !== value && ignored[key] === value);
    const state: TrustState =
      contentStatus === 'none' && entries.length === 0 ? 'none'
      : contentStatus === 'pending' || pendingRelaxation ? 'pending'
      : contentStatus === 'ignored' || refusedRelaxation ? 'ignored'
      : 'trusted';
    const trust: ProjectTrust = {
      state,
      changed: scan !== null && fingerprint !== null && record.content !== undefined && record.content.fingerprint !== fingerprint,
      token: createHash('sha256').update(JSON.stringify([fingerprint, scan === null, relaxations])).digest('hex'),
      contentTrusted: contentStatus === 'trusted',
      approvedRelaxations: approved,
      inventory: { plugins: scan?.plugins ?? [], mcpServers: scan?.mcpServers ?? [], relaxations },
    };
    return { trust, fingerprint, contentStatus };
  }

  async evaluate(folder: string): Promise<ProjectTrust> {
    return (await this.assess(folder)).trust;
  }

  /** "Faire confiance" approves the current content and every current relaxation; "Ignorer" refuses
   * only what is pending — it never flips trusted content nor an approved relaxation. */
  async decide(folder: string, decision: TrustDecision, token: string): Promise<ProjectTrust> {
    if (decision !== 'trusted' && decision !== 'ignored') throw new Error('Décision de confiance invalide');
    const { trust, fingerprint, contentStatus } = await this.assess(folder);
    if (token !== trust.token) throw new Error(CHANGED_MESSAGE);
    const values = Object.entries(trust.inventory.relaxations).map(([key, { project }]) => [key, project] as const);
    await this.change(folder, record => {
      const next: TrustRecord = { ...record };
      if (fingerprint !== null && (decision === 'trusted' || contentStatus === 'pending')) {
        next.content = { decision, fingerprint, decided_at: new Date().toISOString() };
      }
      const approved = { ...record.approved_relaxations };
      const ignored = { ...record.ignored_relaxations };
      for (const [key, value] of values) {
        if (decision === 'trusted') { approved[key] = value; delete ignored[key]; }
        else if (approved[key] !== value) ignored[key] = value;
      }
      next.approved_relaxations = approved;
      next.ignored_relaxations = ignored;
      return next;
    });
    return this.evaluate(folder);
  }

  async revoke(folder: string): Promise<ProjectTrust> {
    await this.change(folder, () => undefined);
    return this.evaluate(folder);
  }

  /** Values the USER just wrote through the app ("Toujours", project settings) — only those fields:
   * a value the repository already contained is never approved this way. */
  async approveRelaxations(folder: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([key]) => RELAXABLE.has(key));
    if (!entries.length) return;
    await this.change(folder, record => {
      const approved = { ...record.approved_relaxations };
      const ignored = { ...record.ignored_relaxations };
      for (const [key, value] of entries) { approved[key] = value; delete ignored[key]; }
      return { ...record, approved_relaxations: approved, ignored_relaxations: ignored };
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd electron && node --experimental-strip-types --test tests/project-trust.test.mts`
Expected: all PASS.

- [ ] **Step 5: Type-check**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json`
Expected: only the 5 pre-existing errors.

- [ ] **Step 6: Commit**

```bash
cd electron
git add core/project-trust.mts tests/project-trust.test.mts tests/all.mts
git commit -m "feat: per-project trust registry — inventory, fingerprint and decisions, never running project code"
```

---

### Task 4: Worker wiring — gate every load point, new ops, app writes approve their own fields

**Files:**
- Modify: `electron/worker.mjs` (imports; service construction after `const settings = new SettingsService(dataHome);` at line 46; `registerTools`/`nonPluginTools`/`mcpServersForDisplay`/`pluginToolsBeside` at lines 153-220; `ops` Set at line 102; `plugin-list` handler at lines 364-371; new ops next to `mcp-list`; `permission-decision` at lines 447-460; `save_settings` at line 390; `save-project-settings` at line 466)
- Modify: `electron/main.cjs` (`allowed` Set at line 16)
- Create: `electron/tests/worker-trust.test.mts`
- Modify: `electron/tests/worker-mcp.test.mts` (approve the project in the tests that rely on a project `.mcp.json`)
- Modify: `electron/tests/all.mts` (register the new file)

**Interfaces:**
- Consumes: `ProjectTrustService` (Task 3); `loadPlugins(folder, home, { includeProject })` (Task 2); `settings.effective(folder, { approvedRelaxations })` (Task 1).
- Produces: worker op `project-trust` — payload `{ folder }` → `ProjectTrustView = { state, changed, token, plugins: string[], mcpServers: McpServerConfig[] /* env/header values masked */, relaxations: Record<string, { project, global }> }`.
- Produces: worker op `trust-project` — payload `{ folder, decision: 'trusted' | 'ignored' | 'revoke', token?: string }` → the same `ProjectTrustView` after the decision (`token` required for `trusted`/`ignored`).
- Produces: `plugin-list` result gains `untrusted: string[]` (the project's plugin paths not loaded because the project is not trusted; `[]` otherwise).
- Produces: `mcp-list` project entries gain `trusted: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `electron/tests/worker-trust.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const FAKE_MCP_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.cjs', import.meta.url));

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
function collectAgentEvents(worker: Worker, runId: string) {
  const events: any[] = [];
  const listener = (message: any) => {
    if (message?.type === 'event' && message.event === 'agent' && message.runId === runId) events.push(message);
  };
  worker.on('message', listener);
  return { events, stop: () => worker.off('message', listener) };
}
async function exists(file: string) {
  try { await readFile(file); return true; } catch { return false; }
}
const markerPlugin = (marker: string, name: string) => `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export function getTools() { return [{ name: ${JSON.stringify(name)}, description: 'x', properties: {}, execute: async () => 'ok' }]; }
`;

async function setup(t: any, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  return { root, home, project, worker };
}

/** A fake model: odd requests ask for `toolCall` (when given), even requests end the turn. */
async function fakeModel(t: any, toolCall?: () => { name: string; arguments: Record<string, unknown> }) {
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (toolCall && count % 2 === 1) {
        const call = toolCall();
        response.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: `call-${count}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: 'tool_calls' }] }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  return { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };
}

/** Runs one turn; answers every permission request with `allow`/`always`. */
async function turn(worker: Worker, folder: string, connection: unknown, decision = { allow: true, always: false }) {
  const { runId } = await callWorker(worker, 'send', { folder, branchId: 'main', text: 'vas-y', connection });
  const { events, stop } = collectAgentEvents(worker, runId);
  const answered = new Set<string>();
  while (!events.some(e => ['done', 'error', 'stopped'].includes(e.kind))) {
    for (const event of events) {
      if (event.kind === 'permission-request' && !answered.has(event.requestId)) {
        answered.add(event.requestId);
        await callWorker(worker, 'permission-decision', { runId, requestId: event.requestId, ...decision });
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  stop();
  return events;
}

test('nothing a project brings runs before approval — not on evaluation, Outils tab, mcp-list or a turn', { timeout: 30000 }, async t => {
  const { root, project, worker } = await setup(t, 'openagent-worker-trust-gate-');
  const pluginMarker = join(root, 'plugin-ran.txt');
  const mcpMarker = join(root, 'mcp-started.txt');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'marker.mjs'), markerPlugin(pluginMarker, 'marker_tool'));
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: { fake: { command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_MARKER: mcpMarker } } },
  }));
  const connection = await fakeModel(t);

  const shown = await callWorker(worker, 'project-trust', { folder: project });
  assert.equal(shown.state, 'pending');
  assert.deepEqual(shown.plugins, ['tools/marker.mjs']);
  assert.equal(shown.mcpServers.length, 1);
  assert.notEqual(shown.mcpServers[0].env.FAKE_MCP_MARKER, mcpMarker, 'env values never reach the renderer');

  const plugins = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(plugins.tools, []);
  assert.deepEqual(plugins.untrusted, ['tools/marker.mjs']);
  const servers = await callWorker(worker, 'mcp-list', { folder: project });
  assert.equal(servers.find((server: any) => server.scope === 'project').trusted, false);
  const events = await turn(worker, project, connection);
  assert.equal(events.at(-1).kind, 'done');
  assert.equal(await exists(pluginMarker), false, 'the project plugin never ran');
  assert.equal(await exists(mcpMarker), false, 'the project MCP server never started');

  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  const trusted = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(trusted.tools, ['marker_tool']);
  assert.deepEqual(trusted.untrusted, []);
  assert.equal(await exists(pluginMarker), true, 'loaded once trusted');
  assert.equal(await exists(mcpMarker), true, 'started once trusted');
});

test('a plugin added after approval is not loaded until the project is approved again', { timeout: 30000 }, async t => {
  const { root, project, worker } = await setup(t, 'openagent-worker-trust-added-');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'first.mjs'), markerPlugin(join(root, 'first.txt'), 'first_tool'));
  const shown = await callWorker(worker, 'project-trust', { folder: project });
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });

  const secondMarker = join(root, 'second.txt');
  await writeFile(join(project, 'tools', 'second.mjs'), markerPlugin(secondMarker, 'second_tool'));
  const plugins = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(plugins.tools, [], 'the changed project is untrusted as a whole');
  assert.equal(await exists(secondMarker), false);
  const after = await callWorker(worker, 'project-trust', { folder: project });
  assert.equal(after.state, 'pending');
  assert.equal(after.changed, true);
});

test('a decision made on a stale listing is refused', async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-stale-');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'a.mjs'), 'export {}');
  const shown = await callWorker(worker, 'project-trust', { folder: project });
  await writeFile(join(project, 'tools', 'a.mjs'), 'export const swapped = 1;');
  await assert.rejects(callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token }), /a changé depuis l’affichage/);
});

test('a repo-shipped shell_ask:false is ignored until the project is trusted', { timeout: 30000 }, async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-shell-');
  await mkdir(join(project, '.openagent'));
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ override_permissions: true, shell_ask: false }));
  const connection = await fakeModel(t, () => ({ name: 'run_command', arguments: { command: 'echo confiance' } }));

  const refused = await turn(worker, project, connection, { allow: false, always: false });
  assert.ok(refused.some(e => e.kind === 'permission-request'), 'still asks: the shipped relaxation is not applied');

  const shown = await callWorker(worker, 'project-trust', { folder: project });
  assert.deepEqual(shown.relaxations, { shell_ask: { project: false, global: true } });
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  const trusted = await turn(worker, project, connection);
  assert.equal(trusted.some(e => e.kind === 'permission-request'), false, 'applied once approved');
});

test('"Toujours" on a file write works at once and approves only that field', { timeout: 30000 }, async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-always-');
  await callWorker(worker, 'save-global-settings', { patch: { files_ask: true } });
  let file = 0;
  const connection = await fakeModel(t, () => ({ name: 'create_file', arguments: { path: `f${++file}.txt`, content: 'ok' } }));

  const first = await turn(worker, project, connection, { allow: true, always: true });
  assert.ok(first.some(e => e.kind === 'permission-request'));
  assert.notEqual((await callWorker(worker, 'project-trust', { folder: project })).state, 'pending', 'no banner for the user’s own choice');
  const second = await turn(worker, project, connection);
  assert.equal(second.some(e => e.kind === 'permission-request'), false, '"Toujours" is effective right away');

  const config = JSON.parse(await readFile(join(project, '.openagent', 'config.json'), 'utf8'));
  await writeFile(join(project, '.openagent', 'config.json'), JSON.stringify({ ...config, shell_ask: false }));
  const after = await callWorker(worker, 'project-trust', { folder: project });
  assert.equal(after.state, 'pending');
  assert.deepEqual(Object.keys(after.relaxations).sort(), ['files_ask', 'shell_ask']);
  assert.equal((await callWorker(worker, 'trust-project', { folder: project, decision: 'ignored', token: after.token })).state, 'ignored');
});

test('revoke makes a trusted project pending again', async t => {
  const { project, worker } = await setup(t, 'openagent-worker-trust-revoke-');
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'a.mjs'), 'export {}');
  const shown = await callWorker(worker, 'project-trust', { folder: project });
  await callWorker(worker, 'trust-project', { folder: project, decision: 'trusted', token: shown.token });
  assert.equal((await callWorker(worker, 'trust-project', { folder: project, decision: 'revoke' })).state, 'pending');
});
```

Before relying on the `create_file` arguments above, open `electron/core/workspace.mts` and confirm the tool's real name and parameter names (`path`, `content`); adjust ONLY the `arguments` object if they differ.

Register it in `electron/tests/all.mts` — add as the last line:

```typescript
import './worker-trust.test.mts';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/worker-trust.test.mts`
Expected: FAIL — `project-trust` / `trust-project` reject with `Opération IPC inconnue`, and the project plugin runs on `plugin-list`.

- [ ] **Step 3: Wire the worker**

In `electron/worker.mjs`:

1. Add the import next to the other `./core/*.mts` imports:
```javascript
import { ProjectTrustService } from './core/project-trust.mts';
```
2. Right after `const settings = new SettingsService(dataHome);` (line 46):
```javascript
const trust = new ProjectTrustService(dataHome, settings);
```
3. Add `'project-trust', 'trust-project'` to the `ops` Set (line 102), right after `'plugin-list'`.
4. Replace `registerTools`, `nonPluginTools`, `mcpServersForDisplay` and `pluginToolsBeside` (lines 150-220; keep `mcpToolsBeside` exactly as it is) with:
```javascript
/** Every registered tool for this folder's settings, plus its effective settings — the single source
 * of truth `runSend`'s permission checks AND the exporter's tool tags both read from, so the two can
 * never drift apart. The project's trust is evaluated here, on EVERY turn: a plugin or .mcp.json
 * added during the session (git pull, or the agent itself) is not loaded before a new approval. */
async function registerTools(folder) {
  const projectTrust = await trust.evaluate(folder);
  const effective = await settings.effective(folder, { approvedRelaxations: projectTrust.approvedRelaxations });
  const others = await nonPluginTools(folder, effective, projectTrust);
  const { tools: pluginTools, errors: pluginErrors } = await pluginToolsBeside(folder, others, projectTrust);
  for (const error of pluginErrors) console.error(`[plugin] ${error}`);
  return { effective, tools: [...others, ...pluginTools] };
}

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
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome),
  ];
  return [...builtIn, ...mcpToolsBeside(mcpDiscovered, builtIn)];
}
```
and, after the unchanged `mcpToolsBeside`:
```javascript
/** The merged server list for the Outils tab. Trusted project: merged exactly as a turn merges it
 * (placeholders expanded, so the same entries dedupe), each project entry shown as written in
 * .mcp.json — an expanded `${TOKEN}` in args or url is a secret, and those fields are displayed.
 * Untrusted project: its entries are listed (trusted: false) but take no part in the merge — a turn
 * only runs the global ones, so a colliding global entry must not be hidden. */
async function mcpServersForDisplay(folder) {
  const global = await mcpConfig.list();
  if (!folder) return global;
  const projectTrust = await trust.evaluate(folder);
  const asWritten = await readProjectMcpConfig(folder, { expandEnv: false });
  if (!projectTrust.contentTrusted) return [...global, ...asWritten.map(server => ({ ...server, trusted: false }))];
  const byId = new Map(asWritten.map(server => [server.id, server]));
  const merged = mergeServerConfigs(global, asWritten.map(server => expandServerPlaceholders(server)));
  return merged.map(server => (server.scope === 'project' ? { ...(byId.get(server.id) ?? server), trusted: true } : server));
}

/** The folder's plugin tools minus any whose name `others` already uses: runAgent refuses a
 * duplicated name for the WHOLE turn, so one plugin named like a built-in would otherwise break
 * every turn. The project's own plugins only once it is trusted — not even imported before.
 * Shared by registerTools and plugin-list, so the Outils tab shows exactly what a turn gets. */
async function pluginToolsBeside(folder, others, projectTrust) {
  const { tools, errors } = await loadPlugins(folder, dataHome, { includeProject: projectTrust.contentTrusted });
  const taken = new Set(others.map(tool => tool.name));
  const kept = [];
  for (const tool of tools) {
    if (taken.has(tool.name)) errors.push(`${tool.name}: nom déjà utilisé par un autre outil, ignoré`);
    else kept.push(tool);
  }
  return { tools: kept, errors };
}

/** What the renderer is shown about a project's trust: never a secret (env/header values masked,
 * like every mcp-* reply). */
function trustView(projectTrust) {
  const { state, changed, token, inventory } = projectTrust;
  return { state, changed, token, plugins: inventory.plugins, mcpServers: redactSecrets(inventory.mcpServers), relaxations: inventory.relaxations };
}
```
5. Replace the `plugin-list` handler (lines 364-371) with:
```javascript
    if (op === 'plugin-list') {
      const folder = payload.folder ?? null;
      if (!folder) {
        // No active project: no built-in tool set to collide with yet — the global plugins as loaded.
        const { tools, errors } = await loadPlugins(null, dataHome);
        result = { tools: tools.map(t => t.name), errors, untrusted: [] };
      } else {
        const projectTrust = await trust.evaluate(folder);
        const effective = await settings.effective(folder, { approvedRelaxations: projectTrust.approvedRelaxations });
        const { tools, errors } = await pluginToolsBeside(folder, await nonPluginTools(folder, effective, projectTrust), projectTrust);
        result = { tools: tools.map(t => t.name), errors, untrusted: projectTrust.contentTrusted ? [] : projectTrust.inventory.plugins };
      }
    }
    if (op === 'project-trust') result = trustView(await trust.evaluate(payload.folder));
    if (op === 'trust-project') {
      result = trustView(payload.decision === 'revoke'
        ? await trust.revoke(payload.folder)
        : await trust.decide(payload.folder, payload.decision, payload.token));
    }
```
6. In `permission-decision`, change the persistent non-shell branch to also approve the field it writes:
```javascript
        } else if (payload.always && payload.allow && field) {
          await settings.saveProject(pending.folder, { override_permissions: true, [field]: false }).catch(() => {});
          // The user's own choice: approved at once, and only this field (core/project-trust.mts).
          await trust.approveRelaxations(pending.folder, { [field]: false }).catch(() => {});
        }
```
7. In `save_settings`, change the folder branch to:
```javascript
      else {
        const patch = { agent_mode: payload.settings?.agent_mode || 'inherit', custom_prompt: payload.settings?.custom_prompt || '' };
        result = await settings.saveProject(payload.folder, patch);
        await trust.approveRelaxations(payload.folder, patch);
      }
```
8. Replace the `save-project-settings` line with:
```javascript
    if (op === 'save-project-settings') {
      result = await settings.saveProject(payload.folder, payload.patch);
      await trust.approveRelaxations(payload.folder, payload.patch);
    }
```

In `electron/main.cjs`, add `'project-trust','trust-project'` to the `allowed` Set (line 16), right after `'plugin-list'`.

- [ ] **Step 4: Run the new tests**

Run: `cd electron && node --experimental-strip-types --test tests/worker-trust.test.mts`
Expected: all PASS.

- [ ] **Step 5: Adapt the existing project-`.mcp.json` tests**

Run: `cd electron && node --experimental-strip-types --test tests/worker-mcp.test.mts`
Expected: the tests that rely on a project `.mcp.json` being used by a turn or merged in `mcp-list` now FAIL — this is the hole being closed, not a regression.

Add this helper to `electron/tests/worker-mcp.test.mts`, below `waitUntilDone`:

```typescript
/** A project's .mcp.json is only used once the project is trusted (core/project-trust.mts). */
async function approveProject(worker: Worker, folder: string) {
  const { token } = await callWorker(worker, 'project-trust', { folder });
  await callWorker(worker, 'trust-project', { folder, decision: 'trusted', token });
}
```

In each failing test, add `await approveProject(worker, project);` right AFTER the test's last write to `.mcp.json` and BEFORE its first `send`/`mcp-list` call (the call must come after the file is written: the approval is for the content as it is then). Change NOTHING else in those tests — no assertion, no setup.

Run again: `cd electron && node --experimental-strip-types --test tests/worker-mcp.test.mts tests/worker-plugin.test.mts tests/main-routing.test.mts tests/worker-tools.test.mts`
Expected: all PASS (`worker-plugin.test.mts` only uses global plugins and is unchanged; `main-routing.test.mts` sees the two new ops as worker ops).

- [ ] **Step 6: Type-check**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json`
Expected: only the 5 pre-existing errors.

- [ ] **Step 7: Commit**

```bash
cd electron
git add worker.mjs main.cjs tests/worker-trust.test.mts tests/worker-mcp.test.mts tests/all.mts
git commit -m "feat: worker loads a project's plugins, MCP servers and relaxations only once the project is trusted"
```

---

### Task 5: UI — trust banner, Outils tab row, real Electron proof

**Files:**
- Modify: `electron/renderer-src/src/ipc/bridge.ts` (types + 2 functions)
- Create: `electron/renderer-src/src/components/ProjectTrustBanner.tsx`
- Modify: `electron/renderer-src/src/components/ChatView.tsx` (render the banner under `<BranchSelector />`)
- Modify: `electron/renderer-src/src/components/settings/ToolsTab.tsx`
- Create: `electron/tests/trust-visual.cjs`, `electron/tests/run-trust-visual.cjs`
- Modify: `electron/package.json` (script `test:trust`)

**Interfaces:**
- Consumes: worker ops `project-trust`, `trust-project`; `plugin-list` → `untrusted`; `mcp-list` → `trusted` (Task 4).
- Produces (renderer): `getProjectTrust(folder: string): Promise<ProjectTrustView>`, `decideProjectTrust(folder: string, decision: 'trusted' | 'ignored' | 'revoke', token?: string): Promise<ProjectTrustView>`.
- Produces (DOM, used by the visual test): `[data-testid="oa-trust-banner"]`, `[data-testid="oa-trust-plugin"]`, `#oa-trust-banner-approve`, `#oa-trust-banner-ignore`, `[data-testid="oa-trust-state"][data-state="…"]`, `#oa-trust-approve`, `#oa-trust-revoke`, `[data-testid="oa-plugin-untrusted"]`, `[data-testid="oa-mcp-untrusted-badge"]`.

- [ ] **Step 1: Bridge**

In `electron/renderer-src/src/ipc/bridge.ts`, replace `export interface PluginListResult { tools: string[]; errors: string[] }` with:

```typescript
export interface PluginListResult { tools: string[]; errors: string[]; untrusted: string[] }
```

add `trusted?: boolean;` as the last field of BOTH `StdioServerConfig` and `RemoteServerConfig`, and add after `listPlugins`:

```typescript
export interface ProjectTrustView {
  state: 'none' | 'pending' | 'trusted' | 'ignored';
  changed: boolean;
  token: string;
  plugins: string[];
  mcpServers: McpServerConfig[];
  relaxations: Record<string, { project: unknown; global: unknown }>;
}
export function getProjectTrust(folder: string): Promise<ProjectTrustView> {
  return request('project-trust', { folder });
}
export function decideProjectTrust(folder: string, decision: 'trusted' | 'ignored' | 'revoke', token?: string): Promise<ProjectTrustView> {
  return request('trust-project', { folder, decision, token });
}
```

In `ToolsTab.tsx`, the two existing fallbacks `setPlugins({ tools: [], errors: [] })` / `useState<PluginListResult>({ tools: [], errors: [] })` become `{ tools: [], errors: [], untrusted: [] }` (done in Step 3's full replacement).

- [ ] **Step 2: Banner**

Create `electron/renderer-src/src/components/ProjectTrustBanner.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { decideProjectTrust, getProjectTrust, type McpServerConfig, type ProjectTrustView } from '../ipc/bridge';
import { useChat } from '../state/ChatProvider';
import { useToast } from '../state/ToastProvider';

const FIELD_LABELS: Record<string, string> = {
  shell_ask: 'confirmation des commandes shell',
  files_ask: 'confirmation des écritures de fichiers',
  search_ask: 'confirmation des recherches web',
  permission_mode: 'mode de permission',
  agent_mode: 'mode de l’agent',
};

function describe(value: unknown): string {
  if (value === true) return 'activée';
  if (value === false) return 'désactivée';
  return String(value);
}
function serverLabel(server: McpServerConfig): string {
  return 'command' in server ? `${server.command} ${server.args.join(' ')}`.trim() : server.url;
}

/** Shown while the active project brings plugins, .mcp.json servers or permission relaxations the
 * user has not decided on. Non-blocking: until a decision, none of it is loaded or applied
 * (core/project-trust.mts) and the agent works with its built-in tools and the global settings. */
export function ProjectTrustBanner() {
  const { activeFolder, state } = useChat();
  const { notify } = useToast();
  const [trust, setTrust] = useState<ProjectTrustView | null>(null);
  const [busy, setBusy] = useState(false);
  const folderRef = useRef(activeFolder);
  folderRef.current = activeFolder;

  // Read again on every folder change and every time a turn ends: a turn can add a plugin.
  useEffect(() => {
    if (!activeFolder || state.agentRunning) return;
    let cancelled = false;
    getProjectTrust(activeFolder)
      .then(next => { if (!cancelled) setTrust(next); })
      .catch(() => { if (!cancelled) setTrust(null); });
    return () => { cancelled = true; };
  }, [activeFolder, state.agentRunning]);

  if (!activeFolder || !trust || trust.state !== 'pending') return null;

  const decide = async (decision: 'trusted' | 'ignored') => {
    const folder = activeFolder;
    setBusy(true);
    try {
      const next = await decideProjectTrust(folder, decision, trust.token);
      if (folderRef.current === folder) setTrust(next);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Décision impossible.', 'negative');
      const next = await getProjectTrust(folder).catch(() => null);
      if (folderRef.current === folder) setTrust(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="oa-trust-banner" className="mx-6 my-2 rounded-lg border border-orange-800 px-3 py-2 text-xs" style={{ background: '#1a120a' }}>
      <div className="mb-1 font-bold text-orange-300">
        {trust.changed
          ? 'Le contenu de ce projet a changé depuis ton approbation.'
          : 'Ce projet contient du code ou des réglages qui s’exécuteraient avec tes droits.'}
      </div>
      <ul className="mb-2 list-disc pl-5 text-gray-300">
        {trust.plugins.map(path => (
          <li key={path} data-testid="oa-trust-plugin">Plugin <span className="font-mono">{path}</span></li>
        ))}
        {trust.mcpServers.map(server => (
          <li key={server.id} data-testid="oa-trust-mcp">
            Serveur MCP <span className="font-mono">{server.name ?? server.id}</span> : <span className="font-mono">{serverLabel(server)}</span>
          </li>
        ))}
        {Object.entries(trust.relaxations).map(([field, { project, global }]) => (
          <li key={field} data-testid="oa-trust-relaxation">
            {FIELD_LABELS[field] ?? field} : {describe(project)} (globalement : {describe(global)})
          </li>
        ))}
      </ul>
      <div className="mb-2 text-gray-500">
        Tant que tu ne fais pas confiance à ce projet, rien de cela n’est chargé ni appliqué : l’agent travaille avec ses outils internes et tes réglages globaux.
      </div>
      <div className="flex gap-2">
        <button id="oa-trust-banner-approve" disabled={busy} onClick={() => void decide('trusted')} className="rounded bg-orange-700 px-3 py-1 font-bold text-white hover:bg-orange-800 disabled:opacity-60">
          Faire confiance
        </button>
        <button id="oa-trust-banner-ignore" disabled={busy} onClick={() => void decide('ignored')} className="rounded bg-gray-700 px-3 py-1 font-bold text-white hover:bg-gray-800 disabled:opacity-60">
          Ignorer
        </button>
      </div>
    </div>
  );
}
```

Confirm `ChatView` renders inside `ToastProvider` (check where `ToastProvider` wraps the app — `ToolsTab.tsx` already calls `useToast()`); if it does not, say so in the report instead of restructuring providers.

In `electron/renderer-src/src/components/ChatView.tsx`, add `import { ProjectTrustBanner } from './ProjectTrustBanner';` next to the `PermissionBanner` import, and render `<ProjectTrustBanner />` on the line right after `<BranchSelector />` (so it shows on the empty welcome view too).

- [ ] **Step 3: Outils tab**

Replace the full contents of `electron/renderer-src/src/components/settings/ToolsTab.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { addMcpRemoteServer, addMcpServer, decideProjectTrust, getProjectTrust, listMcpServers, listPlugins, removeMcpServer, type McpServerConfig, type PluginListResult, type ProjectTrustView } from '../../ipc/bridge';
import { Group, Section } from './parts';
import { useToast } from '../../state/ToastProvider';

const button = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300';
const EMPTY_PLUGINS: PluginListResult = { tools: [], errors: [], untrusted: [] };
const TRUST_TEXT: Record<ProjectTrustView['state'], string> = {
  none: 'Ce projet n’apporte ni plugin, ni serveur MCP, ni assouplissement de permission.',
  pending: 'En attente de ta décision : ses plugins, serveurs MCP et assouplissements ne sont pas appliqués.',
  trusted: 'Approuvé : ses plugins, serveurs MCP et assouplissements sont appliqués.',
  ignored: 'Ignoré : ses plugins, serveurs MCP et assouplissements ne sont pas appliqués.',
};

function serverLabel(server: McpServerConfig): string {
  if ('command' in server) return `${server.command} ${server.args.join(' ')}`.trim();
  return server.url;
}

// Mirrors settings.py::_tab_tools' "Plugins Python" (now a real Node loader, see
// core/plugin-loader.mts) and "Serveurs MCP (stdio)" groups. The MCP list merges the global scope
// (~/.openagent/mcp.json, managed here) with the active project's .mcp.json (read-only — a
// "projet" badge marks those entries, and their ✕ is disabled: there is nothing to remove from
// this app's side, the file itself is the source of truth, same convention as Claude Code).
// A project's own plugins and servers apply only once the project is trusted (core/project-trust.mts).
export function ToolsTab({ activeFolder }: { activeFolder: string | null }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [commandLine, setCommandLine] = useState('');
  const [adding, setAdding] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteAuth, setRemoteAuth] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);
  const [plugins, setPlugins] = useState<PluginListResult>(EMPTY_PLUGINS);
  const [trust, setTrust] = useState<ProjectTrustView | null>(null);
  const [deciding, setDeciding] = useState(false);
  const { notify } = useToast();

  const refresh = () => listMcpServers(activeFolder).then(setServers).catch(() => {});
  const refreshPlugins = () => listPlugins(activeFolder).then(setPlugins).catch(() => setPlugins(EMPTY_PLUGINS));
  const refreshTrust = () => (activeFolder ? getProjectTrust(activeFolder).then(setTrust).catch(() => setTrust(null)) : Promise.resolve(setTrust(null)));
  useEffect(() => { refresh(); }, [activeFolder]);
  useEffect(() => { refreshPlugins(); }, [activeFolder]);
  useEffect(() => { refreshTrust(); }, [activeFolder]);

  const handleTrust = async (decision: 'trusted' | 'revoke') => {
    if (!activeFolder || !trust) return;
    setDeciding(true);
    try {
      setTrust(await decideProjectTrust(activeFolder, decision, trust.token));
      await Promise.all([refresh(), refreshPlugins()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Décision impossible.', 'negative');
      await refreshTrust();
    } finally {
      setDeciding(false);
    }
  };
  const handleAdd = async () => {
    const value = commandLine.trim();
    if (!value) return;
    setAdding(true);
    try {
      await addMcpServer(value);
      await refresh();
      setCommandLine('');
      notify('Serveur MCP enregistré.', 'positive');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Impossible d’ajouter ce serveur.', 'negative');
    } finally {
      setAdding(false);
    }
  };
  const handleAddRemote = async () => {
    const url = remoteUrl.trim();
    if (!url) return;
    setAddingRemote(true);
    try {
      const headers = remoteAuth.trim() ? { Authorization: remoteAuth.trim() } : undefined;
      await addMcpRemoteServer(url, 'http', headers);
      await refresh();
      setRemoteUrl('');
      setRemoteAuth('');
      notify('Serveur MCP distant enregistré.', 'positive');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Impossible d’ajouter ce serveur distant.', 'negative');
    } finally {
      setAddingRemote(false);
    }
  };
  const handleRemove = async (id: string) => {
    try { await removeMcpServer(id); await refresh(); }
    catch { /* the list already reflects the last known-good state */ }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Outils et intégrations" badge="EXTENSIONS" />
        {activeFolder && trust && trust.state !== 'none' && (
          <Group>
            <div className="flex flex-col gap-2 px-4 py-3">
              <span className="text-xs font-medium text-gray-300">Confiance du projet</span>
              <span data-testid="oa-trust-state" data-state={trust.state} className="text-xs text-gray-500">
                {TRUST_TEXT[trust.state]}
              </span>
              {trust.state === 'trusted' ? (
                <button id="oa-trust-revoke" onClick={() => void handleTrust('revoke')} disabled={deciding} className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
                  Retirer la confiance
                </button>
              ) : (
                <button id="oa-trust-approve" onClick={() => void handleTrust('trusted')} disabled={deciding} className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
                  Faire confiance
                </button>
              )}
            </div>
          </Group>
        )}
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Plugins</span>
            <span className="text-xs text-gray-600">
              Fichiers .mjs/.mts déposés dans ~/.openagent/tools ou tools/ du projet — chargés au démarrage de chaque tour de l'agent.
            </span>
            {plugins.tools.length === 0 ? (
              <span data-testid="oa-plugin-empty" className="text-xs text-gray-600">
                Aucun plugin chargé.
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                {plugins.tools.map(name => (
                  <span key={name} data-testid="oa-plugin-entry" className="font-mono text-xs text-green-400">
                    🧩 {name}
                  </span>
                ))}
              </div>
            )}
            {plugins.untrusted.map(path => (
              <span key={path} data-testid="oa-plugin-untrusted" className="font-mono text-xs text-gray-500">
                ⏸ {path} — non chargé (projet non approuvé)
              </span>
            ))}
            {plugins.errors.map(error => (
              <span key={error} data-testid="oa-plugin-error" className="font-mono text-xs text-yellow-600">
                ⚠️ {error}
              </span>
            ))}
          </div>
        </Group>
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Serveurs MCP</span>
            <span className="text-xs text-gray-600">
              Globaux (gérés ici) et ceux du .mcp.json du projet actif (lecture seule, géré par fichier/git).
            </span>
            {servers.length === 0 ? (
              <span data-testid="oa-mcp-empty" className="text-xs text-gray-600">
                Aucun serveur MCP configuré.
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                {servers.map(server => (
                  <div key={server.id} data-testid="oa-mcp-entry" data-scope={server.scope} className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${server.trusted === false ? 'opacity-50' : ''}`} style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                    <span className="truncate font-mono text-xs text-blue-400">
                      {server.scope === 'project' && <span data-testid="oa-mcp-project-badge" className="mr-1 rounded bg-purple-900 px-1 text-[10px] text-purple-300">projet</span>}
                      {server.trusted === false && <span data-testid="oa-mcp-untrusted-badge" className="mr-1 rounded bg-gray-800 px-1 text-[10px] text-gray-400">non approuvé</span>}
                      {serverLabel(server)}
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
              </div>
            )}
            <input
              data-testid="oa-mcp-command-input"
              value={commandLine}
              onChange={event => setCommandLine(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void handleAdd(); }}
              placeholder="Commande, ex. npx -y @modelcontextprotocol/server-filesystem"
              className="w-full rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
            <button id="oa-mcp-add-btn" onClick={() => void handleAdd()} disabled={adding || !commandLine.trim()} className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
              {adding ? 'Ajout…' : 'Ajouter'}
            </button>
            <span className="mt-1 text-xs text-gray-600">Serveur distant (SSE/HTTP) :</span>
            <input
              data-testid="oa-mcp-remote-url-input"
              value={remoteUrl}
              onChange={event => setRemoteUrl(event.target.value)}
              placeholder="URL, ex. https://exemple.com/mcp"
              className="w-full rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
            <input
              data-testid="oa-mcp-remote-auth-input"
              value={remoteAuth}
              onChange={event => setRemoteAuth(event.target.value)}
              placeholder="En-tête Authorization (optionnel), ex. Bearer ..."
              className="w-full rounded px-2 py-1.5 font-mono text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            />
            <button id="oa-mcp-add-remote-btn" onClick={() => void handleAddRemote()} disabled={addingRemote || !remoteUrl.trim()} className={button + ' disabled:cursor-not-allowed disabled:opacity-60'}>
              {addingRemote ? 'Ajout…' : 'Ajouter le serveur distant'}
            </button>
          </div>
        </Group>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Type-check and build the renderer**

Run: `cd electron && npx tsc --noEmit -p renderer-src/tsconfig.json && npm run renderer:build`
Expected: zero type errors; the build succeeds (only the pre-existing ">500kB chunk" warning).

- [ ] **Step 5: Write the real Electron proof**

Create `electron/tests/trust-visual.cjs`:

```javascript
// Run with Electron, not node. Proves the per-project trust UI end to end through the REAL UI and
// the REAL worker.mjs (a real project plugin on disk whose top-level code writes a marker file):
// the banner lists the real content and nothing runs before approval; "Faire confiance" loads it;
// "Retirer la confiance" brings the banner back; "Ignorer" survives a reload.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { capturePng } = require('./capture-helper.cjs');

async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
function flush() {
  return Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve)),
  ]);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => readFile(file).then(() => true, () => false);

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-trust-visual-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  const marker = join(root, 'plugin-ran.txt');
  await Promise.all([mkdir(home), mkdir(join(alpha, 'tools'), { recursive: true })]);
  await writeFile(join(alpha, 'tools', 'marker.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export function getTools() { return [{ name: 'trust_plugin', description: 'ok', properties: {}, execute: async () => 'ok' }]; }
`);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  const screenshotDir = process.env.OPENAGENT_TRUST_SCREENSHOT_DIR || home;
  let win;
  let worker;
  try {
    worker = new Worker(path.join(__dirname, '..', 'worker.mjs'), { env: { ...process.env, OPENAGENT_HOME: home } });
    const pending = new Map();
    worker.on('message', message => {
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); message.ok ? done.resolve(message.result) : done.reject(new Error(message.error)); }
      win?.webContents.send('backend-message', message);
    });
    ipcMain.handle('backend-request', (_event, request) => {
      if (request.op === 'connection-snapshot') {
        return { provider: 'ollama', model: 'm', base_url: 'http://127.0.0.1:11434/v1', key_source: 'none', legacy_plaintext: false, model_source: 'legacy', key_configured: false };
      }
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...request, id });
      });
    });

    win = new BrowserWindow({
      show: true, opacity: 0, focusable: false, width: 1080, height: 680,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer-dist', 'index.html'));
    await pause(500);

    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { throw new Error(`page script failed: ${code.replace(/\s+/g, ' ').slice(0, 160)} — ${error.message.split('\n')[0]}`); }
    };
    const q = selector => JSON.stringify(selector);
    const click = selector => js(`document.querySelector(${q(selector)}).click()`);
    const has = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const enterAlpha = async () => {
      await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded' });
      await js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes('alpha'))?.click()`);
      await waitFor(() => has('#oa-input-ta'), { what: 'alpha activated' });
    };
    const openTools = async () => {
      await click('#oa-settings-btn');
      await waitFor(() => has('[data-testid="oa-settings-tab"][data-tab="tools"]'), { what: 'Outils tab exists' });
      await click('[data-testid="oa-settings-tab"][data-tab="tools"]');
      await waitFor(() => has('[data-testid="oa-trust-state"]'), { what: 'trust row shown' });
    };
    const closeSettings = () => click('#oa-settings-close-btn');

    // ── The banner lists the real plugin; nothing has run ─────────────────────────────────────
    await enterAlpha();
    await waitFor(() => has('[data-testid="oa-trust-banner"]'), { what: 'trust banner shown' });
    assert.match(await text('[data-testid="oa-trust-plugin"]'), /tools\/marker\.mjs/);
    await writeFile(join(screenshotDir, 'trust-1-banner.png'), await capturePng(win));
    await openTools();
    assert.equal(await js(`document.querySelector('[data-testid="oa-trust-state"]').dataset.state`), 'pending');
    assert.match(await text('[data-testid="oa-plugin-untrusted"]'), /tools\/marker\.mjs/);
    assert.equal(await exists(marker), false, 'the project plugin never ran before approval');
    await closeSettings();

    // ── "Faire confiance": the plugin is really loaded ────────────────────────────────────────
    await click('#oa-trust-banner-approve');
    await waitFor(async () => !(await has('[data-testid="oa-trust-banner"]')), { what: 'banner gone after approval' });
    await openTools();
    await waitFor(() => has('[data-testid="oa-plugin-entry"]'), { what: 'the plugin is loaded' });
    assert.match(await text('[data-testid="oa-plugin-entry"]'), /trust_plugin/);
    assert.equal(await js(`document.querySelector('[data-testid="oa-trust-state"]').dataset.state`), 'trusted');
    assert.equal(await exists(marker), true, 'the plugin really ran once trusted');
    await writeFile(join(screenshotDir, 'trust-2-trusted.png'), await capturePng(win));

    // ── "Retirer la confiance": pending again, banner back ────────────────────────────────────
    await click('#oa-trust-revoke');
    await waitFor(() => js(`document.querySelector('[data-testid="oa-trust-state"]')?.dataset.state === 'pending'`), { what: 'pending after revoke' });
    await closeSettings();
    await win.webContents.reload();
    await pause(500);
    await enterAlpha();
    await waitFor(() => has('[data-testid="oa-trust-banner"]'), { what: 'banner back after revoke' });

    // ── "Ignorer" is remembered across a reload ───────────────────────────────────────────────
    await click('#oa-trust-banner-ignore');
    await waitFor(async () => !(await has('[data-testid="oa-trust-banner"]')), { what: 'banner gone after ignore' });
    await win.webContents.reload();
    await pause(500);
    await enterAlpha();
    await pause(1500);
    assert.equal(await has('[data-testid="oa-trust-banner"]'), false, '"Ignorer" survives a reload');
    await openTools();
    assert.equal(await js(`document.querySelector('[data-testid="oa-trust-state"]').dataset.state`), 'ignored');
    await writeFile(join(screenshotDir, 'trust-3-ignored.png'), await capturePng(win));

    process.stdout.write(`PASS trust banner: real plugin listed and never run before approval, trust/revoke/ignore through the real worker (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_TRUST_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL trust visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
```

Create `electron/tests/run-trust-visual.cjs`:

```javascript
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = require('electron');
const result = spawnSync(executable, [join(__dirname, 'trust-visual.cjs')], {
  encoding: 'utf8', timeout: 120000, windowsHide: true, env,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) process.stderr.write(`Electron test process: ${result.error.code}\n`);
process.exit(result.status === 0 && result.stdout?.includes('PASS trust banner') ? 0 : 1);
```

In `electron/package.json` `scripts`, add after `"test:plugins"`:

```json
    "test:trust": "node tests/run-trust-visual.cjs",
```

- [ ] **Step 6: Run the real Electron proofs**

Run: `cd electron && npm run test:trust && npm run test:mcp && npm run test:plugins`
Expected: three `PASS` lines. Open the three `trust-*.png` screenshots (set `OPENAGENT_TRUST_SCREENSHOT_DIR` to a scratch folder to keep them) and confirm the banner and the Outils row render legibly.

- [ ] **Step 7: Commit**

```bash
cd electron
git add renderer-src/src/ipc/bridge.ts renderer-src/src/components/ProjectTrustBanner.tsx renderer-src/src/components/ChatView.tsx renderer-src/src/components/settings/ToolsTab.tsx tests/trust-visual.cjs tests/run-trust-visual.cjs package.json
git commit -m "feat: project trust banner and Outils tab row, proven in a real Electron window"
```

---

### Task 6: Final verification and bilan

**Files:**
- Modify: `tasks/todo.md` (repo root)

- [ ] **Step 1: Confirm the new test files are registered**

Run: `cd electron && grep -c "settings-relaxations.test.mts\|project-trust.test.mts\|worker-trust.test.mts" tests/all.mts`
Expected: `3`.

- [ ] **Step 2: Full suite**

Run: `cd electron && node --experimental-strip-types --test tests/all.mts`
Expected: every test passes (567 before this lot, plus the new ones) — let it run to completion (several minutes, real `.gguf` model tests included).

- [ ] **Step 3: Type-check both configurations**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json; npx tsc --noEmit -p renderer-src/tsconfig.json`
Expected: the same 5 pre-existing errors on the core config, zero on the renderer config.

- [ ] **Step 4: Real Electron proofs touching permissions**

Run: `cd electron && npm run test:trust && npm run test:permission && npm run test:mcp && npm run test:plugins`
Expected: four `PASS` lines (`test:permission` exercises a project override that is STRICTER than global — it must still apply without any approval).

- [ ] **Step 5: Write the bilan**

Append to the END of `tasks/todo.md` a section titled `### Bilan du lot — confiance par projet (2026-10-02)`, in the style of the two bilans just above it (plugins, MCP enrichi). Cover, honestly:
- the three holes closed (project plugins imported on open; project `.mcp.json` servers started on open; a repo-shipped `.openagent/config.json` switching off confirmations or the read-only mode — the third found while designing this lot), and that the "Risque accepté" paragraphs of the plugins and MCP bilans are now closed by this lot;
- the design (one decision per project, fingerprint of plugins + `.mcp.json`, registry in the data home never in the project, relaxations approved by value, app-made writes approving only their own fields, stale-token refusal);
- the plan-writing ruling on the corrupt registry (moved aside to `trusted-projects.json.corrupt-<timestamp>`, never deleted);
- the real test totals (exact N/N from Step 2) and the four Electron proofs;
- the explicit out-of-scope list from the spec (project text such as `custom_prompt`/`OPENAGENT.md`/`memory.md`; helper modules imported by a plugin; hash-to-import swap; an already-authorized shell command; `ignored_patterns`; global content).

- [ ] **Step 6: Commit and push**

```bash
git add tasks/todo.md
git commit -m "docs: bilan for the per-project trust lot"
git push
```
