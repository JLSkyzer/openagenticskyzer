import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { searchModels, modelVariants, groupVariants, safeModelFileName, HfError, HF_BASE_URL } from '../core/hf-catalogue.mts';
import { startFakeHf } from './support/fake-hf.mts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const H = (c: string) => c.repeat(64);

const listing = (over: Record<string, unknown> = {}) => ({
  _id: 'abc', id: 'owner/name', gated: false, lastModified: '2026-11-01T00:00:00.000Z', likes: 1208, downloads: 6843896,
  gguf: { total: 999, architecture: 'qwen4exp', context_length: 262144, chat_template: '{{ messages }}' },
  tags: ['gguf', 'text-generation'], ...over,
});

async function server(t: { after(fn: () => unknown): void }) {
  const hf = await startFakeHf();
  t.after(() => hf.close());
  return hf;
}

test('the real base URL is huggingface.co', () => {
  assert.equal(HF_BASE_URL, 'https://huggingface.co');
});

test('searchModels asks for gguf with the six expand[] fields and maps the answer', async t => {
  const hf = await server(t);
  hf.setModels([listing()]);
  const models = await searchModels({ baseUrl: hf.baseUrl, query: 'qwen', sort: 'likes', limit: 5 });
  assert.deepEqual(models, [{
    id: 'owner/name', downloads: 6843896, likes: 1208, gated: false, lastModified: '2026-11-01T00:00:00.000Z',
    architecture: 'qwen4exp', contextLength: 262144, chatTemplate: '{{ messages }}', tags: ['gguf', 'text-generation'],
  }]);
  const url = new URL(hf.hits[0].path, 'http://x');
  assert.equal(url.searchParams.get('filter'), 'gguf');
  assert.equal(url.searchParams.get('search'), 'qwen');
  assert.equal(url.searchParams.get('sort'), 'likes');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.deepEqual(url.searchParams.getAll('expand[]').sort(), ['downloads', 'gated', 'gguf', 'lastModified', 'likes', 'tags']);
  assert.equal(hf.hits[0].userAgent, 'openagent');
});

test('a string `gated` ("auto", "manual") counts as gated', async t => {
  const hf = await server(t);
  hf.setModels([listing({ gated: 'auto' }), listing({ id: 'o/b', gated: 'manual' }), listing({ id: 'o/c', gated: false })]);
  const models = await searchModels({ baseUrl: hf.baseUrl });
  assert.deepEqual(models.map(m => m.gated), [true, true, false]);
});

test('gguf.total is never used as a size: the model carries no size at all', async t => {
  const hf = await server(t);
  hf.setModels([listing()]);
  const [model] = await searchModels({ baseUrl: hf.baseUrl });
  assert.ok(!('total' in model) && !('size' in model) && !('sizeBytes' in model));
  assert.ok(!JSON.stringify(model).includes('999'));
});

test('Review Focus 5: odd listings give a partial result or bad-answer, never a TypeError', async t => {
  const hf = await server(t);
  hf.setModels([listing({ id: 'ok/one' }), { id: 'no/gguf' }, null, 'text', 42, { gguf: {} }, listing({ id: 'o/t', tags: 'x', downloads: 'many', gguf: { architecture: 7, context_length: 'big' } })]);
  const models = await searchModels({ baseUrl: hf.baseUrl });
  assert.deepEqual(models.map(m => m.id), ['ok/one', 'o/t']);
  assert.equal(models[1].architecture, null);
  assert.equal(models[1].contextLength, null);
  assert.deepEqual(models[1].tags, []);
  assert.equal(models[1].downloads, 0);

  hf.setModels({ not: 'an array' } as any);
  await assert.rejects(searchModels({ baseUrl: hf.baseUrl }), (e: any) => e instanceof HfError && e.kind === 'bad-answer');
});

test('401 and 403 are `gated`, on the listing and on the tree', async t => {
  const hf = await server(t);
  for (const status of [401, 403]) {
    hf.failApi(status);
    await assert.rejects(searchModels({ baseUrl: hf.baseUrl }), (e: any) => e instanceof HfError && e.kind === 'gated');
    await assert.rejects(modelVariants('o/n', { baseUrl: hf.baseUrl }), (e: any) => e instanceof HfError && e.kind === 'gated');
  }
  hf.failApi(500);
  await assert.rejects(searchModels({ baseUrl: hf.baseUrl }), (e: any) => e instanceof HfError && e.kind === 'offline');
  hf.failApi(404);
  await assert.rejects(searchModels({ baseUrl: hf.baseUrl }), (e: any) => e instanceof HfError && e.kind === 'bad-answer');
});

test('a fetch failure is `offline`', async () => {
  await assert.rejects(searchModels({ baseUrl: 'http://127.0.0.1:1' }), (e: any) => e instanceof HfError && e.kind === 'offline');
  await assert.rejects(modelVariants('o/n', { baseUrl: 'http://127.0.0.1:1' }), (e: any) => e instanceof HfError && e.kind === 'offline');
});

test('a caller abort is not reported as offline', async t => {
  const hf = await server(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchModels({ baseUrl: hf.baseUrl, signal: controller.signal }), (e: any) => !(e instanceof HfError));
});

test('the token goes to the injected host and only to it', async t => {
  const hf = await server(t);
  hf.setModels([]);
  await searchModels({ baseUrl: hf.baseUrl, token: 'tok-test' });
  assert.equal(hf.hits[0].authorization, 'Bearer tok-test');
  await searchModels({ baseUrl: hf.baseUrl });
  assert.equal(hf.hits[1].authorization, undefined);
});

test('modelVariants reads sizes and SHA-256 from the tree, not from the listing', async t => {
  const hf = await server(t);
  const a = Buffer.from('aaaa'), b = Buffer.from('bbbbbb');
  hf.setFile('o/n/m-Q4_K_M.gguf', a);
  hf.setFile('o/n/m-Q8_0.gguf', b);
  hf.setFile('o/n/README.md', Buffer.from('x')); // not a model
  hf.setFile('o/n/mmproj-f16.gguf', Buffer.from('v')); // vision projector, excluded
  const variants = await modelVariants('o/n', { baseUrl: hf.baseUrl });
  assert.deepEqual(variants, [
    { name: 'm-Q4_K_M', files: [{ path: 'm-Q4_K_M.gguf', size: 4, sha256: sha(a) }], totalBytes: 4 },
    { name: 'm-Q8_0', files: [{ path: 'm-Q8_0.gguf', size: 6, sha256: sha(b) }], totalBytes: 6 },
  ]);
  const url = new URL(hf.hits[0].path, 'http://x');
  assert.equal(url.pathname, '/api/models/o/n/tree/main');
  assert.equal(url.searchParams.get('recursive'), 'true');
});

test('modelVariants refuses an identifier that is not owner/name', async () => {
  await assert.rejects(modelVariants('../etc/passwd', { baseUrl: 'http://127.0.0.1:1' }), (e: any) => e instanceof HfError && e.kind === 'bad-answer');
});

test('groupVariants: split files make one variant, sizes summed, three hashes, sorted by part', () => {
  const entry = (n: number, size: number, oid: string) => ({ type: 'file', oid: 'x', size: 130, path: `x-0000${n}-of-00003.gguf`, lfs: { oid, size, pointerSize: 136 } });
  const [variant, ...rest] = groupVariants([entry(3, 30, H('c')), entry(1, 10, H('a')), entry(2, 20, H('b'))]);
  assert.equal(rest.length, 0);
  assert.equal(variant.name, 'x');
  assert.deepEqual(variant.files.map(f => f.path), ['x-00001-of-00003.gguf', 'x-00002-of-00003.gguf', 'x-00003-of-00003.gguf']);
  assert.deepEqual(variant.files.map(f => f.sha256), [H('a'), H('b'), H('c')]);
  assert.deepEqual(variant.files.map(f => f.size), [10, 20, 30]);
  assert.equal(variant.totalBytes, 60);
});

test('groupVariants: an incomplete set of parts is not offered', () => {
  const e = (n: number) => ({ type: 'file', size: 5, path: `x-0000${n}-of-00003.gguf`, lfs: { oid: H('a'), size: 5 } });
  assert.deepEqual(groupVariants([e(1), e(3)]), []);
});

test('groupVariants excludes any path containing mmproj', () => {
  const out = groupVariants([
    { type: 'file', size: 1, path: 'mmproj-F16.gguf', lfs: { oid: H('a'), size: 1 } },
    { type: 'file', size: 1, path: 'sub/MMProj.gguf', lfs: { oid: H('a'), size: 1 } },
    { type: 'file', size: 2, path: 'ok.gguf', lfs: { oid: H('b'), size: 2 } },
  ]);
  assert.deepEqual(out.map(v => v.name), ['ok']);
});

test('groupVariants: a non-LFS .gguf gets sha256 null, size from `size`', () => {
  const [v] = groupVariants([{ type: 'file', size: 77, path: 'plain.gguf' }]);
  assert.deepEqual(v.files, [{ path: 'plain.gguf', size: 77, sha256: null }]);
  assert.equal(v.totalBytes, 77);
});

test('groupVariants ignores directories, other files and a malformed oid', () => {
  const out = groupVariants([
    { type: 'directory', path: 'dir.gguf' },
    { type: 'file', size: 3, path: 'notes.txt' },
    { type: 'file', size: 4, path: 'm.gguf', lfs: { oid: 'not-a-hash', size: 4 } },
  ]);
  assert.deepEqual(out, [{ name: 'm', files: [{ path: 'm.gguf', size: 4, sha256: null }], totalBytes: 4 }]);
});

test('Review Focus 5: groupVariants never throws a TypeError on odd entries', () => {
  assert.throws(() => groupVariants({} as any), (e: any) => e instanceof HfError && e.kind === 'bad-answer');
  assert.throws(() => groupVariants(null), (e: any) => e instanceof HfError && e.kind === 'bad-answer');
  const out = groupVariants([null, 'x', 5, {}, { type: 'file' }, { path: 42 }, { type: 'file', path: 'a.gguf' }, { type: 'file', path: 'b.gguf', size: 'big' }, { path: 'c.gguf', size: 9, lfs: null }]);
  assert.deepEqual(out.map(v => v.name), ['c']);
});

test('safeModelFileName keeps a clean base name', () => {
  assert.equal(safeModelFileName('model-Q4_K_M.gguf'), 'model-Q4_K_M.gguf');
  assert.equal(safeModelFileName('sub/dir/model.GGUF'), 'model.GGUF');
});

test('safeModelFileName refuses traversal, reserved names, separators and non-gguf', () => {
  for (const bad of ['../../evil.gguf', '..', '', '.gguf', 'dir/', 'CON.gguf', 'con.gguf', 'NUL.tar.gguf', 'COM1.gguf', 'lpt9.gguf', 'a:b.gguf', 'a.gguf:stream', 'x.gguf.', 'x.gguf ', 'model.bin', 'model.gguf.exe', 'a\u0000b.gguf', '..\\evil.gguf']) {
    assert.throws(() => safeModelFileName(bad), /Nom de fichier refusé/, JSON.stringify(bad));
  }
  assert.throws(() => safeModelFileName(undefined as any), /Nom de fichier refusé/);
});

// --- the fake server itself: Task 4 depends on its redirects, ranges and cuts ---

test('fake-hf: /resolve answers 307 to a relative same-origin URL, then serves the bytes with Range', async t => {
  const hf = await server(t);
  const bytes = Buffer.from('0123456789');
  hf.setFile('o/n/m.gguf', bytes);
  const first = await fetch(`${hf.baseUrl}/o/n/resolve/main/m.gguf`, { redirect: 'manual' });
  assert.equal(first.status, 307);
  assert.match(first.headers.get('location')!, /^\/api\/resolve-cache\//);
  const whole = await fetch(`${hf.baseUrl}/o/n/resolve/main/m.gguf`);
  assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), '0123456789');
  const part = await fetch(`${hf.baseUrl}/o/n/resolve/main/m.gguf`, { headers: { Range: 'bytes=4-' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 4-9/10');
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '456789');
});

test('fake-hf: a redirect to a second port, and ranges switched off', async t => {
  const hf = await server(t);
  hf.setFile('o/n/m.gguf', Buffer.from('0123456789'), { redirect: 'other-port', ranges: false });
  const first = await fetch(`${hf.baseUrl}/o/n/resolve/main/m.gguf`, { redirect: 'manual' });
  assert.equal(first.status, 307);
  const location = new URL(first.headers.get('location')!);
  assert.notEqual(location.port, new URL(hf.baseUrl).port);
  const res = await fetch(`${hf.baseUrl}/o/n/resolve/main/m.gguf`, { headers: { Range: 'bytes=4-' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), null);
  assert.equal((await res.arrayBuffer()).byteLength, 10);
});

test('fake-hf: a mid-stream cut happens once, then the file is served whole', async t => {
  const hf = await server(t);
  hf.setFile('o/n/m.gguf', Buffer.alloc(1000, 7), { cutAfter: 100 });
  await assert.rejects(async () => { await (await fetch(`${hf.baseUrl}/o/n/resolve/main/m.gguf`)).arrayBuffer(); });
  const again = await fetch(`${hf.baseUrl}/o/n/resolve/main/m.gguf`);
  assert.equal((await again.arrayBuffer()).byteLength, 1000);
});

test('fake-hf: 401/403 on a file, and a listed oid that does not match the bytes', async t => {
  const hf = await server(t);
  hf.setFile('o/n/a.gguf', Buffer.from('x'), { status: 403 });
  hf.setFile('o/n/b.gguf', Buffer.from('x'), { sha256: H('f') });
  assert.equal((await fetch(`${hf.baseUrl}/o/n/resolve/main/a.gguf`, { redirect: 'manual' })).status, 403);
  const variants = await modelVariants('o/n', { baseUrl: hf.baseUrl });
  assert.equal(variants.find(v => v.name === 'b')!.files[0].sha256, H('f'));
});
