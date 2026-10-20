// The CUDA pack format (hardware and offload, Task 8). A pack is one gzip stream (level 9, header mtime 0, fixed
// OS byte) of records, cut into parts of CUDA_PACK_CHUNK_BYTES, each part hashed in manifest.json:
//   record     = uint32BE(headerLength) + JSON {"path","size","sha256"} + the file's bytes
//   end record = uint32BE(0)
// Files are sorted by path (code-unit order), so two builds of the same files give the same bytes.
//
// The pack carries `@node-llama-cpp/win-x64-cuda` and NVIDIA's cuBLAS DLLs with NVIDIA's LICENSE.txt in
// `cuda-runtime/` (decisions D-CUDA-1 and D-CUDA-3, « Bilan — Task 1 » of the hardware-and-offload plan).
// Extraction trusts nothing in the stream: every path goes through an allow-list before anything is created, the
// target must be an empty real directory, no existing link is ever followed, and any failure removes what was made.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export const CUDA_PACK_FORMAT = 1;
export const CUDA_PACK_CHUNK_BYTES = 1_900_000_000;               // < 2 GiB (2_147_483_648): « morceaux de moins de 2 Gio »
// D-CUDA-3: the pack never carries `win-x64-cuda-ext` (the CUDA 12 fallback, useless without CUDA 12 DLLs), so its
// prefix is not allowed: an extraction accepts only what a real pack holds.
export const CUDA_PACK_ALLOWED_PREFIXES = ['node_modules/@node-llama-cpp/win-x64-cuda/', 'cuda-runtime/'] as const;
export const CUDA_PACK_CORRUPT = "Pack CUDA corrompu (empreinte différente) : rien n'a été installé. Réessaie le téléchargement.";

export interface PackFile { path: string; source: string }      // path: posix, relative, inside the pack
// Which licence covers which files: NVIDIA's for the cuBLAS DLLs and their LICENSE.txt (never relabelled MIT,
// D-CUDA-1), MIT for the node-llama-cpp package. `text` is the pack path of the licence text itself.
export interface PackLicenceGroup { licence: 'NVIDIA' | 'MIT'; text: string; files: string[] }
export interface CudaPackManifest {
  format: 1; nodeLlamaCppVersion: string; platform: 'win-x64';
  parts: Array<{ name: string; size: number; sha256: string }>; downloadBytes: number; installedBytes: number; files: number;
  licences: PackLicenceGroup[];
}
// Default extraction budget, far above the real pack (≈ 690 MiB, about 25 files) and far below a disk-filling
// expansion. Task 9 passes the manifest's own installedBytes and files.
export const CUDA_PACK_DEFAULT_LIMITS = { maxBytes: 4 * 2 ** 30, maxFiles: 1000 } as const;

export function partName(nodeLlamaCppVersion: string, index: number): string {
  return `openagent-cuda-pack-${nodeLlamaCppVersion}-win-x64.part${index}`;
}

export function cudaPackUnsafePath(path: string): string {
  return `Pack CUDA refusé : il contient un chemin non autorisé (${path}).`;
}

export function cudaPackUnsafeTarget(destDir: string): string {
  return `Pack CUDA refusé : le dossier d'installation doit être un dossier vide, sans lien (${destDir}).`;
}

// One path segment: an allow-list of characters, so no ':' (drive, alternate data stream), no '\' , no '~' (8.3
// short-name alias), no space, no control or reserved character. Windows drops a trailing '.', so none is allowed.
const SEGMENT = /^[A-Za-z0-9_@+.-]{1,128}$/;
// Windows device names, with or without an extension (`NUL.txt` is still NUL).
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\.|$)/i;
const MAX_PATH_LENGTH = 400;

/** Returns `path`, or throws cudaPackUnsafePath: absolute, drive, UNC, '..', backslash, device, outside the prefixes. */
export function safePackPath(path: string): string {
  const refuse = () => { throw new Error(cudaPackUnsafePath(path)); };
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) refuse();
  // The prefix comparison is exact, case included: `Cuda-Runtime/` is refused, not folded.
  if (!CUDA_PACK_ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix) && path.length > prefix.length)) refuse();
  for (const segment of path.split('/')) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..' || segment.endsWith('.') || DEVICE.test(segment)) refuse();
  }
  return path;
}

/**
 * The paths of one pack, as Windows sees them (case-insensitive): each is safePackPath-checked, and a path that names
 * a file already listed, or a file where a directory is (or the reverse), throws cudaPackUnsafePath for that path.
 */
class PackPaths {
  private files = new Set<string>();
  private dirs = new Set<string>();

  add(path: string): void {
    safePackPath(path);
    const key = path.toLowerCase();
    const segments = key.split('/');
    const parents = segments.slice(1).map((_, i) => segments.slice(0, i + 1).join('/'));
    if (this.files.has(key) || this.dirs.has(key) || parents.some(parent => this.files.has(parent))) throw new Error(cudaPackUnsafePath(path));
    this.files.add(key);
    for (const parent of parents) this.dirs.add(parent);
  }
}

function checkLicences(paths: string[], licences: PackLicenceGroup[]): void {
  const left = new Set(paths);
  const refuse = (path: string) => { throw new Error(`Licences incohérentes : ${path}`); };
  for (const group of licences) {
    if (group.licence !== 'NVIDIA' && group.licence !== 'MIT') refuse(String(group.licence));
    if (!group.files.includes(group.text)) refuse(group.text);
    for (const path of group.files) { if (!left.delete(path)) refuse(path); }
  }
  for (const path of left) refuse(path);
}

const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function hashFile(source: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(source)) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { size, sha256: hash.digest('hex') };
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** Writes outDir/<partName…> and outDir/manifest.json (2-space JSON, trailing newline). */
// `licences`, when given, must label every file exactly once (the build script always gives it).
export async function writePack(files: PackFile[], outDir: string, options: { nodeLlamaCppVersion: string; chunkBytes?: number; licences?: PackLicenceGroup[] }): Promise<CudaPackManifest> {
  const chunkBytes = options.chunkBytes ?? CUDA_PACK_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes >= 2 ** 31) throw new Error(`chunkBytes invalide : ${chunkBytes}`);
  const sorted = [...files].sort((a, b) => compareCodeUnits(a.path, b.path));
  const paths = new PackPaths();
  for (const file of sorted) paths.add(file.path);
  const licences = (options.licences ?? []).map(group => ({ ...group, files: [...group.files].sort(compareCodeUnits) }));
  if (options.licences) checkLicences(sorted.map(file => file.path), licences);

  await mkdir(outDir, { recursive: true });
  // A rebuild into the same folder: only this format's own outputs are removed, so no stale part survives.
  for (const name of await readdir(outDir)) {
    if (name === 'manifest.json' || /^openagent-cuda-pack-.+-win-x64\.part\d+$/.test(name)) await rm(join(outDir, name));
  }

  let installedBytes = 0;
  async function* records(): AsyncGenerator<Buffer> {
    for (const file of sorted) {
      const { size, sha256 } = await hashFile(file.source);
      const header = Buffer.from(JSON.stringify({ path: file.path, size, sha256 }));
      yield Buffer.concat([uint32(header.length), header]);
      const hash = createHash('sha256');
      let read = 0;
      for await (const chunk of createReadStream(file.source)) { hash.update(chunk as Buffer); read += (chunk as Buffer).length; yield chunk as Buffer; }
      if (read !== size || hash.digest('hex') !== sha256) throw new Error(`Fichier modifié pendant la construction du pack : ${file.source}`);
      installedBytes += size;
    }
    yield uint32(0);
  }

  const parts: CudaPackManifest['parts'] = [];
  let first = true;
  async function cut(gzip: AsyncIterable<Buffer>): Promise<void> {
    let handle: FileHandle | null = null;
    let hash = createHash('sha256');
    let written = 0;
    const close = async () => {
      if (!handle) return;
      await handle.close();
      handle = null;
      parts[parts.length - 1].size = written;
      parts[parts.length - 1].sha256 = hash.digest('hex');
    };
    try {
      for await (let chunk of gzip) {
        if (first) {
          if (chunk.length < 10) throw new Error('En-tête gzip incomplet');
          // zlib already writes mtime 0; the OS byte depends on the platform zlib was built for, so it is fixed to
          // 255 (« unknown ») and the bytes do not depend on where the pack was built.
          chunk = Buffer.from(chunk);
          chunk[9] = 0xff;
          first = false;
        }
        while (chunk.length > 0) {
          if (!handle) {
            const name = partName(options.nodeLlamaCppVersion, parts.length + 1);
            parts.push({ name, size: 0, sha256: '' });
            handle = await open(join(outDir, name), 'wx');
            hash = createHash('sha256');
            written = 0;
          }
          const slice = chunk.subarray(0, chunkBytes - written);
          await handle.write(slice);
          hash.update(slice);
          written += slice.length;
          chunk = chunk.subarray(slice.length);
          if (written === chunkBytes) await close();
        }
      }
      await close();
    } finally {
      if (handle) await (handle as FileHandle).close();
    }
  }
  await pipelineAsync(Readable.from(records()), createGzip({ level: 9 }), cut);

  const manifest: CudaPackManifest = {
    format: CUDA_PACK_FORMAT, nodeLlamaCppVersion: options.nodeLlamaCppVersion, platform: 'win-x64',
    parts, downloadBytes: parts.reduce((sum, part) => sum + part.size, 0), installedBytes, files: sorted.length,
    licences,
  };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

class Corrupt extends Error {
  constructor() { super(CUDA_PACK_CORRUPT); }
}

/** Reads exact byte counts from the gunzipped stream. */
class ByteReader {
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;
  private source: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) { this.source = source[Symbol.asyncIterator](); }

  private async fill(n: number): Promise<void> {
    while (this.buffer.length < n && !this.done) {
      const next = await this.source.next();
      if (next.done) this.done = true;
      else this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value]);
    }
    if (this.buffer.length < n) throw new Corrupt();
  }

  async take(n: number): Promise<Buffer> {
    await this.fill(n);
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** Yields exactly `n` bytes, chunk by chunk, without holding them all. */
  async *stream(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      const out = this.buffer.subarray(0, left);
      this.buffer = this.buffer.subarray(out.length);
      left -= out.length;
      yield out;
    }
  }

  async atEnd(): Promise<boolean> {
    if (this.buffer.length > 0) return false;
    try { await this.fill(1); } catch (error) { if (error instanceof Corrupt) return true; throw error; }
    return false;
  }
}

const MAX_HEADER_BYTES = 4096;

function parseHeader(bytes: Buffer): { path: string; size: number; sha256: string } {
  let header: unknown;
  try { header = JSON.parse(bytes.toString('utf8')); } catch { throw new Corrupt(); }
  const { path, size, sha256 } = (header ?? {}) as Record<string, unknown>;
  if (typeof path !== 'string' || !Number.isSafeInteger(size) || (size as number) < 0
    || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Corrupt();
  return { path, size: size as number, sha256 };
}

/** The target must be an empty real directory (created here if absent): nothing in it can be a link to follow. */
async function prepareTarget(destDir: string): Promise<void> {
  try {
    await mkdir(destDir);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await mkdir(destDir, { recursive: true });
      return;
    }
  }
  const info = await lstat(destDir);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(destDir)).length > 0) throw new Error(cudaPackUnsafeTarget(destDir));
}

/**
 * Extracts a pack's byte stream (its parts, in order) into `destDir`. Each path is checked before anything is created
 * for it; each file's size and sha256 are checked against its header; the whole pack keeps to `limits` (bytes
 * written and entries), counted before and while writing. On any failure everything created is removed.
 *
 * Links: the target must be an empty real directory, every parent of a file is lstat-checked from `destDir` down
 * just before the file is opened, and the opened file's real folder is compared with where it should be. A process
 * of the same user that swaps a folder for a junction at the right instant is outside the threat model (it already
 * holds every right this extraction has: no privilege is gained); these checks only narrow that window, and a
 * mismatch found after the open removes the file and rolls everything back.
 */
export async function extractPack(stream: AsyncIterable<Uint8Array>, destDir: string, limits?: { maxBytes?: number; maxFiles?: number }): Promise<{ files: number; bytes: number }> {
  const maxBytes = limits?.maxBytes ?? CUDA_PACK_DEFAULT_LIMITS.maxBytes;
  const maxFiles = limits?.maxFiles ?? CUDA_PACK_DEFAULT_LIMITS.maxFiles;
  await prepareTarget(destDir);
  const realDest = await realpath(destDir);
  const created = new Set<string>();           // top-level entries made here, removed on failure
  const dirs = new Set<string>();               // directories made here (pack paths)
  const paths = new PackPaths();
  // pipeline() destroys every stage with the first error, so the gunzip iterator below rejects with it.
  const gunzip = pipeline(Readable.from(stream, { objectMode: false }), createGunzip(), () => {});
  const reader = new ByteReader(gunzip as AsyncIterable<Buffer>);
  let files = 0;
  let bytes = 0;
  const unsafeTarget = () => new Error(cudaPackUnsafeTarget(destDir));
  const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

  /** `destDir` and each parent of the file, from the top down, must be a real directory: never a link or junction. */
  async function checkParents(segments: string[]): Promise<void> {
    for (let i = 0; i < segments.length; i++) {
      const info = await lstat(join(destDir, ...segments.slice(0, i)));
      if (!info.isDirectory() || info.isSymbolicLink()) throw unsafeTarget();
    }
  }

  async function makeDirs(segments: string[]): Promise<void> {
    for (let i = 1; i < segments.length; i++) {
      const rel = segments.slice(0, i).join('/');
      if (dirs.has(rel)) continue;
      await checkParents(segments.slice(0, i));
      try {
        await mkdir(join(destDir, ...segments.slice(0, i)));
      } catch (error) {
        // PackPaths already refused every clash inside the pack, and the target started empty: anything already
        // there was not made by this extraction.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw unsafeTarget();
        throw error;
      }
      if (i === 1) created.add(segments[0]);
      dirs.add(rel);
    }
  }

  try {
    for (;;) {
      const headerLength = (await reader.take(4)).readUInt32BE(0);
      if (headerLength === 0) break;
      if (headerLength > MAX_HEADER_BYTES) throw new Corrupt();
      const header = parseHeader(await reader.take(headerLength));
      paths.add(header.path);
      // The budget is checked before anything is created for this entry.
      if (files + 1 > maxFiles || header.size > maxBytes - bytes) throw new Corrupt();

      const segments = header.path.split('/');
      await makeDirs(segments);
      await checkParents(segments);
      if (segments.length === 1) created.add(segments[0]);
      const file = join(destDir, ...segments);
      // 'wx': never opens an existing entry, link or not.
      const handle = await open(file, 'wx');
      const hash = createHash('sha256');
      let written = 0;
      try {
        const expected = join(realDest, ...segments.slice(0, -1));
        const actual = await realpath(dirname(file));
        if (!samePath(actual, expected)) {
          // The file was created where it should not be: it is ours ('wx'), so it goes, then everything rolls back.
          await handle.close().catch(() => {});
          await rm(join(actual, segments[segments.length - 1]), { force: true });
          throw unsafeTarget();
        }
        for await (const chunk of reader.stream(header.size)) {
          written += chunk.length;
          if (bytes + written > maxBytes) throw new Corrupt();
          hash.update(chunk);
          await handle.write(chunk);
        }
      } finally {
        await handle.close().catch(() => {});
      }
      if (written !== header.size || hash.digest('hex') !== header.sha256) throw new Corrupt();
      files += 1;
      bytes += written;
    }
    if (!(await reader.atEnd())) throw new Corrupt();
    return { files, bytes };
  } catch (error) {
    gunzip.destroy();
    await rollback(destDir, created);
    // A broken gzip stream (bad data, bad CRC, truncated) is corruption; any other error (disk, abort) is itself.
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code.startsWith('Z_')) throw new Corrupt();
    throw error;
  }
}

/** Removes what an extraction made. A top-level entry that is now a link is unlinked itself, never followed. */
async function rollback(destDir: string, created: Set<string>): Promise<void> {
  for (const name of created) {
    const path = join(destDir, name);
    let info;
    try { info = await lstat(path); } catch { continue; }
    if (info.isSymbolicLink()) await unlink(path);
    else await rm(path, { recursive: true, force: true, maxRetries: 3 });
  }
}
