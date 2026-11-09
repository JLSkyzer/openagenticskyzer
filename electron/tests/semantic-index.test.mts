import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, rename } from 'node:fs/promises';
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
  assert.equal(raw.version, 2);
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
  assert.deepEqual((await readdir(dirname(store))).sort(), ['.gitignore', 'codebase.json'], 'no backup copy keeps the old index');
  assert.equal(JSON.stringify(raw).includes('SECRET-INDEX'), false);
});

test('searchCollection never returns a chunk of a secret or excluded file, even from an index written before the filter existed', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const { searchCollection, storePath } = await import('../core/semantic-index.mts');
  const { embed } = await import('../core/embeddings.mts');
  const { searchExclusion } = await import('../core/file-filter.mts');
  const [vector] = await embed(['trier une liste']);
  const entry = (file: string, text: string) => ({ id: `${file}:0`, file, chunk: 0, text, vector });
  const store = await storePath(project);
  await mkdir(dirname(store), { recursive: true });
  await writeFile(store, JSON.stringify({ version: 2, entries: [
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

test('a version-1 index is never searched (old and new vectors never mix); the next indexFolder writes version 2', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'a.md'), 'tri');
  const { indexFolder, searchCollection, storePath, INDEX_VERSION } = await import('../core/semantic-index.mts');
  assert.equal(INDEX_VERSION, 2);
  const path = await storePath(project);
  await mkdir(dirname(path), { recursive: true });
  const unit384 = [1, ...new Array(383).fill(0)];
  await writeFile(path, JSON.stringify({ version: 1, entries: [{ id: 'a.md:0', file: 'a.md', chunk: 0, text: 'tri', vector: unit384 }] }));
  assert.deepEqual(await searchCollection(path, 'tri', home), []);
  await indexFolder(project, home);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
  assert.equal((await searchCollection(path, 'tri', home))[0]?.file, 'a.md', 'the rebuilt index is searched');
});

test('indexing a committed git project leaves `git status` clean: the index directory ignores itself with a `*` .gitignore', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const { execFileSync } = await import('node:child_process');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: project, encoding: 'utf8' });
  git('init', '-q');
  await writeFile(join(project, 'sort.py'), 'def sort_list(items):\n    return sorted(items)\n');
  git('add', 'sort.py');
  git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  assert.equal(git('status', '--porcelain'), '', 'no ?? .openagent/ after indexing');
  assert.equal(git('status', '--porcelain', '-uall'), '', 'not even one file under .openagent/index/');
  const ignore = join(dirname(await storePath(project)), '.gitignore');
  assert.equal(await readFile(ignore, 'utf8'), '*\n');
  assert.deepEqual((await readdir(join(project, '.openagent'))).sort(), ['index'], 'nothing else is written under .openagent/');
});

test('a second index run leaves an existing .gitignore of the index directory untouched', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'a.md'), 'tri');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  const ignore = join(dirname(await storePath(project)), '.gitignore');
  await mkdir(dirname(ignore), { recursive: true });
  await writeFile(ignore, '# the user\'s own\ncodebase.json\n');
  await indexFolder(project, home);
  assert.equal(await readFile(ignore, 'utf8'), '# the user\'s own\ncodebase.json\n');
  await rm(ignore);
  await indexFolder(project, home);
  await indexFolder(project, home);
  assert.equal(await readFile(ignore, 'utf8'), '*\n', 'written once, then kept as is');
});

test('the .gitignore is in place BEFORE the index is written: git never sees the index directory, even mid-write', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'a.md'), 'tri');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  const store = await storePath(project);
  // A directory in the store's place makes the store write fail: whatever exists at that point was written before it.
  await mkdir(store, { recursive: true });
  await assert.rejects(indexFolder(project, home));
  assert.equal(await readFile(join(dirname(store), '.gitignore'), 'utf8'), '*\n', 'written before the store, not after');
});
// Task 13: the index is updated file by file. Each file's stamp ({size, mtimeMs}) is kept in the store; an unchanged
// file keeps its entries without being embedded again.
const storeOf = async (project: string) => {
  const { storePath } = await import('../core/semantic-index.mts');
  return JSON.parse(await readFile(await storePath(project), 'utf8'));
};

test('an unchanged file keeps its vectors without embedding again; a changed file is re-embedded; a removed one is dropped', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'a.py'), 'def sort_list(items):\n    return sorted(items)\n');
  await writeFile(join(project, 'b.py'), 'def get_weather(city):\n    return call_weather_api(city)\n');
  await writeFile(join(project, 'c.md'), '# Notes\n\nTemporary notes.\n');
  const { indexFolder } = await import('../core/semantic-index.mts');
  const first = await indexFolder(project, home);
  assert.deepEqual([first.embeddedFiles, first.reusedFiles], [3, 0]);
  const before = await storeOf(project);
  assert.deepEqual(Object.keys(before.files).sort(), ['a.py', 'b.py', 'c.md']);

  await writeFile(join(project, 'b.py'), 'def add(a, b):\n    """Adds two numbers."""\n    return a + b\n');
  await rm(join(project, 'c.md'));
  const second = await indexFolder(project, home);
  assert.deepEqual([second.embeddedFiles, second.reusedFiles], [1, 1]);
  const after = await storeOf(project);
  assert.deepEqual(Object.keys(after.files).sort(), ['a.py', 'b.py']);
  assert.deepEqual([...new Set(after.entries.map((e: any) => e.file))], ['a.py', 'b.py'], 'the removed file left no entry');
  const vectorsOf = (store: any, file: string) => store.entries.filter((e: any) => e.file === file).map((e: any) => e.vector);
  assert.deepEqual(vectorsOf(after, 'a.py'), vectorsOf(before, 'a.py'), 'the unchanged file kept its very vectors');
  assert.match(after.entries.filter((e: any) => e.file === 'b.py').map((e: any) => e.text).join(''), /Adds two numbers/);
  assert.equal(second.chunks, after.entries.length);
});

test('an incremental update equals a full rebuild', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  const long = (topic: string) => Array.from({ length: 30 }, (_, i) => `${topic} ligne ${i} : une phrase assez longue pour remplir le morceau.`).join('\n');
  await writeFile(join(project, 'a.md'), long('le tri des listes'));
  await writeFile(join(project, 'b.md'), long('la météo de Paris'));
  await writeFile(join(project, 'c.md'), long('la base de données'));
  await writeFile(join(project, 'd.py'), 'def gone():\n    pass\n');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  await writeFile(join(project, 'b.md'), long('les réseaux de neurones'));
  await rm(join(project, 'd.py'));
  await writeFile(join(project, 'e.txt'), long('un nouveau fichier'));
  const incremental = await indexFolder(project, home);
  assert.deepEqual([incremental.embeddedFiles, incremental.reusedFiles], [2, 2]);
  const updated = await storeOf(project);

  await rm(await storePath(project));
  const full = await indexFolder(project, home);
  assert.deepEqual([full.embeddedFiles, full.reusedFiles], [4, 0]);
  const rebuilt = await storeOf(project);

  assert.deepEqual(updated.entries.map((e: any) => [e.id, e.file, e.chunk, e.text]), rebuilt.entries.map((e: any) => [e.id, e.file, e.chunk, e.text]));
  assert.deepEqual(Object.keys(updated.files).sort(), Object.keys(rebuilt.files).sort());
  assert.deepEqual(updated.files, rebuilt.files, 'the same stamps');
  // Not an exact equality: a quantized vector shifts slightly with the batch it was embedded in (lesson 2026-10-17).
  const { cosineSimilarity } = await import('../core/semantic-chunk.mts');
  updated.entries.forEach((entry: any, i: number) => {
    const cosine = cosineSimilarity(entry.vector, rebuilt.entries[i].vector);
    assert.ok(cosine >= 0.98, `${entry.id}: cosine ${cosine}`);
  });
});

test('an index without file stamps is rebuilt fully', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'a.py'), 'def sort_list(items):\n    return sorted(items)\n');
  await writeFile(join(project, 'b.md'), '# Project\n\nA small demo project.\n');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  const { files, ...withoutStamps } = await storeOf(project);
  assert.ok(files, 'the first run wrote the stamps');
  await writeFile(await storePath(project), JSON.stringify(withoutStamps));
  const result = await indexFolder(project, home);
  assert.deepEqual([result.embeddedFiles, result.reusedFiles], [2, 0]);
  assert.deepEqual(Object.keys((await storeOf(project)).files).sort(), ['a.py', 'b.md'], 'the rebuild writes the stamps');
});

test('an index with stamps but of another format version is rebuilt fully: its vectors are never mixed with new ones', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'a.py'), 'def sort_list(items):\n    return sorted(items)\n');
  await writeFile(join(project, 'b.md'), '# Project\n\nA small demo project.\n');
  const { indexFolder, storePath, INDEX_VERSION } = await import('../core/semantic-index.mts');
  await indexFolder(project, home);
  const stamped = await storeOf(project);
  assert.ok(stamped.files, 'the older index does hold its stamps');
  await writeFile(await storePath(project), JSON.stringify({ ...stamped, version: INDEX_VERSION - 1 }));
  const result = await indexFolder(project, home);
  assert.deepEqual([result.embeddedFiles, result.reusedFiles], [2, 0]);
  assert.equal((await storeOf(project)).version, INDEX_VERSION);
});

test('a stamped file that becomes ignored or secret leaves nothing behind in the next update', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  await writeFile(join(project, 'keep.py'), 'def sort_list(items):\n    return sorted(items)\n');
  await writeFile(join(project, 'draft.md'), 'STAMPED-TEXT-IGNORED');
  await writeFile(join(project, 'config.json'), '{"note": "STAMPED-TEXT-SECRET"}');
  const { indexFolder, storePath } = await import('../core/semantic-index.mts');
  const first = await indexFolder(project, home);
  assert.equal(first.embeddedFiles, 3);
  assert.match(await readFile(await storePath(project), 'utf8'), /STAMPED-TEXT-SECRET/, 'both texts were indexed first');

  await rename(join(project, 'config.json'), join(project, 'secrets.json'));
  const second = await indexFolder(project, home, undefined, 'draft.md');
  assert.deepEqual([second.embeddedFiles, second.reusedFiles], [0, 1]);
  const raw = await readFile(await storePath(project), 'utf8');
  assert.equal(raw.includes('STAMPED-TEXT'), false, 'neither text survives in the store');
  assert.deepEqual(Object.keys(JSON.parse(raw).files), ['keep.py']);
});

test('indexFolder waits at the gate between files and resumes', { timeout: 60000 }, async t => {
  const { home, project } = await fixture(t);
  for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(join(project, name), `le fichier ${name}`);
  const { indexFolder } = await import('../core/semantic-index.mts');
  const { IndexGate } = await import('../core/index-gate.mts');
  const gate = new IndexGate();
  const resume = gate.pause();
  assert.equal(gate.paused, true);
  const progress: number[] = [];
  const run = indexFolder(project, home, current => progress.push(current), '', { gate });
  // Without the gate, the first progress is posted as soon as the 3 files are listed (a few milliseconds).
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.deepEqual(progress, [], 'nothing starts while the gate is paused');
  resume();
  resume(); // idempotent: the count never goes below 0
  assert.equal(gate.paused, false);
  const result = await run;
  assert.deepEqual(progress, [1, 2, 3]);
  assert.equal(result.embeddedFiles, 3);
});
