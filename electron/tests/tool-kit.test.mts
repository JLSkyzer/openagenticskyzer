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

test('required and unknown arguments are rejected, non-objects too', () => {
  const t = tool({ path: { type: 'string' } }, ['path']);
  assert.throws(() => t.validate({}), /requis/i);
  assert.throws(() => t.validate({ path: 'a', extra: 1 }), /inconnu/i);
  assert.throws(() => t.validate(null as any), /objet/i);
  assert.throws(() => t.validate([] as any), /objet/i);
  t.validate({ path: 'a' });
});

test('strings must be strings, without NUL and within their limit', () => {
  const t = tool({ s: { type: 'string' }, short: { type: 'string', maxLength: 3 } });
  assert.throws(() => t.validate({ s: 5 }), /texte/i);
  assert.throws(() => t.validate({ s: 'a\0b' }), /texte/i);
  assert.throws(() => t.validate({ s: 'x'.repeat(1048577) }), /texte/i);
  assert.throws(() => t.validate({ short: 'abcd' }), /texte/i);
  t.validate({ s: 'x'.repeat(1048576), short: 'abc' });
});

test('integers default to 1..1000000 and take explicit bounds, floats and strings never pass', () => {
  const t = tool({ n: { type: 'integer' }, zeroOk: { type: 'integer', minimum: 0, maximum: 10 } });
  assert.throws(() => t.validate({ n: 0 }), /nombre/i);
  assert.throws(() => t.validate({ n: 1000001 }), /nombre/i);
  assert.throws(() => t.validate({ n: 1.5 }), /nombre/i);
  assert.throws(() => t.validate({ n: '3' }), /nombre/i);
  assert.throws(() => t.validate({ zeroOk: 11 }), /nombre/i);
  assert.throws(() => t.validate({ zeroOk: -1 }), /nombre/i);
  t.validate({ n: 1, zeroOk: 0 });
  t.validate({ n: 1000000, zeroOk: 10 });
});

test('booleans must be real booleans', () => {
  const t = tool({ flag: { type: 'boolean' } });
  for (const bad of ['true', 1, 0, null, 'yes']) assert.throws(() => t.validate({ flag: bad }), /booléen/i);
  t.validate({ flag: true });
  t.validate({ flag: false });
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
};

test('every registered workspace tool has a valid, expected permission category', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-toolkit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await workspaceTools(root, '');
  const valid = ['read', 'write', 'shell', 'network', 'extension'];
  for (const entry of tools) {
    assert.ok(valid.includes(entry.category), `${entry.name} has an unknown category`);
    assert.equal(entry.category, EXPECTED_CATEGORIES[entry.name], `${entry.name} is unlisted or misclassified`);
  }
  assert.deepEqual(tools.map(entry => entry.name).sort(), Object.keys(EXPECTED_CATEGORIES).sort(), 'the registry and the expected table list the same tools');
  assert.equal(new Set(tools.map(entry => entry.name)).size, tools.length, 'no duplicate tool name');
});
