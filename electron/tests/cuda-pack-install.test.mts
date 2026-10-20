// The CUDA pack installer (hardware and offload, Task 9). Every test builds a small synthetic pack with writePack
// (fake DLLs under the allowed prefixes, 4 KiB parts) and serves it from a local fake server on 127.0.0.1: no test
// downloads the real pack or touches GitHub, NVIDIA or the network. The manifest is always read from a local file,
// as the app reads its shipped copy; it is never fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUDA_PACK_CORRUPT, writePack, type CudaPackManifest, type PackFile } from '../core/cuda-pack-format.mts';
import {
  CudaPack, CUDA_PACK_MARGIN_BYTES, CUDA_PACK_UNAVAILABLE, cudaPackDiskNotice, cudaPackStalled, cudaPackUnsafeBase, cudaPackUrlRefused, freeBytes,
  releaseBaseUrl, renameWithRetry,
} from '../core/cuda-pack.mts';
import { startFakePackServer } from './support/fake-pack-server.mts';
import { removeAtEnd } from './teardown.mts';

const ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PACKAGE = JSON.parse(await readFile(join(ELECTRON, 'package.json'), 'utf8'));
// The engine version the app runs, read from node-llama-cpp's own package.json, never hard-coded.
const ENGINE: string = JSON.parse(await readFile(join(ELECTRON, 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8')).version;
const OTHER_ENGINE = '3.20.0';

type T = { after(fn: () => unknown): void; diagnostic?(m: string): void };

const FILES: Record<string, Uint8Array | string> = {
  'node_modules/@node-llama-cpp/win-x64-cuda/package.json': '{"name":"@node-llama-cpp/win-x64-cuda"}\n',
  'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll': randomBytes(20_000),
  'cuda-runtime/cublas64_13.dll': randomBytes(10_000),
  'cuda-runtime/LICENSE.txt': 'NVIDIA licence (synthetic).\n',
};

interface Fixture { root: string; home: string; packDir: string; manifestPath: string; manifest: CudaPackManifest; sources: PackFile[] }

/** A synthetic pack in <root>/pack (parts + manifest.json) and an empty data home. */
async function fixture(t: T, version = ENGINE): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'oa-cuda-install-'));
  removeAtEnd(t, root);
  const sources: PackFile[] = [];
  for (const [path, bytes] of Object.entries(FILES)) {
    const source = join(root, 'src', ...path.split('/'));
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, bytes);
    sources.push({ path, source });
  }
  const packDir = join(root, 'pack');
  const manifest = await writePack(sources, packDir, { nodeLlamaCppVersion: version, chunkBytes: 4096 });
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home, packDir, manifestPath: join(packDir, 'manifest.json'), manifest, sources };
}

async function serve(t: T, dir: string, options?: Parameters<typeof startFakePackServer>[1]) {
  const server = await startFakePackServer(dir, options);
  t.after(() => server.close());
  return server;
}

/** What is left in <home>/cuda-pack, sorted (no staging folder may survive anything). */
async function packEntries(home: string): Promise<string[]> {
  try { return (await readdir(join(home, 'cuda-pack'))).sort(); } catch { return []; }
}

test('status before install: absent, with the download and installed sizes of the manifest; no manifest → unavailable', async t => {
  const f = await fixture(t);
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: 'https://example.invalid/', engineVersion: ENGINE });
  assert.deepEqual(await pack.status(), {
    state: 'absent', downloadBytes: f.manifest.downloadBytes, installedBytes: f.manifest.installedBytes, installedVersion: null, expectedVersion: ENGINE,
  });
  assert.ok(f.manifest.parts.length >= 3, 'the synthetic pack spans several parts');
  assert.equal(await pack.installedDir(), null);

  const none = new CudaPack({ dataHome: f.home, manifestPath: join(f.root, 'missing.json'), baseUrl: 'https://example.invalid/', engineVersion: ENGINE });
  assert.deepEqual(await none.status(), { state: 'unavailable', downloadBytes: null, installedBytes: null, installedVersion: null, expectedVersion: ENGINE });
  await assert.rejects(none.install(), { message: CUDA_PACK_UNAVAILABLE });
  // A manifest built for another engine version is not a pack for this app either.
  const other = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: 'https://example.invalid/', engineVersion: OTHER_ENGINE });
  assert.equal((await other.status()).state, 'unavailable');
  await assert.rejects(other.install(), { message: CUDA_PACK_UNAVAILABLE });
});

test('install downloads every part, verifies it, and installs atomically', async t => {
  const f = await fixture(t);
  const server = await serve(t, f.packDir);
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true });
  const progress: Array<[number, number]> = [];
  const status = await pack.install({ onProgress: (received, total) => progress.push([received, total]) });

  assert.deepEqual(progress.at(-1), [f.manifest.downloadBytes, f.manifest.downloadBytes]);
  assert.ok(progress.every(([r], i) => i === 0 || r >= progress[i - 1][0]), 'progress never goes back');
  assert.deepEqual(status, { state: 'installed', downloadBytes: f.manifest.downloadBytes, installedBytes: f.manifest.installedBytes, installedVersion: ENGINE, expectedVersion: ENGINE });
  // Exactly the parts, in order; the manifest is never fetched.
  assert.deepEqual(server.requests, f.manifest.parts.map(p => p.name));
  const current = join(f.home, 'cuda-pack', 'current');
  assert.equal(await pack.installedDir(), current);
  for (const file of f.sources) assert.deepEqual(await readFile(join(current, ...file.path.split('/'))), await readFile(file.source));
  const marker = JSON.parse(await readFile(join(current, 'pack.json'), 'utf8'));
  assert.equal(marker.nodeLlamaCppVersion, ENGINE);
  assert.deepEqual(marker.parts, f.manifest.parts.map(p => p.sha256));
  assert.ok(!Number.isNaN(Date.parse(marker.installedAt)));
  assert.deepEqual(await packEntries(f.home), ['current']);
});

test('a tampered part is refused with CUDA_PACK_CORRUPT, nothing installed, no staging left', async t => {
  const f = await fixture(t);
  const tampered = await serve(t, f.packDir, { tamper: f.manifest.parts[1].name });
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: tampered.url, engineVersion: ENGINE, allowLoopback: true });
  await assert.rejects(pack.install(), { message: CUDA_PACK_CORRUPT });
  assert.equal((await pack.status()).state, 'absent');
  assert.deepEqual(await packEntries(f.home), []);

  // A part whose bytes are a valid pack but whose hash is not the shipped one: only the per-part check sees it.
  const lying = JSON.parse(await readFile(f.manifestPath, 'utf8')) as CudaPackManifest;
  lying.parts.at(-1)!.sha256 = '0'.repeat(64);
  const lyingPath = join(f.root, 'lying-manifest.json');
  await writeFile(lyingPath, JSON.stringify(lying));
  const clean = await serve(t, f.packDir);
  const strict = new CudaPack({ dataHome: f.home, manifestPath: lyingPath, baseUrl: clean.url, engineVersion: ENGINE, allowLoopback: true });
  await assert.rejects(strict.install(), { message: CUDA_PACK_CORRUPT });
  assert.equal((await strict.status()).state, 'absent');
  assert.deepEqual(await packEntries(f.home), []);
});

test('not enough free space: refused before any request with the exact notice', async t => {
  const f = await fixture(t);
  const server = await serve(t, f.packDir);
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true, freeBytes: async () => 1000 });
  await assert.rejects(pack.install(), { message: cudaPackDiskNotice(f.manifest.installedBytes + CUDA_PACK_MARGIN_BYTES, 1000) });
  assert.equal(server.requests.length, 0);
  assert.equal(CUDA_PACK_MARGIN_BYTES, 268_435_456);
  assert.equal(cudaPackDiskNotice(2 ** 30, 300 * 2 ** 20), 'Espace disque insuffisant pour le pack CUDA : il faut 1,0 Gio libres, il en reste 300 Mio.');
  assert.deepEqual(await packEntries(f.home), []);
});

test('cancel mid-download rejects with AbortError, removes the staging folder, status absent', async t => {
  const f = await fixture(t);
  const server = await serve(t, f.packDir, { bytesPerTick: 512 });
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true });
  const controller = new AbortController();
  const seen: { during?: Promise<{ state: string }> } = {};
  const installing = pack.install({
    signal: controller.signal,
    onProgress: () => {
      if (controller.signal.aborted) return;
      seen.during = pack.status();
      controller.abort();
    },
  });
  await assert.rejects(installing, { name: 'AbortError' });
  assert.ok(seen.during, 'onProgress was called');
  assert.equal((await seen.during).state, 'installing');
  assert.equal((await pack.status()).state, 'absent');
  assert.deepEqual(await packEntries(f.home), []);
  assert.ok(server.requests.length < f.manifest.parts.length, 'the download stopped early');
});

test('uninstall removes the pack; a pending removal is finished at the next start', async t => {
  const f = await fixture(t);
  const server = await serve(t, f.packDir);
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true });
  await pack.install();
  const after = await pack.uninstall();
  assert.equal(after.state, 'absent');
  assert.equal(await pack.installedDir(), null);
  assert.deepEqual(await packEntries(f.home), []);

  // What a locked DLL leaves behind: a renamed folder, and a `current` whose marker was already deleted.
  const base = join(f.home, 'cuda-pack');
  await mkdir(join(base, '.remove-pending-x', 'cuda-runtime'), { recursive: true });
  await writeFile(join(base, '.remove-pending-x', 'cuda-runtime', 'cublas64_13.dll'), 'locked');
  await mkdir(join(base, 'current', 'cuda-runtime'), { recursive: true });
  await writeFile(join(base, 'current', 'cuda-runtime', 'cublasLt64_13.dll'), 'locked');
  assert.equal((await pack.status()).state, 'absent', 'no marker: never treated as installed');
  await pack.finishPendingRemoval();
  assert.deepEqual(await packEntries(f.home), []);

  // A complete pack is left alone by the start-up cleanup.
  await pack.install();
  await pack.finishPendingRemoval();
  assert.equal((await pack.status()).state, 'installed');
});

test('an installed pack for another engine version is a mismatch and has no installedDir', async t => {
  assert.notEqual(OTHER_ENGINE, ENGINE);
  const f = await fixture(t, OTHER_ENGINE);
  const server = await serve(t, f.packDir);
  const old = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: OTHER_ENGINE, allowLoopback: true });
  assert.equal((await old.install()).state, 'installed');

  const app = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true });
  const status = await app.status();
  assert.equal(status.state, 'mismatch');
  assert.equal(status.installedVersion, OTHER_ENGINE);
  assert.equal(status.expectedVersion, ENGINE);
  assert.equal(await app.installedDir(), null);
});

test('URLs: https or loopback-for-tests only; redirects followed at most 5 times and never to http', async t => {
  const f = await fixture(t);
  // Loopback http without allowLoopback: refused before any request.
  const server = await serve(t, f.packDir);
  const strict = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE });
  await assert.rejects(strict.install(), { message: cudaPackUrlRefused(server.url + f.manifest.parts[0].name) });
  assert.equal(server.requests.length, 0);

  // A redirect to plain http elsewhere: refused, never requested (example.invalid never resolves anyway).
  const toHttp = await serve(t, f.packDir, { redirectTo: 'http://example.invalid/part' });
  const p1 = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: toHttp.url, engineVersion: ENGINE, allowLoopback: true });
  await assert.rejects(p1.install(), { message: cudaPackUrlRefused('http://example.invalid/part') });
  assert.equal(toHttp.requests.length, 1);

  // A redirect loop: the first request and 5 redirects are followed, the 6th is refused.
  const loop = await serve(t, f.packDir, { redirectTo: '/again' });
  const p2 = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: loop.url, engineVersion: ENGINE, allowLoopback: true });
  await assert.rejects(p2.install(), { message: cudaPackUrlRefused(loop.url + 'again') });
  assert.equal(loop.requests.length, 6);
  assert.deepEqual(await packEntries(f.home), []);

  // The real download source: the app's own GitHub release, from package.json (version read from the file).
  assert.equal(releaseBaseUrl(APP_PACKAGE), `https://github.com/JLSkyzer/openagenticskyzer/releases/download/v${APP_PACKAGE.version}/`);
  assert.throws(() => releaseBaseUrl({ version: '1.0.0', build: { publish: [] } }));
  assert.equal(cudaPackUrlRefused('ftp://x/'), 'Adresse de téléchargement du pack CUDA refusée : ftp://x/');
});

test('freeBytes reads the real disk of a temp folder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'oa-cuda-free-'));
  removeAtEnd(t, root);
  const free = await freeBytes(root);
  assert.ok(Number.isSafeInteger(free) && free > 0, String(free));
});

test('a cuda-pack folder that is a junction is never followed: install and uninstall refuse, the start-up cleanup does nothing', async t => {
  const f = await fixture(t);
  const server = await serve(t, f.packDir);
  // Outside the data home: what a junction at <home>/cuda-pack would expose.
  const outside = join(f.root, 'outside');
  const sentinels = [['current', 'pack.json'], ['current', 'user-file.txt'], ['.staging-x', 'user-file.txt'], ['.remove-pending-y', 'user-file.txt']];
  for (const [dir, name] of sentinels) {
    await mkdir(join(outside, dir), { recursive: true });
    await writeFile(join(outside, dir, name), name === 'pack.json' ? JSON.stringify({ nodeLlamaCppVersion: ENGINE, parts: [], installedAt: '2026-10-20T00:00:00Z' }) : 'keep me');
  }
  const base = join(f.home, 'cuda-pack');
  await symlink(outside, base, 'junction');
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true });

  await assert.rejects(pack.install(), { message: cudaPackUnsafeBase(base) });
  assert.equal(server.requests.length, 0);
  await assert.rejects(pack.uninstall(), { message: cudaPackUnsafeBase(base) });
  await pack.finishPendingRemoval();                 // no throw, nothing removed
  // A marker reached through the junction is never an installed pack.
  assert.equal((await pack.status()).state, 'absent');
  assert.equal(await pack.installedDir(), null);
  for (const [dir, name] of sentinels) assert.ok((await readFile(join(outside, dir, name), 'utf8')).length > 0, `${dir}/${name} survives`);
  assert.deepEqual((await readdir(outside)).sort(), ['.remove-pending-y', '.staging-x', 'current']);

  // A file where the folder should be: refused too.
  const other = join(f.root, 'home2');
  await mkdir(other);
  await writeFile(join(other, 'cuda-pack'), 'not a folder');
  const p2 = new CudaPack({ dataHome: other, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true });
  await assert.rejects(p2.install(), { message: cudaPackUnsafeBase(join(other, 'cuda-pack')) });
  await assert.rejects(p2.uninstall(), { message: cudaPackUnsafeBase(join(other, 'cuda-pack')) });
  await p2.finishPendingRemoval();
  assert.equal(await readFile(join(other, 'cuda-pack'), 'utf8'), 'not a folder');
});

test('a part that stops sending is abandoned after the idle timeout, with a clear error and nothing left', async t => {
  const f = await fixture(t);
  const server = await serve(t, f.packDir, { stallAfter: 1000 });
  const pack = new CudaPack({ dataHome: f.home, manifestPath: f.manifestPath, baseUrl: server.url, engineVersion: ENGINE, allowLoopback: true, idleTimeoutMs: 300 });
  const started = Date.now();
  await assert.rejects(pack.install(), { message: cudaPackStalled(f.manifest.parts[0].name, 300) });
  assert.ok(Date.now() - started < 10_000, 'no hang');
  assert.equal((await pack.status()).state, 'absent');
  assert.deepEqual(await packEntries(f.home), []);
});

test('the final rename retries while Windows holds a freshly written file, then gives up with the error', { skip: process.platform !== 'win32' && 'a held file blocks a folder rename only on Windows' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'oa-cuda-rename-'));
  removeAtEnd(t, root);
  // An open handle inside a folder makes Windows refuse to rename it (EPERM): what an antivirus scan does.
  const from = join(root, 'staging');
  await mkdir(from);
  const held = await open(join(from, 'ggml-cuda.dll'), 'w');
  setTimeout(() => { void held.close(); }, 250);
  await renameWithRetry(from, join(root, 'current'));
  assert.deepEqual(await readdir(root), ['current']);

  // Held for longer than every try: the last error comes back, and nothing moved.
  const from2 = join(root, 'staging2');
  await mkdir(from2);
  const held2 = await open(join(from2, 'ggml-cuda.dll'), 'w');
  try {
    const started = Date.now();
    await assert.rejects(renameWithRetry(from2, join(root, 'current2')), { code: 'EPERM' });
    const spent = Date.now() - started;
    assert.ok(spent >= 1500 && spent < 6000, `bounded retry: ${spent} ms`);
  } finally {
    await held2.close();
  }
  assert.deepEqual((await readdir(root)).sort(), ['current', 'staging2']);
});
