import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

test('indexFolder never indexes a secret file nor one the project ignores, and a rebuild purges them from an older index, backup copy included', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'sort.py'), 'def sort_list(items):\n    return sorted(items)\n');
  await writeFile(join(project, 'secrets.json'), '{"api_key": "SECRET-INDEX-1"}');
  await writeFile(join(project, 'credentials.json'), '{"token": "SECRET-INDEX-2"}');
  await mkdir(join(project, 'private'));
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-INDEX-3');
  await writeFile(join(project, 'draft.md'), 'SECRET-INDEX-4');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  // An index written before 2026-10-05: every one of these files in it.
  const store = await storePath(project);
  await mkdir(dirname(store), { recursive: true });
  const stale = ['secrets.json', 'credentials.json', 'private/notes.md', 'draft.md']
    .map((file, i) => ({ id: `${file}:0`, file, chunk: 0, text: `SECRET-INDEX-${i + 1}`, vector: new Array(384).fill(0) }));
  await writeFile(store, JSON.stringify({ version: 1, entries: stale }));

  const seen: string[] = [];
  await indexFolder(project, home, (_current, _total, file) => seen.push(file), 'private/, draft.md');

  const raw = JSON.parse(await readFile(store, 'utf8'));
  assert.deepEqual([...new Set(raw.entries.map((e: any) => e.file))], ['sort.py']);
  assert.deepEqual(seen, ['sort.py'], 'an excluded file is not even read');
  assert.deepEqual(await readdir(dirname(store)), ['codebase.json'], 'no backup copy keeps the old index');
  assert.equal(JSON.stringify(raw).includes('SECRET-INDEX'), false);
});

test('searchCollection never returns a chunk of a secret or excluded file, even from an index written before the filter existed', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const { searchCollection, storePath } = await import('../core/semantic-index.mts');
  const { embed } = await import('../core/embeddings.mts');
  const { searchExclusion } = await import('../core/file-filter.mts');
  const [vector] = await embed(['trier une liste'], home);
  const entry = (file: string, text: string) => ({ id: `${file}:0`, file, chunk: 0, text, vector });
  const store = await storePath(project);
  await mkdir(dirname(store), { recursive: true });
  await writeFile(store, JSON.stringify({ version: 1, entries: [
    entry('secrets.json', 'SECRET-READ-1'), entry('private/notes.md', 'SECRET-READ-2'), entry('.env.local', 'SECRET-READ-3'),
    entry('sort.py', 'def sort_list(items): return sorted(items)'),
  ] }));
  const byDefault = await searchCollection(store, 'trier une liste', home, 5);
  assert.deepEqual(byDefault.map(r => r.file).sort(), ['private/notes.md', 'sort.py'], 'secret and protected files are hidden whatever the caller passes');
  const withPatterns = await searchCollection(store, 'trier une liste', home, 5, searchExclusion('private/'));
  assert.deepEqual(withPatterns.map(r => r.file), ['sort.py']);
});

test('re-indexing after a file is modified: the search finds the new content and the old one is gone from the store (parity row 30)', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const file = join(project, 'topic.py');
  await writeFile(file, 'def get_weather(city):\n    """Fetches the current weather forecast for a city."""\n    return call_weather_api(city)\n');
  await writeFile(join(project, 'other.py'), 'def add(a, b):\n    return a + b\n');
  const { indexFolder, searchCollection, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  await writeFile(file, 'def sort_list(items):\n    """Sorts a list of items in ascending order."""\n    return sorted(items)\n');
  await indexFolder(project, home);
  const raw = JSON.parse(await readFile(await storePath(project), 'utf8'));
  const stored = raw.entries.filter((e: any) => e.file === 'topic.py').map((e: any) => e.text).join('\n');
  assert.match(stored, /sort_list/);
  assert.equal(stored.includes('get_weather'), false, 'the old content left no chunk behind');
  const [best] = await searchCollection(await storePath(project), 'trier une liste', home, 5);
  assert.equal(best.file, 'topic.py');
  assert.match(best.content, /sort_list/);
});
