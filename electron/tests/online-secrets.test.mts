// Startup erasure of the online-provider secrets earlier versions left in the data home (spec objective 3).
// Every test runs on its own temporary data home: the real ~/.openagent is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eraseOnlineSecrets } from '../core/online-secrets.mts';

async function dataHome(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-online-secrets-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home };
}

const KEPT = { 'folders.json': '[]', 'gguf-library.json': '[]', 'notes.txt': 'keep' } as const;

async function seed(home: string) {
  await writeFile(join(home, 'connections.v1.json'), 'garbage-vault');
  await writeFile(join(home, 'connections.v1.json.pre-electron.bak'), '{"version":1,"payload":"x"}');
  await writeFile(join(home, 'connections.v1.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp'), '{}');
  await writeFile(join(home, 'config.json'), JSON.stringify({ theme: 'light', current_provider: 'groq', current_model: 'llama', hf_token: 'hf_SECRET', active_local_model: 'abc' }));
  await writeFile(join(home, 'config.json.pre-electron.bak'), JSON.stringify({ hf_token: 'hf_OLD', current_provider: 'mistral', data_dir: '', theme: 'dark' }));
  for (const [name, content] of Object.entries(KEPT)) await writeFile(join(home, name), content);
}

/** Every entry's bytes and mtime, to prove a second run touches nothing. */
async function snapshot(home: string) {
  const entries: Record<string, { bytes: string; mtimeMs: number }> = {};
  for (const name of (await readdir(home)).sort()) {
    entries[name] = { bytes: (await readFile(join(home, name))).toString('base64'), mtimeMs: (await stat(join(home, name))).mtimeMs };
  }
  return entries;
}

test('1. the vault, its backup and its temp files are removed; the provider keys leave config.json and its backup; hf_token and everything else stay', async t => {
  const { home } = await dataHome(t);
  await seed(home);
  const report = await eraseOnlineSecrets(home);
  assert.deepEqual(report.errors, []);
  assert.deepEqual([...report.removed].sort(), ['connections.v1.json', 'connections.v1.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp', 'connections.v1.json.pre-electron.bak']);
  assert.deepEqual(report.cleaned, ['config.json', 'config.json.pre-electron.bak']);
  assert.deepEqual((await readdir(home)).sort(), ['config.json', 'config.json.pre-electron.bak', 'folders.json', 'gguf-library.json', 'notes.txt']);
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(config, { theme: 'light', hf_token: 'hf_SECRET', active_local_model: 'abc' });
  assert.deepEqual(Object.keys(config), ['theme', 'hf_token', 'active_local_model'], 'key order kept');
  const backup = JSON.parse(await readFile(join(home, 'config.json.pre-electron.bak'), 'utf8'));
  assert.deepEqual(backup, { hf_token: 'hf_OLD', data_dir: '', theme: 'dark' });
  assert.deepEqual(Object.keys(backup), ['hf_token', 'data_dir', 'theme'], 'key order kept');
  for (const [name, content] of Object.entries(KEPT)) assert.equal(await readFile(join(home, name), 'utf8'), content, `${name} is byte-equal`);
  for (const name of await readdir(home)) {
    const text = await readFile(join(home, name), 'utf8');
    for (const word of ['groq', 'mistral', 'llama']) assert.equal(text.includes(word), false, `${name} still holds ${word}`);
  }
});

test('2. a second start changes nothing', async t => {
  const { home } = await dataHome(t);
  await seed(home);
  await eraseOnlineSecrets(home);
  const before = await snapshot(home);
  const second = await eraseOnlineSecrets(home);
  assert.deepEqual(second, { removed: [], cleaned: [], errors: [] });
  assert.deepEqual(await snapshot(home), before);
});

test('3. cleaning config.json never creates a backup that holds the keys', async t => {
  const { home } = await dataHome(t);
  await writeFile(join(home, 'config.json'), JSON.stringify({ current_provider: 'groq', current_model: 'llama', hf_token: 'hf_SECRET' }));
  const report = await eraseOnlineSecrets(home);
  assert.deepEqual(report, { removed: [], cleaned: ['config.json'], errors: [] });
  await assert.rejects(stat(join(home, 'config.json.pre-electron.bak')), /ENOENT/);
  assert.deepEqual(await readdir(home), ['config.json'], 'no other copy (backup or temp file) is left');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), { hf_token: 'hf_SECRET' });
});

test('4. an unreadable config.json backup is kept as is and reported; the call resolves', async t => {
  const { home } = await dataHome(t);
  await writeFile(join(home, 'config.json'), JSON.stringify({ current_provider: 'groq', theme: 'dark' }));
  await writeFile(join(home, 'config.json.pre-electron.bak'), '{not json');
  const report = await eraseOnlineSecrets(home);
  assert.equal(await readFile(join(home, 'config.json.pre-electron.bak'), 'utf8'), '{not json', 'bytes unchanged');
  assert.equal(report.errors.length, 1, report.errors.join('\n'));
  assert.match(report.errors[0], /config\.json\.pre-electron\.bak/);
  assert.deepEqual(report.cleaned, ['config.json'], 'the readable config.json is still cleaned');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), { theme: 'dark' });
  await assert.rejects(stat(join(home, 'config.json.pre-electron.bak.pre-electron.bak')), /ENOENT/);
});

test('5. a data home that does not exist is not an error', async t => {
  const { root } = await dataHome(t);
  assert.deepEqual(await eraseOnlineSecrets(join(root, 'absent')), { removed: [], cleaned: [], errors: [] });
});

test('6. a vault that cannot be removed is reported, and removed at the next start', async t => {
  const { home } = await dataHome(t);
  const vault = join(home, 'connections.v1.json');
  await mkdir(vault);
  await writeFile(join(vault, 'inside.txt'), 'x');
  const first = await eraseOnlineSecrets(home);
  assert.equal(first.errors.length, 1, first.errors.join('\n'));
  assert.match(first.errors[0], /connections\.v1\.json/);
  assert.deepEqual(first.removed, []);
  assert.ok((await stat(vault)).isDirectory(), 'the directory is still there');
  await rm(vault, { recursive: true });
  await writeFile(vault, 'garbage-vault');
  const second = await eraseOnlineSecrets(home);
  assert.deepEqual(second, { removed: ['connections.v1.json'], cleaned: [], errors: [] });
  await assert.rejects(stat(vault), /ENOENT/);
});
