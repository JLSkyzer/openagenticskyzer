import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { defineTool } = await import('../core/tool-kit.mts');
const { workspaceTools } = await import('../core/workspace.mts');

const noop = async () => 'ok';
const tool = (properties: Record<string, any>, required: string[] = []) =>
  defineTool({ name: 'demo', description: 'demo', category: 'read', properties, required, execute: noop });

test('defineTool publishes a strict JSON schema built from the same rules it validates with', () => {
  const t = tool({ path: { type: 'string' }, n: { type: 'integer' } }, ['path']);
  assert.deepEqual(t.parameters, {
    type: 'object',
    properties: { path: { type: 'string' }, n: { type: 'integer' } },
    required: ['path'],
    additionalProperties: false,
  });
});

test('a missing required argument is refused by name, an undeclared one is dropped, non-objects are refused', () => {
  const t = tool({ path: { type: 'string' } }, ['path']);
  assert.throws(() => t.validate({}), { message: 'path est requis' });
  const args: Record<string, unknown> = { path: 'a', extra: 1, encoding: 'utf8' };
  t.validate(args);
  assert.deepEqual(args, { path: 'a' }, 'the tool never sees a key it did not declare');
  assert.throws(() => t.validate(null as any), /objet/i);
  assert.throws(() => t.validate([] as any), /objet/i);
});

test('strings must be strings, without NUL and within their limit', () => {
  const t = tool({ s: { type: 'string' }, short: { type: 'string', maxLength: 3 } });
  assert.throws(() => t.validate({ s: 5 }), /texte/i);
  assert.throws(() => t.validate({ s: 'a\0b' }), /texte/i);
  assert.throws(() => t.validate({ s: 'x'.repeat(1048577) }), /texte/i);
  assert.throws(() => t.validate({ short: 'abcd' }), /texte/i);
  t.validate({ s: 'x'.repeat(1048576), short: 'abc' });
});

test('integers default to 1..1000000 and take explicit bounds; a string of digits is read as that integer', () => {
  const t = tool({ n: { type: 'integer' }, zeroOk: { type: 'integer', minimum: 0, maximum: 10 } });
  assert.throws(() => t.validate({ n: 0 }), { message: 'n doit être un entier entre 1 et 1000000' });
  assert.throws(() => t.validate({ n: 1000001 }), { message: 'n doit être un entier entre 1 et 1000000' });
  for (const bad of [1.5, '1.5', 'trois', true]) assert.throws(() => t.validate({ n: bad }), /n doit être un entier/);
  assert.throws(() => t.validate({ zeroOk: 11 }), { message: 'zeroOk doit être un entier entre 0 et 10' });
  assert.throws(() => t.validate({ zeroOk: -1 }), /zeroOk doit être un entier/);
  const coerced: Record<string, unknown> = { n: '3', zeroOk: ' 0 ' };
  t.validate(coerced);
  assert.deepEqual(coerced, { n: 3, zeroOk: 0 }, 'the tool receives real integers');
  t.validate({ n: 1000000, zeroOk: 10 });
});

test('booleans: real booleans, or exactly the strings "true" / "false"', () => {
  const t = tool({ flag: { type: 'boolean' } });
  for (const bad of [1, 0, null, 'yes', 'True']) assert.throws(() => t.validate({ flag: bad }), { message: 'flag doit être un booléen (true ou false)' });
  for (const [given, expected] of [[true, true], [false, false], ['true', true], ['false', false]] as const) {
    const args: Record<string, unknown> = { flag: given };
    t.validate(args);
    assert.equal(args.flag, expected);
  }
});

test('an enum only admits its listed values', () => {
  const t = tool({ topic: { type: 'string', enum: ['general', 'news'] } });
  assert.throws(() => t.validate({ topic: 'finance' }), /autoris/i);
  assert.throws(() => t.validate({ topic: 7 }), /texte|autoris/i);
  t.validate({ topic: 'news' });
});

test('an aborted signal stops the tool before it runs', async () => {
  let ran = false;
  const t = defineTool({ name: 'demo', description: 'd', category: 'read', properties: {}, execute: async () => { ran = true; return 'x'; } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(t.execute({}, controller.signal));
  assert.equal(ran, false);
  assert.equal(await t.execute({}, new AbortController().signal), 'x');
});

// Guard: a tool registered without a deliberate permission category must fail this test.
// When a later task adds tools, it adds them here — an unlisted tool is a defect, not a default.
const EXPECTED_CATEGORIES: Record<string, string> = {
  read_file: 'read', view_file: 'read', list_dir: 'read',
  create_file: 'write', edit_file: 'write', create_dir: 'write', delete_file: 'write',
  grep_file: 'read', glob_files: 'read', grep_codebase: 'read', delete_dir: 'write',
  save_memory: 'write', read_memory: 'read', forget_memory: 'write',
  git_status: 'read', git_diff: 'read', git_diff_staged: 'read', git_log: 'read', git_blame: 'read', git_branch_list: 'read',
  git_add: 'write', git_commit: 'write', git_checkout: 'write', git_create_branch: 'write', git_stash: 'write', git_stash_pop: 'write',
  // Remote operations always ask (like a shell command), even when file writes are pre-approved.
  git_push: 'shell', git_pull: 'shell',
  analyze_project_and_init: 'write',
  run_command: 'shell',
  fetch_url: 'network', internet_search: 'network',
};

test('every registered workspace tool has a valid, expected permission category', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-toolkit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { memoryTools } = await import('../core/memory-tools.mts');
  const { gitTools } = await import('../core/git-tools.mts');
  const { projectTools } = await import('../core/project-analyzer.mts');
  const { shellTools } = await import('../core/shell-tool.mts');
  const { webTools } = await import('../core/web-tools.mts');
  const tools = [...await workspaceTools(root, ''), ...await memoryTools(root, join(root, 'home')), ...await gitTools(root), ...projectTools(root), ...await shellTools(root), ...await webTools()];
  const valid = ['read', 'write', 'shell', 'network', 'extension'];
  for (const entry of tools) {
    assert.ok(valid.includes(entry.category), `${entry.name} has an unknown category`);
    assert.equal(entry.category, EXPECTED_CATEGORIES[entry.name], `${entry.name} is unlisted or misclassified`);
  }
  assert.deepEqual(tools.map(entry => entry.name).sort(), Object.keys(EXPECTED_CATEGORIES).sort(), 'the registry and the expected table list the same tools');
  assert.equal(new Set(tools.map(entry => entry.name)).size, tools.length, 'no duplicate tool name');
});
