// The CUDA pack format (hardware and offload, Task 8): a deterministic gzip record stream cut into parts under
// 2 GiB, a manifest of part hashes, and an allow-list of paths on extraction. Every input is a small synthetic
// file in a mkdtemp folder: no real NVIDIA DLL, no download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  CUDA_PACK_CHUNK_BYTES, CUDA_PACK_CORRUPT, CUDA_PACK_FORMAT, cudaPackUnsafePath, cudaPackUnsafeTarget, extractPack,
  partName, safePackPath, writePack, type PackFile,
} from '../core/cuda-pack-format.mts';
import { collectPackFiles, DEFAULT_RUNTIME_PLACEMENT } from '../scripts/cuda-pack.mts';
import { removeAtEnd } from './teardown.mts';

const ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function tempRoot(t: { after(fn: () => unknown): void; diagnostic?(m: string): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oa-cuda-pack-'));
  removeAtEnd(t, root);
  return root;
}

/** Writes `files` (pack path → bytes) under `root/src`, and returns them as PackFile entries. */
async function sources(root: string, files: Record<string, Uint8Array | string>): Promise<PackFile[]> {
  const out: PackFile[] = [];
  for (const [path, bytes] of Object.entries(files)) {
    const source = join(root, 'src', ...path.split('/'));
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, bytes);
    out.push({ path, source });
  }
  return out;
}

/** The parts of a written pack, in order, as one byte stream (what Task 9 pipes from the download). */
async function* partsStream(outDir: string, version: string, count: number): AsyncIterable<Uint8Array> {
  for (let index = 1; index <= count; index++) yield await readFile(join(outDir, partName(version, index)));
}

/**
 * A raw writer for tests only, written from the format text rather than from writePack: writePack refuses hostile
 * paths itself, so this is the only way to hand the extractor a pack that carries them (controller ruling F9).
 */
function rawPack(entries: Array<{ path: string; bytes: Uint8Array }>): AsyncIterable<Uint8Array> {
  const records: Buffer[] = [];
  for (const { path, bytes } of entries) {
    const header = Buffer.from(JSON.stringify({ path, size: bytes.length, sha256: sha256(bytes) }));
    const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    records.push(length, header, Buffer.from(bytes));
  }
  records.push(Buffer.alloc(4));
  const gz = gzipSync(Buffer.concat(records), { level: 9 });
  return (async function* () { yield gz; })();
}

const FILES = {
  'node_modules/@node-llama-cpp/win-x64-cuda/package.json': '{"name":"@node-llama-cpp/win-x64-cuda","version":"3.21.1"}\n',
  'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll': randomBytes(3000),
  'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/empty.json': '',
  'cuda-runtime/cublas64_13.dll': randomBytes(1500),
  'cuda-runtime/LICENSE.txt': 'NVIDIA licence, with the Volkov BSD notice.\n',
};

test('writePack then extractPack restores every file byte for byte, and the manifest counts them', async t => {
  const root = await tempRoot(t);
  const files = await sources(root, FILES);
  const outDir = join(root, 'out');
  const manifest = await writePack(files, outDir, { nodeLlamaCppVersion: '3.21.1' });

  assert.equal(CUDA_PACK_FORMAT, 1);
  assert.equal(manifest.format, 1);
  assert.equal(manifest.nodeLlamaCppVersion, '3.21.1');
  assert.equal(manifest.platform, 'win-x64');
  assert.equal(manifest.files, 5);
  const installed = Object.values(FILES).reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0);
  assert.equal(manifest.installedBytes, installed);
  assert.equal(manifest.parts.length, 1);
  assert.equal(manifest.parts[0].name, 'openagent-cuda-pack-3.21.1-win-x64.part1');
  assert.equal(partName('3.21.1', 2), 'openagent-cuda-pack-3.21.1-win-x64.part2');
  assert.equal(manifest.downloadBytes, manifest.parts[0].size);
  // manifest.json is the returned manifest, 2-space JSON with a trailing newline.
  assert.equal(await readFile(join(outDir, 'manifest.json'), 'utf8'), JSON.stringify(manifest, null, 2) + '\n');
  assert.deepEqual((await readdir(outDir)).sort(), ['manifest.json', 'openagent-cuda-pack-3.21.1-win-x64.part1']);

  const dest = join(root, 'dest');
  const result = await extractPack(partsStream(outDir, '3.21.1', 1), dest);
  assert.deepEqual(result, { files: 5, bytes: installed });
  for (const [path, bytes] of Object.entries(FILES)) {
    assert.deepEqual(await readFile(join(dest, ...path.split('/'))), Buffer.from(bytes), path);
  }

  // A tampered byte inside the gzip stream, or a truncated stream, is refused as corrupt and leaves nothing.
  const part = await readFile(join(outDir, manifest.parts[0].name));
  const tampered = Buffer.from(part); tampered[Math.floor(part.length / 2)] ^= 0xff;
  const dest2 = join(root, 'dest2'); await mkdir(dest2);
  await assert.rejects(extractPack((async function* () { yield tampered; })(), dest2), { message: CUDA_PACK_CORRUPT });
  assert.deepEqual(await readdir(dest2), []);
  await assert.rejects(extractPack((async function* () { yield part.subarray(0, part.length - 40); })(), dest2), { message: CUDA_PACK_CORRUPT });
  assert.deepEqual(await readdir(dest2), []);
  // A header whose hash does not match the bytes: the file is refused and removed.
  const lying = Buffer.alloc(4); lying.writeUInt32BE(0);
  const header = Buffer.from(JSON.stringify({ path: 'cuda-runtime/a.dll', size: 3, sha256: sha256(Buffer.from('xyz')) }));
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  const bad = gzipSync(Buffer.concat([len, header, Buffer.from('abc'), lying]));
  await assert.rejects(extractPack((async function* () { yield bad; })(), dest2), { message: CUDA_PACK_CORRUPT });
  assert.deepEqual(await readdir(dest2), []);
});

test('two builds of the same files are byte-identical, manifest included', async t => {
  const root = await tempRoot(t);
  const files = await sources(root, FILES);
  // Given in another order the second time: the pack sorts by path itself.
  const a = await writePack(files, join(root, 'a'), { nodeLlamaCppVersion: '3.21.1', chunkBytes: 2048 });
  const b = await writePack([...files].reverse(), join(root, 'b'), { nodeLlamaCppVersion: '3.21.1', chunkBytes: 2048 });
  assert.deepEqual(a, b);
  const names = (await readdir(join(root, 'a'))).sort();
  assert.deepEqual((await readdir(join(root, 'b'))).sort(), names);
  assert.ok(names.length >= 3);
  for (const name of names) assert.deepEqual(await readFile(join(root, 'a', name)), await readFile(join(root, 'b', name)), name);
  // The gzip header carries mtime 0 (bytes 4–7) and level 9's XFL 2, with a fixed OS byte.
  const first = await readFile(join(root, 'a', a.parts[0].name));
  assert.deepEqual([...first.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
});

test('parts are cut at chunkBytes, each part hash is in the manifest, and CUDA_PACK_CHUNK_BYTES is under 2 GiB', async t => {
  assert.equal(CUDA_PACK_CHUNK_BYTES, 1_900_000_000);
  assert.ok(CUDA_PACK_CHUNK_BYTES < 2 ** 31);
  const root = await tempRoot(t);
  const files = await sources(root, { 'cuda-runtime/noise.dll': randomBytes(5000) });
  const outDir = join(root, 'out');
  const manifest = await writePack(files, outDir, { nodeLlamaCppVersion: '3.21.1', chunkBytes: 1000 });
  assert.ok(manifest.parts.length >= 3, `parts: ${manifest.parts.length}`);
  let total = 0;
  for (const [i, part] of manifest.parts.entries()) {
    assert.equal(part.name, partName('3.21.1', i + 1));
    const bytes = await readFile(join(outDir, part.name));
    if (i < manifest.parts.length - 1) assert.equal(bytes.length, 1000, part.name);
    else assert.ok(bytes.length > 0 && bytes.length <= 1000);
    assert.equal(part.size, bytes.length);
    assert.equal(part.sha256, sha256(bytes));
    total += bytes.length;
  }
  assert.equal(manifest.downloadBytes, total);
  const dest = join(root, 'dest');
  assert.deepEqual(await extractPack(partsStream(outDir, '3.21.1', manifest.parts.length), dest), { files: 1, bytes: 5000 });

  // A rebuild into the same folder with fewer parts leaves no stale part behind.
  const again = await writePack(files, outDir, { nodeLlamaCppVersion: '3.21.1', chunkBytes: 1_000_000 });
  assert.deepEqual((await readdir(outDir)).sort(), ['manifest.json', again.parts[0].name]);
});

test('extractPack refuses a path outside the allowed prefixes before writing anything', async t => {
  const root = await tempRoot(t);
  const ok = { path: 'cuda-runtime/ok.dll', bytes: Buffer.from('ok') };
  const hostile = [
    '../evil.dll', 'C:/evil.dll', 'C:\\evil.dll', 'c:evil.dll', '\\\\server\\share\\evil.dll', '//server/share/evil.dll',
    '/abs/evil.dll', 'node_modules/other/x.dll', 'cuda-runtime/../../x', 'cuda-runtime/./x.dll', 'cuda-runtime//x.dll',
    'cuda-runtime/', 'cuda-runtime', '', 'cuda-runtime\\x.dll', 'cuda-runtime/x.dll:evil', 'cuda-runtime/x.dll::$DATA',
    'cuda-runtime/CON', 'cuda-runtime/nul.txt', 'cuda-runtime/Com1.dll', 'cuda-runtime/LPT9', 'Cuda-Runtime/x.dll',
    'CUDA-RUNTIME/x.dll', 'cuda-runtime/x.dll.', 'cuda-runtime/x.dll ', 'cuda-runtime/CUDA-R~1', 'cuda-runtime/a\0.dll',
    'node_modules/@node-llama-cpp/win-x64-cuda/../../../evil.dll', 'node_modules/@node-llama-cpp/win-x64-cuda-ext/x.dll',
  ];
  for (const path of hostile) {
    assert.throws(() => safePackPath(path), { message: cudaPackUnsafePath(path) }, JSON.stringify(path));
    // writePack refuses it too, before writing any part.
    const outDir = join(root, 'w', String(hostile.indexOf(path)));
    await assert.rejects(writePack([{ path, source: join(root, 'missing') }], outDir, { nodeLlamaCppVersion: '3.21.1' }),
      { message: cudaPackUnsafePath(path) });
    // The extractor refuses the raw pack, with a valid file around it, and leaves the destination empty.
    const dest = await mkdtemp(join(root, 'd-'));
    await assert.rejects(extractPack(rawPack([ok, { path, bytes: Buffer.from('evil') }]), dest), { message: cudaPackUnsafePath(path) },
      JSON.stringify(path));
    assert.deepEqual(await readdir(dest), [], JSON.stringify(path));
  }
  assert.equal(safePackPath('node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/llama.cuda.v0.4.0.dll'),
    'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/llama.cuda.v0.4.0.dll');

  // Case tricks: two paths that name one file on Windows are refused, the second one named.
  const dupes = [{ path: 'cuda-runtime/A.dll', bytes: Buffer.from('1') }, { path: 'cuda-runtime/a.dll', bytes: Buffer.from('2') }];
  const destCase = await mkdtemp(join(root, 'd-'));
  await assert.rejects(extractPack(rawPack(dupes), destCase), { message: cudaPackUnsafePath('cuda-runtime/a.dll') });
  assert.deepEqual(await readdir(destCase), []);
  const caseFiles = await sources(join(root, 'case'), { 'cuda-runtime/B.dll': '1' });
  caseFiles.push({ path: 'cuda-runtime/b.dll', source: caseFiles[0].source });
  await assert.rejects(writePack(caseFiles, join(root, 'wcase'), { nodeLlamaCppVersion: '3.21.1' }), { message: cudaPackUnsafePath('cuda-runtime/b.dll') });

  // A junction already in the target is never followed: a non-empty target, or a target that is itself a link, is refused.
  const outside = join(root, 'outside'); await mkdir(outside);
  const withLink = await mkdtemp(join(root, 'd-'));
  await symlink(outside, join(withLink, 'cuda-runtime'), 'junction');
  await assert.rejects(extractPack(rawPack([ok]), withLink), { message: cudaPackUnsafeTarget(withLink) });
  const linkTarget = join(root, 'link-dest');
  await symlink(outside, linkTarget, 'junction');
  await assert.rejects(extractPack(rawPack([ok]), linkTarget), { message: cudaPackUnsafeTarget(linkTarget) });
  assert.deepEqual(await readdir(outside), []);
});

test('collectPackFiles takes the CUDA package (not -ext, D-CUDA-3), the runtime DLLs and the NVIDIA licence, and refuses a package of another engine version', async t => {
  const root = await tempRoot(t);
  const nm = join(root, 'node_modules');
  const put = async (path: string, text: string) => { await mkdir(dirname(join(nm, path)), { recursive: true }); await writeFile(join(nm, path), text); };
  await put('node-llama-cpp/package.json', '{"name":"node-llama-cpp","version":"3.21.1"}');
  await put('@node-llama-cpp/win-x64-cuda/package.json', '{"name":"@node-llama-cpp/win-x64-cuda","version":"3.21.1"}');
  await put('@node-llama-cpp/win-x64-cuda/dist/index.js', 'export {};\n');
  await put('@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll', 'cuda build');
  // D-CUDA-3: the CUDA 12 fallback package is present in node_modules but never packed.
  await put('@node-llama-cpp/win-x64-cuda-ext/package.json', '{"name":"@node-llama-cpp/win-x64-cuda-ext","version":"3.21.1"}');
  await put('@node-llama-cpp/win-x64-cuda-ext/bins/win-x64-cuda/fallback/ggml-cuda.dll', 'cuda 12');
  const runtime = join(root, 'runtime'); await mkdir(runtime);
  await writeFile(join(runtime, 'cublas64_13.dll'), 'cublas');
  await writeFile(join(runtime, 'cublasLt64_13.dll'), 'cublasLt');
  await writeFile(join(runtime, 'LICENSE.txt'), 'NVIDIA licence\n');
  await writeFile(join(runtime, 'notes.txt'), 'ignored');

  assert.equal(DEFAULT_RUNTIME_PLACEMENT, 'cuda-runtime');
  const { files, nodeLlamaCppVersion } = await collectPackFiles({ nodeModules: nm, runtimeDir: runtime, runtimePlacement: 'cuda-runtime' });
  assert.equal(nodeLlamaCppVersion, '3.21.1');
  assert.deepEqual(files.map(f => f.path).sort(), [
    'cuda-runtime/LICENSE.txt', 'cuda-runtime/cublas64_13.dll', 'cuda-runtime/cublasLt64_13.dll',
    'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/ggml-cuda.dll',
    'node_modules/@node-llama-cpp/win-x64-cuda/dist/index.js',
    'node_modules/@node-llama-cpp/win-x64-cuda/package.json',
  ]);
  assert.equal(await readFile(files.find(f => f.path === 'cuda-runtime/LICENSE.txt')!.source, 'utf8'), 'NVIDIA licence\n');
  const beside = await collectPackFiles({ nodeModules: nm, runtimeDir: runtime, runtimePlacement: 'beside-binaries' });
  assert.ok(beside.files.some(f => f.path === 'node_modules/@node-llama-cpp/win-x64-cuda/bins/win-x64-cuda/cublas64_13.dll'));
  assert.ok(beside.files.every(f => !f.path.startsWith('cuda-runtime/')));

  // The real CLI, against the fake trees: parts and manifest land in --out.
  const out = join(root, 'pack');
  const run = promisify(execFile);
  await run(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/cuda-pack.mts', '--runtime', runtime, '--out', out, '--node-modules', nm],
    { cwd: ELECTRON });
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files, 6);
  assert.equal(manifest.nodeLlamaCppVersion, '3.21.1');
  const dest = join(root, 'dest');
  await extractPack(partsStream(out, '3.21.1', manifest.parts.length), dest);
  assert.equal(await readFile(join(dest, 'cuda-runtime', 'cublasLt64_13.dll'), 'utf8'), 'cublasLt');

  // No NVIDIA licence: refused (D-CUDA-1). Another engine version: refused.
  const bare = join(root, 'bare'); await mkdir(bare); await writeFile(join(bare, 'cublas64_13.dll'), 'x');
  await assert.rejects(collectPackFiles({ nodeModules: nm, runtimeDir: bare, runtimePlacement: 'cuda-runtime' }), /LICENSE\.txt/);
  await put('@node-llama-cpp/win-x64-cuda/package.json', '{"name":"@node-llama-cpp/win-x64-cuda","version":"3.20.0"}');
  await assert.rejects(collectPackFiles({ nodeModules: nm, runtimeDir: runtime, runtimePlacement: 'cuda-runtime' }),
    { message: 'Version incohérente : @node-llama-cpp/win-x64-cuda 3.20.0 au lieu de 3.21.1' });
});
