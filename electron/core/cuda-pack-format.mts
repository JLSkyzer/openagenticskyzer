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
import { lstat, mkdir, open, readdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
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
export interface CudaPackManifest {
  format: 1; nodeLlamaCppVersion: string; platform: 'win-x64';
  parts: Array<{ name: string; size: number; sha256: string }>; downloadBytes: number; installedBytes: number; files: number;
}

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

/** Validates every path and refuses two paths that name the same file on Windows (case-insensitive). */
function checkPaths(paths: string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    safePackPath(path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(cudaPackUnsafePath(path));
    seen.add(key);
  }
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
export async function writePack(files: PackFile[], outDir: string, options: { nodeLlamaCppVersion: string; chunkBytes?: number }): Promise<CudaPackManifest> {
  const chunkBytes = options.chunkBytes ?? CUDA_PACK_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes >= 2 ** 31) throw new Error(`chunkBytes invalide : ${chunkBytes}`);
  checkPaths(files.map(file => file.path));
  const sorted = [...files].sort((a, b) => compareCodeUnits(a.path, b.path));

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
 * for it; each file's size and sha256 are checked against its header. On any failure everything created is removed.
 */
export async function extractPack(stream: AsyncIterable<Uint8Array>, destDir: string): Promise<{ files: number; bytes: number }> {
  await prepareTarget(destDir);
  const created = new Set<string>();           // top-level entries made here, removed on failure
  const dirs = new Set<string>();               // directories made here (pack paths), never re-checked
  const seen = new Set<string>();
  // pipeline() destroys every stage with the first error, so the gunzip iterator below rejects with it.
  const gunzip = pipeline(Readable.from(stream, { objectMode: false }), createGunzip(), () => {});
  const reader = new ByteReader(gunzip as AsyncIterable<Buffer>);
  let files = 0;
  let bytes = 0;

  async function makeDirs(segments: string[]): Promise<void> {
    for (let i = 1; i < segments.length; i++) {
      const rel = segments.slice(0, i).join('/');
      if (dirs.has(rel)) continue;
      const full = join(destDir, ...segments.slice(0, i));
      try {
        await mkdir(full);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Only a directory this extraction made itself can already be there; anything else (a link that appeared
        // under us) is refused, never followed.
        const info = await lstat(full);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(cudaPackUnsafeTarget(destDir));
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
      safePackPath(header.path);
      const key = header.path.toLowerCase();
      if (seen.has(key)) throw new Error(cudaPackUnsafePath(header.path));
      seen.add(key);

      const segments = header.path.split('/');
      await makeDirs(segments);
      if (segments.length === 1) created.add(segments[0]);
      // 'wx': never opens an existing entry, link or not.
      const handle = await open(join(destDir, ...segments), 'wx');
      const hash = createHash('sha256');
      try {
        for await (const chunk of reader.stream(header.size)) { hash.update(chunk); await handle.write(chunk); }
      } finally {
        await handle.close();
      }
      if (hash.digest('hex') !== header.sha256) throw new Corrupt();
      files += 1;
      bytes += header.size;
    }
    if (!(await reader.atEnd())) throw new Corrupt();
    return { files, bytes };
  } catch (error) {
    gunzip.destroy();
    for (const name of created) await rm(join(destDir, name), { recursive: true, force: true, maxRetries: 3 });
    // A broken gzip stream (bad data, bad CRC, truncated) is corruption; any other error (disk, abort) is itself.
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code.startsWith('Z_')) throw new Corrupt();
    throw error;
  }
}

