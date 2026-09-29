import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-semindex-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  return { root, home, project };
}

test('indexFolder scans, chunks, embeds real files and writes a real store on disk', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'sort.py'), 'def sort_list(items):\n    return sorted(items)\n');
  await writeFile(join(project, 'README.md'), '# Project\n\nA small demo project.\n');
  await mkdir(join(project, 'node_modules', 'somelib'), { recursive: true });
  await writeFile(join(project, 'node_modules', 'somelib', 'index.js'), 'module.exports = {};');

  const progressCalls: Array<[number, number, string]> = [];
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  const result = await indexFolder(project, home, (current, total, filepath) => progressCalls.push([current, total, filepath]));

  assert.ok(result.chunks >= 2, `expected at least one chunk per real file, got ${result.chunks}`);
  assert.equal(progressCalls.length, 2, 'node_modules must never be scanned, only the 2 real source files');
  assert.ok(progressCalls.every(([, total]) => total === 2));

  const raw = JSON.parse(await readFile(await storePath(project), 'utf8'));
  assert.equal(raw.version, 1);
  const files = new Set(raw.entries.map((e: any) => e.file));
  assert.deepEqual([...files].sort(), ['README.md', 'sort.py']);
  assert.ok(raw.entries.every((e: any) => Array.isArray(e.vector) && e.vector.length === 384));
});

test('searchCollection ranks a real semantically-related chunk above an unrelated one', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'sort.py'), 'def sort_list(items):\n    """Sorts a list of items in ascending order."""\n    return sorted(items)\n');
  await writeFile(join(project, 'weather.py'), 'def get_weather(city):\n    """Fetches the current weather forecast for a city."""\n    return call_weather_api(city)\n');

  const { indexFolder, searchCollection, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  const results = await searchCollection(await storePath(project), 'trier une liste', home, 5);
  assert.ok(results.length >= 2);
  assert.equal(results[0].file, 'sort.py', `expected the sorting file to rank first, got: ${JSON.stringify(results.map(r => r.file))}`);
  assert.ok(results[0].score > results[1].score);
});

test('re-indexing after a file is deleted purges its stale chunks — fixes the leak in the original Python indexer', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const goneFile = join(project, 'gone.py');
  await writeFile(goneFile, 'def temporary(): pass\n');
  await writeFile(join(project, 'stays.py'), 'def permanent(): pass\n');

  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  let raw = JSON.parse(await readFile(await storePath(project), 'utf8'));
  assert.ok(raw.entries.some((e: any) => e.file === 'gone.py'));

  await rm(goneFile);
  await indexFolder(project, home);
  raw = JSON.parse(await readFile(await storePath(project), 'utf8'));
  assert.ok(!raw.entries.some((e: any) => e.file === 'gone.py'), 'the deleted file must leave no stale vectors behind');
  assert.ok(raw.entries.some((e: any) => e.file === 'stays.py'));
});

test('searchCollection on a folder that was never indexed returns an empty list, not an error', async t => {
  const { home, project } = await fixture(t);
  const { searchCollection, storePath } = await import('../core/semantic-index.mts');
  assert.deepEqual(await searchCollection(await storePath(project), 'anything', home, 5), []);
});
