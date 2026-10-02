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

test('a tool name runAgent would refuse (a space) rejects that file here, as its own error', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'spaced.mjs'), VALID_PLUGIN.replace('echo_plugin', 'bad name'));
  await writeFile(join(home, 'tools', 'good.mjs'), VALID_PLUGIN);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.deepEqual(tools.map(tool => tool.name), ['echo_plugin'], 'nothing from spaced.mjs, the other file unaffected');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /spaced\.mjs.*invalide/);
});

test('a later file reusing a name an earlier file already registered is rejected — first one wins', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'a.mjs'), VALID_PLUGIN.replace("'echo: '", "'first: '"));
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', 'b.mjs'), VALID_PLUGIN);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo_plugin');
  assert.equal(await tools[0].execute({ text: 'x' }, new AbortController().signal), 'first: x', 'the global (scanned first) one is kept');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /b\.mjs.*echo_plugin/);
});

test('a directory reached through two scanned paths (home = <projet>/.openagent) is loaded once, without self-collision', async t => {
  const { project } = await fixture(t);
  // The user opened the parent of their data folder as a project: <projet>/.openagent/tools IS <home>/tools.
  const home = join(project, '.openagent');
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'echo.mjs'), VALID_PLUGIN);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.deepEqual(errors, [], 'the second path to the same directory must not be scanned at all');
  assert.deepEqual(tools.map(tool => tool.name), ['echo_plugin']);
});

test('an edited plugin file is really re-imported on the next loadPlugins call, not served from the module cache', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  const file = join(home, 'tools', 'live.mjs');
  await writeFile(file, `throw new Error('version cassée');`);

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const first = await loadPlugins(project, home);
  assert.deepEqual(first.tools, []);
  assert.match(first.errors[0], /live\.mjs.*version cassée/);

  await writeFile(file, VALID_PLUGIN.replace("'echo: '", "'v2: '"));
  const second = await loadPlugins(project, home);
  assert.deepEqual(second.errors, [], 'the fixed file must load — a cached module would keep throwing');
  assert.equal(await second.tools[0].execute({ text: 'ok' }, new AbortController().signal), 'v2: ok');

  await writeFile(file, VALID_PLUGIN.replace("'echo: '", "'v3, plus long: '"));
  const third = await loadPlugins(project, home);
  assert.equal(await third.tools[0].execute({ text: 'ok' }, new AbortController().signal), 'v3, plus long: ok');
});

test('a .mts plugin is loaded too (type annotations stripped, cache-busting query included)', async t => {
  const { home, project } = await fixture(t);
  await mkdir(join(home, 'tools'), { recursive: true });
  await writeFile(join(home, 'tools', 'typed.mts'), VALID_PLUGIN.replace('async (args)', 'async (args: { text: string }): Promise<string>'));

  const { loadPlugins } = await import('../core/plugin-loader.mts');
  const { tools, errors } = await loadPlugins(project, home);
  assert.deepEqual(errors, []);
  assert.equal(await tools[0].execute({ text: 'x' }, new AbortController().signal), 'echo: x');
});

test('loadPlugins refuses a relative home, and a relative non-null folder', async t => {
  const { home, project } = await fixture(t);
  const { loadPlugins } = await import('../core/plugin-loader.mts');
  await assert.rejects(loadPlugins(project, 'relative/home'), /absolus/);
  await assert.rejects(loadPlugins('relative/path', home), /absolus/);
  await assert.doesNotReject(loadPlugins(null, home), 'null folder is valid, not a relative-path violation');
});

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
