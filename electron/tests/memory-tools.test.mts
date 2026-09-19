import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class MissingTool extends Error {}

// A refusal only counts if the tool exists: a missing tool must never pass as "it refused".
async function refuses(promise: Promise<unknown>, expected?: RegExp) {
  await assert.rejects(promise, (error: any) => {
    assert.ok(!(error instanceof MissingTool), error.message);
    return expected ? expected.test(String(error.message)) : true;
  });
}

const STAMP = String.raw`<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->`;

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  await Promise.all([home, project, outside].map(p => mkdir(p)));
  const { memoryTools } = await import('../core/memory-tools.mts');
  const tools = await memoryTools(project, home);
  async function invoke(name: string, args: Record<string, unknown>) {
    const tool = tools.find(entry => entry.name === name);
    if (!tool) throw new MissingTool(`Missing ${name}`);
    tool.validate(args);
    return tool.execute(args, new AbortController().signal);
  }
  const projectFile = join(project, '.openagent', 'memory.md');
  const globalFile = join(home, 'memory.md');
  return { home, project, outside, invoke, tools, projectFile, globalFile };
}

test('save_memory writes a timestamped entry to the project memory by default', async t => {
  const { invoke, projectFile, globalFile } = await fixture(t);
  const result = await invoke('save_memory', { facts: '  Le projet utilise pnpm.  ' });
  assert.match(result, /Mémorisé.*projet/i);
  assert.match(await readFile(projectFile, 'utf8'), new RegExp(`^${STAMP}\\nLe projet utilise pnpm\\.\\n?$`));
  await assert.rejects(stat(globalFile), 'the global memory is untouched');
});

test('save_memory can target the global memory', async t => {
  const { invoke, projectFile, globalFile } = await fixture(t);
  assert.match(await invoke('save_memory', { facts: 'Préfère le français', scope: 'global' }), /globale/i);
  assert.match(await readFile(globalFile, 'utf8'), new RegExp(`^${STAMP}\\nPréfère le français\\n?$`));
  await assert.rejects(stat(projectFile));
});

test('a second entry is appended after a blank line, the first has no leading blank lines', async t => {
  const { invoke, projectFile } = await fixture(t);
  await invoke('save_memory', { facts: 'un' });
  await invoke('save_memory', { facts: 'deux\nsur deux lignes' });
  const content = await readFile(projectFile, 'utf8');
  assert.equal(content.startsWith('<!--'), true);
  assert.match(content, new RegExp(`^${STAMP}\\nun\\n\\n${STAMP}\\ndeux\\nsur deux lignes\\n?$`));
});

test('blank facts, an unknown scope and oversized facts are refused or ignored without writing', async t => {
  const { invoke, projectFile } = await fixture(t);
  assert.match(await invoke('save_memory', { facts: '   \n ' }), /vide/i);
  await assert.rejects(stat(projectFile), 'blank facts write nothing');
  await refuses(invoke('save_memory', { facts: 'x', scope: 'everywhere' }), /autoris/i);
  await refuses(invoke('save_memory', { facts: 'x'.repeat(20001) }), /texte/i);
});

test('a full memory refuses more facts instead of growing without bound', async t => {
  const { invoke, projectFile, project } = await fixture(t);
  await mkdir(join(project, '.openagent'), { recursive: true });
  await writeFile(projectFile, 'y'.repeat(1024 * 1024));
  await refuses(invoke('save_memory', { facts: 'encore' }), /pleine/i);
});

test('read_memory reports empty, project-only, global-only and both (global first)', async t => {
  const { invoke } = await fixture(t);
  assert.equal(await invoke('read_memory', {}), 'La mémoire est vide.');
  await invoke('save_memory', { facts: 'fait projet' });
  let out = await invoke('read_memory', {});
  assert.match(out, /^\[Mémoire projet\]\n<!--/);
  assert.equal(out.includes('Mémoire globale'), false);
  await invoke('save_memory', { facts: 'fait global', scope: 'global' });
  out = await invoke('read_memory', {});
  assert.ok(out.indexOf('[Mémoire globale]') < out.indexOf('[Mémoire projet]'));
  assert.match(out, /fait global/);
  assert.match(out, /fait projet/);
});

test('forget_memory removes whole entries matching the keyword, case-insensitively', async t => {
  const { invoke, projectFile } = await fixture(t);
  await invoke('save_memory', { facts: 'garder ceci' });
  await invoke('save_memory', { facts: 'Le mot de passe est Zorglub\nsur deux lignes' });
  await invoke('save_memory', { facts: 'et ceci aussi' });
  assert.match(await invoke('forget_memory', { keyword: 'zorglub' }), /1 entrée.*zorglub/i);
  const content = await readFile(projectFile, 'utf8');
  assert.equal(content.includes('Zorglub'), false);
  assert.equal(content.includes('sur deux lignes'), false, 'the multi-line entry left no orphan fragment');
  assert.match(content, /garder ceci/);
  assert.match(content, /et ceci aussi/);
  assert.equal((content.match(/<!--/g) ?? []).length, 2, 'no orphan timestamp header remains');
});

test('forgetting the only entry leaves the memory empty', async t => {
  const { invoke, projectFile } = await fixture(t);
  await invoke('save_memory', { facts: 'seul fait' });
  await invoke('forget_memory', { keyword: 'seul' });
  assert.equal(await invoke('read_memory', {}), 'La mémoire est vide.');
  const remaining = await readFile(projectFile, 'utf8').catch(() => '');
  assert.equal(remaining.trim(), '');
});

test('forget_memory says so when nothing matches and leaves the file byte-identical', async t => {
  const { invoke, projectFile } = await fixture(t);
  await invoke('save_memory', { facts: 'un fait' });
  const before = await readFile(projectFile);
  assert.match(await invoke('forget_memory', { keyword: 'absent' }), /aucune entrée/i);
  assert.deepEqual(await readFile(projectFile), before);
});

test('forget_memory refuses an empty keyword, which would otherwise wipe every entry', async t => {
  const { invoke, projectFile } = await fixture(t);
  await invoke('save_memory', { facts: 'précieux' });
  const before = await readFile(projectFile);
  await refuses(invoke('forget_memory', { keyword: '' }), /vide/i);
  await refuses(invoke('forget_memory', { keyword: '   ' }), /vide/i);
  assert.deepEqual(await readFile(projectFile), before);
});

test('forget_memory can target the global memory', async t => {
  const { invoke, globalFile } = await fixture(t);
  await invoke('save_memory', { facts: 'secret global', scope: 'global' });
  await invoke('forget_memory', { keyword: 'secret', scope: 'global' });
  assert.equal((await readFile(globalFile, 'utf8').catch(() => '')).trim(), '');
});

test('concurrent saves are serialized: none is lost, no temp file is left behind', async t => {
  const { invoke, projectFile, project } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => invoke('save_memory', { facts: `fait-${i}` })));
  const content = await readFile(projectFile, 'utf8');
  for (let i = 0; i < 12; i++) assert.match(content, new RegExp(`fait-${i}\\b`));
  assert.deepEqual(await readdir(join(project, '.openagent')), ['memory.md']);
});

test('a redirected .openagent directory cannot send the memory outside the project', async t => {
  const { invoke, project, outside } = await fixture(t);
  await symlink(outside, join(project, '.openagent'), 'junction');
  await refuses(invoke('save_memory', { facts: 'fuite' }));
  await refuses(invoke('forget_memory', { keyword: 'x' }));
  assert.deepEqual(await readdir(outside), []);
});

test('a memory.md that is a link is refused, never written through', async t => {
  const { invoke, project, outside } = await fixture(t);
  await mkdir(join(project, '.openagent'));
  // A junction (creatable without privilege on Windows) is what a redirected memory.md
  // looks like here: not a regular file, so it must be refused rather than followed.
  await symlink(outside, join(project, '.openagent', 'memory.md'), 'junction');
  await refuses(invoke('save_memory', { facts: 'fuite' }), /illisible|redirig/i);
  await refuses(invoke('forget_memory', { keyword: 'x' }), /illisible|redirig/i);
  await refuses(invoke('read_memory', {}), /illisible|redirig/i);
  assert.deepEqual(await readdir(outside), [], 'nothing was written through the link');
});

test('what the tools save reaches the instructions the model is actually given', async t => {
  const { invoke, home, project } = await fixture(t);
  await invoke('save_memory', { facts: 'fait-projet-visible' });
  await invoke('save_memory', { facts: 'fait-global-visible', scope: 'global' });
  const { buildInstructions } = await import('../core/context.mts');
  const { instructions } = await buildInstructions({ folder: project, home, base: 'Base' });
  assert.match(instructions, /\[MÉMOIRE PROJET\][\s\S]*fait-projet-visible/);
  assert.match(instructions, /\[MÉMOIRE GLOBALE\][\s\S]*fait-global-visible/);
  await invoke('forget_memory', { keyword: 'projet-visible' });
  const after = await buildInstructions({ folder: project, home, base: 'Base' });
  assert.equal(after.instructions.includes('fait-projet-visible'), false, 'a forgotten fact is no longer given to the model');
});
