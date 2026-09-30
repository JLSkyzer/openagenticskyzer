# Node Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drop `.mjs`/`.mts` files into three well-known directories to add real agent tools to openagent, without any code change — the Node-native replacement for Python's unported `plugins/loader.py`.

**Architecture:** One new pure core module (`core/plugin-loader.mts`) dynamically `import()`s user files, validates what they export against the project's existing `ToolSpec` contract, and forces every plugin tool into the `'extension'` permission category. Wired into the worker's existing `registerTools()` alongside MCP tools, with a read-only "Plugins" section in the existing Outils settings tab.

**Tech Stack:** TypeScript (`.mts`, Node's native type-stripping — no build step), Node `dynamic import()`, existing `core/tool-kit.mts::defineTool`/`core/json-store.mts::metadataDirectory`.

**Spec:** `docs/superpowers/specs/2026-10-01-node-plugin-system-design.md`

## Global Constraints

- Three scan directories, exactly: `<home>/tools`, `<folder>/tools`, `<folder>/.openagent/tools` (via `metadataDirectory`, anti-junction protected). `<folder>` may be `null` (no active project yet) — only `<home>/tools` is scanned in that case, matching Python's own `if folder:` guard in `_plugin_dirs`.
- Accepted extensions: `.mjs`, `.mts`. Files starting with `.` or named `__init__.*` are ignored.
- A plugin file exports `getTools()` (sync or async) returning an array of `ToolSpec`-shaped objects (`core/tool-kit.mts`), and optionally `onLoad(folder)`.
- The `category` a plugin declares is always discarded and forced to `'extension'`.
- One broken file never blocks another file or another directory — errors are collected, never thrown past `loadPlugins`.
- A file whose `getTools()` returns even one invalid tool registers **none** of that file's tools (all-or-nothing per file, matching Python's `any(invalid for tool in loaded)` check before `tools.extend(loaded)`).
- No RED-first unit test is skipped: every new behavior in `core/plugin-loader.mts` gets a real fixture-file test first (write real `.mjs` files to a temp dir — never mock the filesystem or `import()`).

---

### Task 1: `core/plugin-loader.mts` — scanning, loading, validation

**Files:**
- Create: `electron/core/plugin-loader.mts`
- Test: `electron/tests/plugin-loader.test.mts`

**Interfaces:**
- Produces: `loadPlugins(folder: string | null, home: string): Promise<{ tools: AgentTool[]; errors: string[] }>` — the only export later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Create `electron/tests/plugin-loader.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-plugin-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  return { root, home, project };
}

const VALID_PLUGIN = `
export function getTools() {
  return [{
    name: 'echo_plugin',
    description: 'Echoes the given text',
    category: 'read',
    properties: { text: { type: 'string' } },
    required: ['text'],
    execute: async (args) => 'echo: ' + args.text,
  }];
}
`;

test('a valid plugin in the global tools directory is loaded and its tool is really callable', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'echo.mjs'), VALID_PLUGIN);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.deepEqual(errors, []);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo_plugin');
  const output = await tools[0].execute({ text: 'bonjour' }, new AbortController().signal);
  assert.equal(output, 'echo: bonjour');
});

test('the category a plugin declares is always ignored — forced to extension', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'echo.mjs'), VALID_PLUGIN);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools } = await loadPlugins(project, home);
  assert.equal(tools[0].category, 'extension', 'declared as read in the plugin, must come out as extension');
});

test('all three scan directories are read: global, project/tools, project/.openagent/tools', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'a.mjs'), VALID_PLUGIN.replace('echo_plugin', 'tool_a'));
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', 'b.mjs'), VALID_PLUGIN.replace('echo_plugin', 'tool_b'));
  await mkdir(join(project, '.openagent', 'tools'), { recursive: true });
  await writeFile(join(project, '.openagent', 'tools', 'c.mjs'), VALID_PLUGIN.replace('echo_plugin', 'tool_c'));

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools.map(t => t.name).sort(), ['tool_a', 'tool_b', 'tool_c']);
});

test('folder=null only scans the global directory — no project to know about yet', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'a.mjs'), VALID_PLUGIN.replace('echo_plugin', 'tool_a'));
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', 'b.mjs'), VALID_PLUGIN.replace('echo_plugin', 'tool_b'));

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(null, home);
  assert.deepEqual(errors, []);
  assert.deepEqual(tools.map(t => t.name), ['tool_a']);
});

test('a file with no getTools() is isolated — its error is reported, other files still load', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'broken.mjs'), `export const notGetTools = () => [];`);
  await writeFile(join(home, 'tools', 'good.mjs'), VALID_PLUGIN);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo_plugin');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /broken\.mjs.*getTools/);
});

test('a file whose getTools() returns one invalid tool among valid ones registers NEITHER — all-or-nothing per file', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'mixed.mjs'), `
    export function getTools() {
      return [
        { name: 'good_tool', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' },
        { description: 'bad, no name' },
      ];
    }
  `);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.equal(tools.length, 0, 'good_tool must not be registered either — the whole file is rejected');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /mixed\.mjs.*invalide/);
});

test('__init__ files and hidden files are ignored, a missing tools directory is silently skipped', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', '__init__.mjs'), VALID_PLUGIN);
  await writeFile(join(home, 'tools', '.hidden.mjs'), VALID_PLUGIN);
  // project/tools deliberately does not exist

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.deepEqual(tools, []);
  assert.deepEqual(errors, []);
});

test('onLoad(folder) is really called with the active folder after a successful load', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'hook.mjs'), `
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export function getTools() { return []; }
    export async function onLoad(folder) {
      await writeFile(join(folder, 'onload-proof.txt'), 'loaded: ' + folder);
    }
  `);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  await loadPlugins(project, home);
  const proof = await readFile(join(project, 'onload-proof.txt'), 'utf8');
  assert.match(proof, /^loaded:/);
});

test('loadPlugins refuses a relative home, and a relative non-null folder', async t => {
  const { home, project } = await fixture(t);
  const { loadPlugins } = await import('../core/plugin-loader.mts');
  await assert.rejects(loadPlugins(project, 'relative/home'), /absolus/);
  await assert.rejects(loadPlugins('relative/path', home), /absolus/);
  await assert.doesNotReject(loadPlugins(null, home), 'null folder is valid, not a relative-path violation');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/plugin-loader.test.mts`
Expected: every test fails with `Cannot find module '../core/plugin-loader.mts'` (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Write the implementation**

Create `electron/core/plugin-loader.mts`:

```typescript
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentTool } from './agent.mts';
import { metadataDirectory } from './json-store.mts';
import { defineTool, type ToolSpec } from './tool-kit.mts';

const PLUGIN_EXTENSIONS = new Set(['.mjs', '.mts']);

export interface PluginLoadResult {
  tools: AgentTool[];
  errors: string[];
}

async function pluginDirectories(folder: string | null, home: string): Promise<string[]> {
  const dirs = [join(home, 'tools')];
  if (folder) {
    dirs.push(join(folder, 'tools'));
    try { dirs.push(join(await metadataDirectory(folder), 'tools')); }
    catch { /* folder invalid/redirected — the other two directories still get scanned */ }
  }
  return dirs;
}

async function pluginFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter(entry => entry.isFile() && PLUGIN_EXTENSIONS.has(extname(entry.name)) && !entry.name.startsWith('.') && !entry.name.startsWith('__init__'))
    .map(entry => join(dir, entry.name))
    .sort();
}

function isValidSpec(value: unknown): value is ToolSpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as Record<string, unknown>;
  return typeof spec.name === 'string' && spec.name.length > 0 && typeof spec.execute === 'function';
}

/**
 * Loads agent tools from user-authored plugin files — the Node-native equivalent of Python's
 * plugins/loader.py (same 3 scan directories: global, project/tools, project/.openagent/tools —
 * the last two skipped when `folder` is null, matching Python's own `if folder:` guard). A plugin
 * file exports getTools() returning ToolSpec-shaped objects (core/tool-kit.mts, the same contract
 * every internal tool already uses) and an optional onLoad(folder) hook. The category a plugin
 * declares is always ignored and forced to 'extension' — the same trust level MCP tools already
 * get, since a plugin is arbitrary, unsandboxed code that must never self-declare 'read' to skip
 * permission confirmation. One broken plugin file is isolated and never blocks the others.
 */
export async function loadPlugins(folder: string | null, home: string): Promise<PluginLoadResult> {
  if (!isAbsolute(home)) throw new Error('Chemins absolus requis');
  if (folder !== null && !isAbsolute(folder)) throw new Error('Chemins absolus requis');
  const tools: AgentTool[] = [];
  const errors: string[] = [];
  for (const dir of await pluginDirectories(folder, home)) {
    for (const file of await pluginFiles(dir)) {
      try {
        const module = await import(pathToFileURL(file).href);
        if (typeof module.getTools !== 'function') throw new Error('pas de fonction getTools()');
        const loaded = await module.getTools();
        if (!Array.isArray(loaded)) throw new Error('getTools() doit retourner un tableau');
        const fileTools = loaded.map((spec: unknown) => {
          if (!isValidSpec(spec)) throw new Error('getTools() contient un outil invalide');
          return defineTool({ ...(spec as ToolSpec), category: 'extension' });
        });
        tools.push(...fileTools);
        if (typeof module.onLoad === 'function' && folder) await module.onLoad(folder);
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
      }
    }
  }
  return { tools, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd electron && node --experimental-strip-types --test tests/plugin-loader.test.mts`
Expected: all 9 tests PASS.

- [ ] **Step 5: Type-check**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json`
Expected: same 5 pre-existing unrelated errors only (`local-engine.mts`, `local-provider.mts`, `pdf-loader.ts`, 2× `local-provider.test.mts`) — no new error.

- [ ] **Step 6: Commit**

```bash
cd electron
git add core/plugin-loader.mts tests/plugin-loader.test.mts
git commit -m "feat: Node-native plugin loader (core/plugin-loader.mts)"
```

---

### Task 2: Worker wiring — `registerTools`, new `plugin-list` op, real agent-turn proof

**Files:**
- Modify: `electron/worker.mjs` (import, `ops` Set, `registerTools`, op handler in `handle()`)
- Modify: `electron/main.cjs` (`allowed` Set)
- Test: `electron/tests/worker-plugin.test.mts`

**Interfaces:**
- Consumes: `loadPlugins(folder, home)` from Task 1 (`../core/plugin-loader.mts`).
- Produces: worker op `plugin-list` — payload `{ folder: string | null }`, result `{ tools: string[]; errors: string[] }` (tool **names** only — the UI never needs the executable functions).

- [ ] **Step 1: Write the failing tests**

Create `electron/tests/worker-plugin.test.mts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

function callWorker(worker: Worker, op: string, payload: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = `plugin-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload });
  });
}

test('worker::send registers a real plugin tool and actually calls it end to end', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'echo.mjs'), `
    export function getTools() {
      return [{
        name: 'plugin_echo',
        description: 'Echoes text from a real plugin file',
        category: 'read',
        properties: { text: { type: 'string' } },
        required: ['text'],
        execute: async (args) => 'plugin says: ' + args.text,
      }];
    }
  `);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());
  await callWorker(worker, 'save-global-settings', { patch: { agent_mode: 'auto', permission_mode: 'auto' } });

  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount++;
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (requestCount === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'plugin_echo', arguments: JSON.stringify({ text: 'bonjour' }) } }] },
            finish_reason: 'tool_calls',
          }],
        }));
      } else {
        response.end(JSON.stringify({ choices: [{ message: { content: 'Fait.' }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const port = (server.address() as { port: number }).port;
  const connection = { provider: 'test', base_url: `http://127.0.0.1:${port}/v1`, model: 'test-model', api_key: 'fake' };

  const { runId } = await callWorker(worker, 'send', { folder: project, branchId: 'main', text: 'utilise le plugin', connection });
  const events: any[] = [];
  await new Promise<void>(resolve => {
    const listener = (message: any) => {
      if (message?.type === 'event' && message.event === 'agent' && message.runId === runId) {
        events.push(message);
        if (['done', 'error', 'stopped'].includes(message.kind)) { worker.off('message', listener); resolve(); }
      }
    };
    worker.on('message', listener);
  });

  assert.equal(events.at(-1).kind, 'done', `expected done, got: ${events.map(e => e.kind).join(',')}`);
  const toolStart = events.find(e => e.kind === 'tool-start');
  assert.equal(toolStart.tool, 'plugin_echo');
  assert.equal(toolStart.category, 'extension', 'forced to extension regardless of what the plugin declared');

  const messages = await callWorker(worker, 'messages', { folder: project, branchId: 'main' });
  const toolResult = messages.find((m: any) => m.role === 'tool');
  assert.match(toolResult.content, /plugin says: bonjour/);
});

test('worker::plugin-list reports loaded plugin names and isolated errors for the active folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-plugin-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'good.mjs'), `export function getTools() { return [{ name: 'good_tool', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' }]; }`);
  await writeFile(join(home, 'tools', 'bad.mjs'), `export const notGetTools = true;`);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  const result = await callWorker(worker, 'plugin-list', { folder: project });
  assert.deepEqual(result.tools, ['good_tool']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /bad\.mjs/);
});

test('worker::plugin-list with folder=null only reports global plugins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-worker-plugin-noproject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'global.mjs'), `export function getTools() { return [{ name: 'global_tool', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' }]; }`);

  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: home } });
  t.after(() => worker.terminate());

  const result = await callWorker(worker, 'plugin-list', { folder: null });
  assert.deepEqual(result.tools, ['global_tool']);
  assert.deepEqual(result.errors, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd electron && node --experimental-strip-types --test tests/worker-plugin.test.mts`
Expected: all 3 fail — `send` never calls `plugin_echo` (unknown tool to the model/agent), and `plugin-list` rejects with "Opération IPC inconnue".

- [ ] **Step 3: Wire the worker**

In `electron/worker.mjs`, add the import next to the other core imports (after the `searchTools`/`semantic-index` imports already there):

```javascript
import { loadPlugins } from './core/plugin-loader.mts';
```

Add `'plugin-list'` to the `ops` Set (find the existing line ending in `'index-status', 'knowledge-list', 'knowledge-add', 'knowledge-remove', 'shutdown']);` and insert before `'shutdown'`):

```javascript
const ops = new Set(['global-settings', 'project-settings', 'save-global-settings', 'save-project-settings', 'list-branches', 'messages', 'save-messages', 'fork', 'list_folders', 'activate_folder', 'settings', 'save_settings', 'send', 'stop', 'permission-decision', 'clear-history', 'remove-folder', 'reset-global-settings', 'compact', 'list-prompts', 'read-project-memory', 'export-conversation', 'gguf-list', 'gguf-add', 'gguf-remove', 'git-status', 'test-hf-token', 'migrate-data-dir', 'init-project', 'mcp-list', 'mcp-add', 'mcp-remove', 'index-status', 'knowledge-list', 'knowledge-add', 'knowledge-remove', 'plugin-list', 'shutdown']);
```

In `registerTools(folder)`, add plugin tools alongside MCP tools:

```javascript
async function registerTools(folder) {
  const effective = await settings.effective(folder);
  const { tools: mcpDiscovered, errors: mcpErrors } = await mcpTools(await mcpConfig.list());
  // A broken/unreachable MCP server never blocks the turn or surfaces to the chat — same
  // server-log-only isolation agent.py's own logging.getLogger("openagentic.mcp").warning had.
  for (const error of mcpErrors) console.error(`[mcp] ${error}`);
  const { tools: pluginTools, errors: pluginErrors } = await loadPlugins(folder, dataHome);
  for (const error of pluginErrors) console.error(`[plugin] ${error}`);
  const tools = [
    ...await workspaceTools(folder, effective.ignored_patterns),
    ...await memoryTools(folder, dataHome),
    ...await gitTools(folder),
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome),
    ...mcpDiscovered,
    ...pluginTools,
  ];
  return { effective, tools };
}
```

In the `handle()` function, add the op handler next to `if (op === 'mcp-list') ...` (find that exact line):

```javascript
    if (op === 'plugin-list') {
      const { tools, errors } = await loadPlugins(payload.folder ?? null, dataHome);
      result = { tools: tools.map(t => t.name), errors };
    }
```

In `electron/main.cjs`, add `'plugin-list'` to the `allowed` Set (find the line ending `...,'knowledge-list','knowledge-add','knowledge-remove']);` and insert before the closing `]`):

```javascript
const allowed = new Set(['global-settings','project-settings','save-global-settings','save-project-settings','list-branches','messages','save-messages','fork','list_folders','activate_folder','settings','save_settings','send','stop','permission-decision','clear-history','remove-folder','reset-global-settings','compact','list-prompts','read-project-memory','export-conversation','gguf-list','gguf-add','gguf-remove','git-status','test-hf-token','migrate-data-dir','init-project','mcp-list','mcp-add','mcp-remove','index-status','knowledge-list','knowledge-add','knowledge-remove','plugin-list']);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd electron && node --experimental-strip-types --test tests/worker-plugin.test.mts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Confirm `main-routing.test.mts` still passes**

Run: `cd electron && node --experimental-strip-types --test tests/main-routing.test.mts`

`plugin-list` is a normal worker op reached through `allowed`/`ops` (not a `main.cjs`-only op like `pick-gguf`), so `main.isBackendOp('plugin-list')` already returns true once Step 3's `main.cjs` edit lands, and `HANDLED_BY_MAIN` needs no change. This step is a verification, not expected to require an edit.

Expected: PASS with no edits needed.

- [ ] **Step 6: Commit**

```bash
cd electron
git add worker.mjs main.cjs tests/worker-plugin.test.mts
git commit -m "feat: wire the plugin loader into the worker (plugin-list op, registerTools)"
```

---

### Task 3: Read-only "Plugins" UI in the Outils settings tab

**Files:**
- Modify: `electron/renderer-src/src/ipc/bridge.ts` (new `listPlugins` + `PluginListResult` type)
- Modify: `electron/renderer-src/src/components/settings/ToolsTab.tsx` (new `activeFolder` prop, new Plugins section)
- Modify: `electron/renderer-src/src/components/settings/SettingsDialog.tsx` (pass `activeFolder` to `ToolsTab`)
- Create: `electron/tests/plugin-visual.cjs`, `electron/tests/run-plugin-visual.cjs`
- Modify: `electron/package.json` (new `test:plugins` script)

**Interfaces:**
- Consumes: worker op `plugin-list` from Task 2 (payload `{ folder: string | null }`, result `{ tools: string[]; errors: string[] }`).

- [ ] **Step 1: Add the bridge function**

In `electron/renderer-src/src/ipc/bridge.ts`, add next to the existing `McpServerConfig`/`listMcpServers` block:

```typescript
export interface PluginListResult { tools: string[]; errors: string[] }
export function listPlugins(folder: string | null): Promise<PluginListResult> {
  return request('plugin-list', { folder });
}
```

- [ ] **Step 2: Add the Plugins section to `ToolsTab.tsx`**

Replace the full contents of `electron/renderer-src/src/components/settings/ToolsTab.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { addMcpServer, listMcpServers, listPlugins, removeMcpServer, type McpServerConfig, type PluginListResult } from '../../ipc/bridge';
import { Group, Section } from './parts';
import { useToast } from '../../state/ToastProvider';

const button = 'self-start rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-300';

// Mirrors settings.py::_tab_tools' "Plugins Python" (now a real Node loader, see
// core/plugin-loader.mts and tasks/todo.md's plugin-system lot) and "Serveurs MCP (stdio)"
// groups — a full command line typed in one field, split into command + args, exactly like
// add_server.
export function ToolsTab({ activeFolder }: { activeFolder: string | null }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [commandLine, setCommandLine] = useState('');
  const [adding, setAdding] = useState(false);
  const [plugins, setPlugins] = useState<PluginListResult>({ tools: [], errors: [] });
  const { notify } = useToast();

  const refresh = () => listMcpServers().then(setServers).catch(() => {});
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    listPlugins(activeFolder).then(setPlugins).catch(() => setPlugins({ tools: [], errors: [] }));
  }, [activeFolder]);

  const handleAdd = async () => {
    const value = commandLine.trim();
    if (!value) return;
    setAdding(true);
    try {
      setServers(await addMcpServer(value));
      setCommandLine('');
      notify('Serveur MCP enregistré.', 'positive');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Impossible d’ajouter ce serveur.', 'negative');
    } finally {
      setAdding(false);
    }
  };
  const handleRemove = async (id: string) => {
    try { setServers(await removeMcpServer(id)); }
    catch { /* the list already reflects the last known-good state */ }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Outils et intégrations" badge="EXTENSIONS" />
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
            {plugins.errors.map(error => (
              <span key={error} data-testid="oa-plugin-error" className="font-mono text-xs text-yellow-600">
                ⚠️ {error}
              </span>
            ))}
          </div>
        </Group>
        <Group>
          <div className="flex flex-col gap-2 px-4 py-3">
            <span className="text-xs font-medium text-gray-300">Serveurs MCP (stdio)</span>
            <span className="text-xs text-gray-600">
              Les commandes sont enregistrées ; elles ne sont lancées qu'au démarrage de chaque tour de l'agent.
            </span>
            {servers.length === 0 ? (
              <span data-testid="oa-mcp-empty" className="text-xs text-gray-600">
                Aucun serveur MCP configuré.
              </span>
            ) : (
              <div className="flex flex-col gap-1">
                {servers.map(server => (
                  <div key={server.id} data-testid="oa-mcp-entry" className="flex items-center justify-between gap-2 rounded px-2 py-1" style={{ background: '#0a0a1a', border: '1px solid #1e1e3a' }}>
                    <span className="truncate font-mono text-xs text-blue-400">
                      {server.command} {server.args.join(' ')}
                    </span>
                    <button
                      data-testid="oa-mcp-remove"
                      onClick={() => void handleRemove(server.id)}
                      className="shrink-0 text-xs text-gray-500 hover:text-red-400"
                      title="Retirer"
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
          </div>
        </Group>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Pass `activeFolder` from `SettingsDialog.tsx`**

In `electron/renderer-src/src/components/settings/SettingsDialog.tsx`, find the line `tools: <ToolsTab />,` and replace it:

```typescript
    tools: <ToolsTab activeFolder={activeFolder} />,
```

- [ ] **Step 4: Type-check**

Run: `cd electron && npx tsc --noEmit -p renderer-src/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Rebuild the renderer**

Run: `cd electron && npm run renderer:build`
Expected: build succeeds (the pre-existing ">500kB chunk" warning is fine, unrelated).

- [ ] **Step 6: Write the real Electron visual test**

Create `electron/tests/plugin-visual.cjs`:

```javascript
// Run with Electron, not node. Proves the "Outils" tab's read-only Plugins section end to end
// through the REAL UI and the REAL worker.mjs plugin-list op (a real .mjs file on disk, really
// imported). The deeper proof — a real agent turn actually calling a real plugin tool — already
// exists at the worker level in tests/worker-plugin.test.mts; this visual test does not repeat
// that here, only the UI plumbing around the list + error display.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises');
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

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-plugin-visual-'));
  const home = join(root, 'home');
  const alpha = join(root, 'alpha');
  await Promise.all([mkdir(home), mkdir(alpha)]);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'good.mjs'), `export function getTools() { return [{ name: 'greet_plugin', description: 'ok', category: 'read', properties: {}, execute: async () => 'ok' }]; }`);
  await writeFile(join(home, 'tools', 'broken.mjs'), `export const notGetTools = true;`);
  await writeFile(join(home, 'folders.json'), JSON.stringify([{ path: alpha, last_used: new Date().toISOString() }]));

  const screenshotDir = process.env.OPENAGENT_PLUGIN_SCREENSHOT_DIR || home;
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
    const exists = selector => js(`!!document.querySelector(${q(selector)})`);
    const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
    const enter = name => js(`[...document.querySelectorAll('[data-testid="oa-folder-entry"]')].find(e => e.textContent.includes(${JSON.stringify(name)}))?.click()`);

    await waitFor(() => js(`document.querySelectorAll('[data-testid="oa-folder-entry"]').length === 1`), { what: 'sidebar loaded' });
    await enter('alpha');
    await waitFor(() => exists('#oa-input-ta'), { what: 'alpha activated' });

    await click('#oa-settings-btn');
    await waitFor(() => js(`!!document.querySelector('[data-testid="oa-settings-tab"][data-tab="tools"]')`), { what: 'Outils tab exists' });
    await click('[data-testid="oa-settings-tab"][data-tab="tools"]');
    await waitFor(() => exists('[data-testid="oa-plugin-entry"]'), { what: 'the real plugin is listed' });
    assert.match(await text('[data-testid="oa-plugin-entry"]'), /greet_plugin/);
    await waitFor(() => exists('[data-testid="oa-plugin-error"]'), { what: 'the broken plugin error is shown' });
    assert.match(await text('[data-testid="oa-plugin-error"]'), /broken\.mjs/);
    await writeFile(join(screenshotDir, 'plugin-1-list.png'), await capturePng(win));

    process.stdout.write(`PASS plugin section: real plugin file listed, real broken-plugin error shown (Electron ${process.versions.electron})\n`);
    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
  } finally {
    win?.destroy();
    worker?.terminate();
    if (!process.env.OPENAGENT_PLUGIN_SCREENSHOT_DIR) await rm(root, { recursive: true, force: true });
  }
}).then(() => flush()).then(() => app.exit(0)).catch(async error => {
  process.stderr.write(`FAIL plugin visual: ${error.stack || error}\n`);
  await flush();
  app.exit(1);
});
```

Create `electron/tests/run-plugin-visual.cjs`:

```javascript
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = require('electron');
const result = spawnSync(executable, [join(__dirname, 'plugin-visual.cjs')], {
  encoding: 'utf8', timeout: 120000, windowsHide: true, env,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) process.stderr.write(`Electron test process: ${result.error.code}\n`);
process.exit(result.status === 0 && result.stdout?.includes('PASS plugin section') ? 0 : 1);
```

In `electron/package.json`, add next to `"test:knowledge": "node tests/run-knowledge-visual.cjs",`:

```json
    "test:plugins": "node tests/run-plugin-visual.cjs",
```

- [ ] **Step 7: Run the visual test**

Run: `cd electron && npm run test:plugins`
Expected: `PASS plugin section: real plugin file listed, real broken-plugin error shown (Electron ...)`

- [ ] **Step 8: Commit**

```bash
cd electron
git add renderer-src/src/ipc/bridge.ts renderer-src/src/components/settings/ToolsTab.tsx renderer-src/src/components/settings/SettingsDialog.tsx tests/plugin-visual.cjs tests/run-plugin-visual.cjs package.json
git commit -m "feat: real-time Plugins list in the Outils settings tab"
```

---

### Task 4: Final verification and bilan

**Files:**
- Modify: `electron/tests/all.mts` (add the two new `.test.mts` imports)
- Modify: `tasks/todo.md` (plan section + bilan)

- [ ] **Step 1: Register the new test files in the suite**

In `electron/tests/all.mts`, add after the last existing import line (`import './worker-knowledge.test.mts';`):

```typescript
import './plugin-loader.test.mts';
import './worker-plugin.test.mts';
```

- [ ] **Step 2: Run the full suite**

Run: `cd electron && node --experimental-strip-types --test tests/all.mts`
Expected: all tests pass (previous total + 9 from Task 1 + 3 from Task 2 = previous + 12), zero failures.

- [ ] **Step 3: Type-check both tsconfigs**

Run: `cd electron && npx tsc --noEmit -p tsconfig.core.json && npx tsc --noEmit -p renderer-src/tsconfig.json`
Expected: same 5 pre-existing unrelated errors on the core config, zero on the renderer config.

- [ ] **Step 4: Write the bilan in `tasks/todo.md`**

Add a new section (under the existing `### Lot actif suivant` heading structure this repo already uses) summarizing: what was delivered (plugin loader, worker wiring, read-only UI), the real proofs collected (unit fixtures, a real agent turn calling a real plugin tool, a real Electron screenshot of the list), and explicitly restate the "hors scope" items from the spec (no sandbox, no add/remove UI, no plugin marketplace) so nobody later assumes they were silently added.

- [ ] **Step 5: Commit**

```bash
cd electron
git add tests/all.mts
cd ..
git add tasks/todo.md
git commit -m "docs: bilan for the Node plugin system lot"
git push
```
