import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROMPTS, PromptLibrary } from '../core/prompts.mts';

const IDS = ['refactor', 'tests', 'explain', 'pr_desc', 'debug', 'optimize', 'security', 'review', 'document', 'translate'];

async function home(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'openagent-prompts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the ten default prompts are those of the NiceGUI app, in the same order', () => {
  assert.deepEqual(DEFAULT_PROMPTS.map(p => p.id), IDS);
  for (const prompt of DEFAULT_PROMPTS) {
    assert.ok(prompt.name && prompt.template && prompt.icon && prompt.description, `${prompt.id} is complete`);
  }
  assert.ok(DEFAULT_PROMPTS.filter(p => p.template.includes('{filename}')).length >= 6, 'most templates use {filename}');
  assert.equal(DEFAULT_PROMPTS.find(p => p.id === 'debug')!.template, 'Analyse cette erreur et propose un fix avec explication :\n\n', 'a template may end open, waiting for the user text');
});

test('without prompts.json the library returns the defaults', async t => {
  assert.deepEqual(await new PromptLibrary(await home(t)).list(), DEFAULT_PROMPTS);
});

test('a valid prompts.json replaces the defaults as a whole, and missing icon / description are filled in', async t => {
  const dir = await home(t);
  await writeFile(join(dir, 'prompts.json'), JSON.stringify([
    { id: 'a', name: 'Alpha', icon: '🔧', description: 'Premier', template: 'Fais A sur {filename}' },
    { id: 'b', name: 'Bravo', template: 'Fais B' },
  ]));
  assert.deepEqual(await new PromptLibrary(dir).list(), [
    { id: 'a', name: 'Alpha', icon: '🔧', description: 'Premier', template: 'Fais A sur {filename}' },
    { id: 'b', name: 'Bravo', icon: '📝', description: '', template: 'Fais B' },
  ]);
});

test('an empty list is a valid library (the user removed every prompt), not a reason to fall back', async t => {
  const dir = await home(t);
  await writeFile(join(dir, 'prompts.json'), '[]');
  assert.deepEqual(await new PromptLibrary(dir).list(), []);
});

test('an unreadable or malformed prompts.json falls back on the defaults, never throws', async t => {
  const dir = await home(t);
  const library = new PromptLibrary(dir);
  const bad: Array<[string, string]> = [
    ['not JSON', '{ pas du json'],
    ['not a list', JSON.stringify({ id: 'x' })],
    ['strings in the list (the exact case that crashed the NiceGUI filter)', JSON.stringify(['not', 'a', 'dict'])],
    ['missing template', JSON.stringify([{ id: 'x', name: 'X' }])],
    ['missing name', JSON.stringify([{ id: 'x', template: 't' }])],
    ['missing id', JSON.stringify([{ name: 'X', template: 't' }])],
    ['numeric name (would crash a lower())', JSON.stringify([{ id: 'x', name: 5, template: 't' }])],
    ['non-string description', JSON.stringify([{ id: 'x', name: 'X', template: 't', description: { a: 1 } }])],
    ['non-string icon', JSON.stringify([{ id: 'x', name: 'X', template: 't', icon: 3 }])],
    ['null entry', JSON.stringify([null])],
    ['one bad entry poisons the whole file (all or nothing, like the original)', JSON.stringify([{ id: 'ok', name: 'Ok', template: 't' }, { id: 'x' }])],
  ];
  for (const [label, content] of bad) {
    await writeFile(join(dir, 'prompts.json'), content);
    assert.deepEqual(await library.list(), DEFAULT_PROMPTS, label);
  }
});

test('a prompts.json that is far too large is ignored instead of being loaded in memory', async t => {
  const dir = await home(t);
  await writeFile(join(dir, 'prompts.json'), JSON.stringify([{ id: 'a', name: 'A', template: 'x'.repeat(2_000_000) }]));
  assert.deepEqual(await new PromptLibrary(dir).list(), DEFAULT_PROMPTS);
});

test('the file is read again on each call: a hand edit is seen without restarting', async t => {
  const dir = await home(t);
  const library = new PromptLibrary(dir);
  assert.equal((await library.list()).length, 10);
  await writeFile(join(dir, 'prompts.json'), JSON.stringify([{ id: 'a', name: 'Alpha', template: 't' }]));
  assert.deepEqual((await library.list()).map(p => p.id), ['a']);
  await rm(join(dir, 'prompts.json'));
  assert.equal((await library.list()).length, 10, 'and back to the defaults when it disappears');
});

test('mutating what list() returned never alters the defaults', async t => {
  const library = new PromptLibrary(await home(t));
  const first = await library.list();
  first[0].name = 'PIRATÉ';
  first.pop();
  assert.equal(DEFAULT_PROMPTS[0].name, 'Refactoriser');
  assert.equal((await library.list()).length, 10);
});

test('worker::list-prompts serves the library of its data directory', async t => {
  const dir = await home(t);
  await writeFile(join(dir, 'prompts.json'), JSON.stringify([{ id: 'a', name: 'Alpha', icon: '🔧', description: 'D', template: 'T {filename}' }]));
  const worker = new Worker(fileURLToPath(new URL('../worker.mjs', import.meta.url)), { env: { ...process.env, OPENAGENT_HOME: dir } });
  t.after(() => worker.terminate());
  const call = (op: string) => new Promise<any>((resolve, reject) => {
    const id = `t-${Math.random()}`;
    const listener = (message: any) => {
      if (message.id !== id) return;
      worker.off('message', listener);
      message.ok ? resolve(message.result) : reject(new Error(message.error));
    };
    worker.on('message', listener);
    worker.postMessage({ id, op, payload: {} });
  });
  assert.deepEqual(await call('list-prompts'), [{ id: 'a', name: 'Alpha', icon: '🔧', description: 'D', template: 'T {filename}' }]);
});
