// The CUDA pack installer (hardware and offload, Task 9). It downloads the parts of the app's own GitHub release,
// checks each part against the manifest SHIPPED with the app (`manifestPath`: « empreinte intégrée à l'app »; a
// manifest from the download source is never read), checks free space first, and extracts through a staging folder
// renamed atomically to `<dataHome>/cuda-pack/current`. It supports cancel, uninstall (finished at the next start
// when Windows still holds a DLL) and reports a pack built for another engine version as `mismatch`, so the runtime
// (Task 10) falls back to Vulkan and offers the right pack.
//
// Parts are hashed while they stream into the extractor. Unverified bytes therefore reach the staging folder, but
// they never count: the extraction keeps to a byte and file budget no larger than the shipped manifest's own
// figures, every part's size and sha256 must match before the install goes on, the extracted totals must equal the
// manifest's, and any failure removes the whole staging folder.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CUDA_PACK_CORRUPT, CUDA_PACK_DEFAULT_LIMITS, extractPack, type CudaPackManifest } from './cuda-pack-format.mts';
import { formatBytes } from './units.mts';

export type CudaPackState = 'unavailable' | 'absent' | 'installing' | 'installed' | 'mismatch';
export interface CudaPackStatus { state: CudaPackState; downloadBytes: number | null; installedBytes: number | null; installedVersion: string | null; expectedVersion: string }

export const CUDA_PACK_MARGIN_BYTES = 268_435_456;
export const CUDA_PACK_UNAVAILABLE = "Pack CUDA non disponible pour cette version de l'app.";
export const CUDA_PACK_BUSY = 'Une installation du pack CUDA est déjà en cours.';
const MAX_REDIRECTS = 5;

export function cudaPackDiskNotice(required: number, free: number): string {
  return `Espace disque insuffisant pour le pack CUDA : il faut ${formatBytes(required)} libres, il en reste ${formatBytes(free)}.`;
}

export function cudaPackUrlRefused(url: string): string {
  return `Adresse de téléchargement du pack CUDA refusée : ${url}`;
}

/** `https://github.com/<owner>/<repo>/releases/download/v<version>/`, from the single github entry of build.publish. */
export function releaseBaseUrl(pkg: { version: string; build: { publish: unknown } }): string {
  const entries = (Array.isArray(pkg.build.publish) ? pkg.build.publish : [pkg.build.publish]) as Array<Record<string, unknown> | null>;
  const github = entries.filter(entry => entry?.provider === 'github');
  const name = /^[A-Za-z0-9_.-]+$/;
  if (github.length !== 1) throw new Error(`build.publish doit avoir exactement une entrée github (${github.length} trouvée(s)).`);
  const { owner, repo } = github[0]!;
  if (typeof owner !== 'string' || typeof repo !== 'string' || !name.test(owner) || !name.test(repo)) throw new Error('build.publish : owner ou repo invalide.');
  if (typeof pkg.version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(pkg.version)) throw new Error(`Version invalide : ${String(pkg.version)}`);
  return `https://github.com/${owner}/${repo}/releases/download/v${pkg.version}/`;
}

/** Free bytes for this user on the disk of `dir` (statfs: bavail * bsize). */
export async function freeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Math.floor(Number(info.bavail) * Number(info.bsize));
}

interface PackMarker { nodeLlamaCppVersion: string; parts: string[]; installedAt: string }

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The shipped manifest, or null when it is missing or not a well-formed pack manifest. */
async function readManifest(path: string): Promise<CudaPackManifest | null> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
  const m = value as Partial<CudaPackManifest> | null;
  if (!m || m.format !== 1 || typeof m.nodeLlamaCppVersion !== 'string' || !Array.isArray(m.parts) || m.parts.length === 0) return null;
  if (!isCount(m.downloadBytes) || !isCount(m.installedBytes) || !isCount(m.files)) return null;
  let sum = 0;
  for (const part of m.parts) {
    // A part name becomes a URL path segment: plain file names only.
    if (!part || typeof part.name !== 'string' || !/^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,199}$/.test(part.name)) return null;
    if (!isCount(part.size) || part.size === 0 || typeof part.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(part.sha256)) return null;
    sum += part.size;
  }
  if (sum !== m.downloadBytes) return null;
  return m as CudaPackManifest;
}

async function readMarker(dir: string): Promise<PackMarker | null> {
  try {
    const marker = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')) as Partial<PackMarker> | null;
    if (!marker || typeof marker.nodeLlamaCppVersion !== 'string') return null;
    return marker as PackMarker;
  } catch {
    return null;
  }
}

function abortError(): Error {
  return new DOMException('Téléchargement du pack CUDA annulé.', 'AbortError');
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

export class CudaPack {
  private readonly dataHome: string;
  private readonly manifestPath: string;
  private readonly baseUrl: string;
  private readonly engineVersion: string;
  private readonly allowLoopback: boolean;
  private readonly free: (dir: string) => Promise<number>;
  private installing = false;

  constructor(options: { dataHome: string; manifestPath: string; baseUrl: string; engineVersion: string; allowLoopback?: boolean; freeBytes?: (dir: string) => Promise<number> }) {
    this.dataHome = options.dataHome;
    this.manifestPath = options.manifestPath;
    this.baseUrl = options.baseUrl;
    this.engineVersion = options.engineVersion;
    this.allowLoopback = options.allowLoopback ?? false;
    this.free = options.freeBytes ?? freeBytes;
  }

  private get base(): string { return join(this.dataHome, 'cuda-pack'); }
  private get current(): string { return join(this.base, 'current'); }

  /** The shipped manifest, only if it is the pack of this engine version. */
  private async manifest(): Promise<CudaPackManifest | null> {
    const manifest = await readManifest(this.manifestPath);
    return manifest && manifest.nodeLlamaCppVersion === this.engineVersion ? manifest : null;
  }

  async status(): Promise<CudaPackStatus> {
    const installing = this.installing;            // read before any await: an install running now
    const manifest = await this.manifest();
    const sizes = { downloadBytes: manifest?.downloadBytes ?? null, installedBytes: manifest?.installedBytes ?? null };
    const base = { ...sizes, expectedVersion: this.engineVersion };
    if (installing) return { state: 'installing', ...base, installedVersion: null };
    const marker = await readMarker(this.current);
    if (marker) {
      const state = marker.nodeLlamaCppVersion === this.engineVersion ? 'installed' : 'mismatch';
      return { state, ...base, installedVersion: marker.nodeLlamaCppVersion };
    }
    return { state: manifest ? 'absent' : 'unavailable', ...base, installedVersion: null };
  }

  async installedDir(): Promise<string | null> {
    return (await this.status()).state === 'installed' ? this.current : null;
  }

  private checkUrl(url: string): URL {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(cudaPackUrlRefused(url)); }
    const loopback = this.allowLoopback && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '';
    if (parsed.protocol !== 'https:' && !loopback) throw new Error(cudaPackUrlRefused(url));
    return parsed;
  }

  /** GET with at most MAX_REDIRECTS redirects, each target checked before it is requested. */
  private async get(url: string, signal: AbortSignal | undefined): Promise<Response> {
    let target = this.checkUrl(url).href;
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(target, { redirect: 'manual', signal });
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel().catch(() => {});
        const next = new URL(response.headers.get('location')!, target).href;
        if (redirects >= MAX_REDIRECTS) throw new Error(cudaPackUrlRefused(next));
        target = this.checkUrl(next).href;
        continue;
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Téléchargement du pack CUDA impossible : HTTP ${response.status} (${target}).`);
      }
      return response;
    }
  }

  async install(options: { signal?: AbortSignal; onProgress?(received: number, total: number): void } = {}): Promise<CudaPackStatus> {
    if (this.installing) throw new Error(CUDA_PACK_BUSY);
    this.installing = true;
    try {
      await this.installOnce(options);
    } finally {
      this.installing = false;
    }
    return this.status();
  }

  private async installOnce({ signal, onProgress }: { signal?: AbortSignal; onProgress?(received: number, total: number): void }): Promise<void> {
    const manifest = await this.manifest();
    if (!manifest) throw new Error(CUDA_PACK_UNAVAILABLE);
    if (signal?.aborted) throw abortError();
    await mkdir(this.base, { recursive: true });
    const required = manifest.installedBytes + CUDA_PACK_MARGIN_BYTES;
    const free = await this.free(this.dataHome);
    if (free < required) throw new Error(cudaPackDiskNotice(required, free));

    const staging = join(this.base, `.staging-${randomUUID()}`);
    await mkdir(staging);
    try {
      const total = manifest.downloadBytes;
      let received = 0;
      let verified = 0;
      const self = this;
      async function* parts(): AsyncGenerator<Uint8Array> {
        for (const part of manifest!.parts) {
          const response = await self.get(self.baseUrl + part.name, signal);
          const hash = createHash('sha256');
          let size = 0;
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.length;
            // A part longer than announced is refused at once, before its excess is passed on.
            if (size > part.size) throw new Error(CUDA_PACK_CORRUPT);
            hash.update(chunk);
            received += chunk.length;
            onProgress?.(received, total);
            yield chunk;
          }
          if (size !== part.size || hash.digest('hex') !== part.sha256) throw new Error(CUDA_PACK_CORRUPT);
          verified += 1;
        }
      }
      // The manifest can lower the budget, never raise it.
      const limits = { maxBytes: Math.min(manifest.installedBytes, CUDA_PACK_DEFAULT_LIMITS.maxBytes), maxFiles: Math.min(manifest.files, CUDA_PACK_DEFAULT_LIMITS.maxFiles) };
      const result = await extractPack(parts(), staging, limits);
      // Every part verified, and the extracted totals are the shipped manifest's.
      if (verified !== manifest.parts.length || result.files !== manifest.files || result.bytes !== manifest.installedBytes) throw new Error(CUDA_PACK_CORRUPT);
      if (signal?.aborted) throw abortError();

      const marker: PackMarker = { nodeLlamaCppVersion: manifest.nodeLlamaCppVersion, parts: manifest.parts.map(p => p.sha256), installedAt: new Date().toISOString() };
      await writeFile(join(staging, 'pack.json'), JSON.stringify(marker, null, 2) + '\n');
      await this.removeCurrent();
      if (await exists(this.current)) throw new Error('Le pack CUDA précédent est encore utilisé : redémarre l\'app puis relance l\'installation.');
      await rename(staging, this.current);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  /**
   * Marker first (the pack is `absent` at once and never loaded again), then the folder. A DLL this process still
   * maps (EBUSY/EPERM) keeps it: it is renamed aside if Windows allows, else left; finishPendingRemoval() ends it.
   */
  private async removeCurrent(): Promise<void> {
    try { await unlink(join(this.current, 'pack.json')); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    try {
      await rm(this.current, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      await rename(this.current, join(this.base, `.remove-pending-${randomUUID()}`)).catch(() => {});
    }
  }

  async uninstall(): Promise<CudaPackStatus> {
    if (this.installing) throw new Error(CUDA_PACK_BUSY);
    await this.removeCurrent();
    return this.status();
  }

  /**
   * Called by the worker at start, before any getLlama: removes every `.remove-pending-*`, a `current` without its
   * marker, and a `.staging-*` an interrupted install left. Best effort: what is still locked waits for the next start.
   */
  async finishPendingRemoval(): Promise<void> {
    if (this.installing) return;
    let names: string[];
    try { names = await readdir(this.base); } catch { return; }
    for (const name of names) {
      const stale = name.startsWith('.remove-pending-') || name.startsWith('.staging-')
        || (name === 'current' && !(await exists(join(this.current, 'pack.json'))));
      if (stale) await rm(join(this.base, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}
