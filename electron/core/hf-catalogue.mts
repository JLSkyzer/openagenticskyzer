// Reads the Hugging Face catalogue: GGUF repositories (metadata only) and, per repository, the .gguf files with
// their sizes and SHA-256. Everything that comes back is untrusted text from the internet: parsing is defensive
// and never throws a TypeError. Sizes come from the file tree only — `gguf.total` is unverified and never used.
// `baseUrl` is overridable only by tests (same seam as core/hf-token.mts); production always hits huggingface.co.

export const HF_BASE_URL = 'https://huggingface.co';

const TIMEOUT_MS = 20_000;
const MAX_TREE_PAGES = 20;
const USER_AGENT = 'openagent';

export type CatalogueSort = 'downloads' | 'likes' | 'lastModified';

export interface CatalogueModel {
  id: string;
  downloads: number;
  likes: number;
  gated: boolean;
  lastModified: string;
  architecture: string | null;
  contextLength: number | null;
  chatTemplate: string | null;
  tags: string[];
}

export interface ModelVariant {
  name: string;
  files: { path: string; size: number; sha256: string | null }[];
  totalBytes: number;
}

export class HfError extends Error {
  kind: 'offline' | 'gated' | 'bad-answer';
  constructor(kind: 'offline' | 'gated' | 'bad-answer', message: string) {
    super(message);
    this.name = 'HfError';
    this.kind = kind;
  }
}

interface CallOptions { baseUrl?: string; token?: string; signal?: AbortSignal }

/** The token goes only to huggingface.co (or, in tests, to the host of the injected base URL). */
export function mayCarryToken(url: URL, baseUrl: string): boolean {
  if (url.hostname === 'huggingface.co') return true;
  if (baseUrl === HF_BASE_URL) return false;
  try { return url.host === new URL(baseUrl).host; } catch { return false; }
}

async function getResponse(url: URL, options: CallOptions): Promise<Response> {
  const baseUrl = options.baseUrl ?? HF_BASE_URL;
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  const token = options.token?.trim();
  if (token && mayCarryToken(url, baseUrl)) headers.Authorization = `Bearer ${token}`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error: any) {
    if (options.signal?.aborted) throw error; // the caller cancelled: not a network problem
    throw new HfError('offline', error?.name === 'TimeoutError' ? `Hugging Face ne répond pas (>${TIMEOUT_MS / 1000} s)` : 'Hugging Face est injoignable');
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new HfError('gated', `Accès refusé par Hugging Face (HTTP ${response.status})`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HfError(response.status >= 500 ? 'offline' : 'bad-answer', `Hugging Face a répondu HTTP ${response.status}`);
  }
  return response;
}

async function readJson(response: Response, options: CallOptions): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: any) {
    if (options.signal?.aborted) throw error;
    if (error?.name === 'TimeoutError') throw new HfError('offline', 'Hugging Face ne répond pas');
    throw new HfError('bad-answer', 'Réponse illisible de Hugging Face');
  }
}

/** owner/name: word characters, dots and dashes, and no `.` or `..` segment — such an id never reaches a URL. */
export function isRepoId(id: unknown): id is string {
  return typeof id === 'string' && /^[\w.-]+\/[\w.-]+$/.test(id) && !id.split('/').some(s => s === '.' || s === '..');
}

const asNumber =(value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asString = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

function parseModel(entry: unknown): CatalogueModel | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, any>;
  const id = asString(e.id);
  if (!id || !isRepoId(id) || !e.gguf || typeof e.gguf !== 'object') return null;
  const gguf = e.gguf as Record<string, unknown>;
  const context = asNumber(gguf.context_length, 0);
  return {
    id,
    downloads: asNumber(e.downloads, 0),
    likes: asNumber(e.likes, 0),
    gated: Boolean(e.gated), // false on the open ones; true, "auto" or "manual" on the restricted ones
    lastModified: typeof e.lastModified === 'string' ? e.lastModified : '',
    architecture: asString(gguf.architecture),
    contextLength: context > 0 ? context : null,
    chatTemplate: asString(gguf.chat_template),
    tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

export async function searchModels(options: { query?: string; sort?: CatalogueSort; limit?: number; baseUrl?: string; token?: string; signal?: AbortSignal } = {}): Promise<CatalogueModel[]> {
  const url = new URL('/api/models', options.baseUrl ?? HF_BASE_URL);
  url.searchParams.set('filter', 'gguf');
  const query = options.query?.trim();
  if (query) url.searchParams.set('search', query);
  url.searchParams.set('sort', options.sort ?? 'downloads');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))));
  for (const field of ['gguf', 'downloads', 'likes', 'gated', 'tags', 'lastModified']) url.searchParams.append('expand[]', field);
  const body = await readJson(await getResponse(url, options), options);
  if (!Array.isArray(body)) throw new HfError('bad-answer', 'Liste de modèles inattendue');
  const models: CatalogueModel[] = [];
  for (const entry of body) {
    const model = parseModel(entry);
    if (model) models.push(model);
  }
  return models;
}

const PART = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** Groups a repository's tree entries into variants: one per quantisation, split files (-00001-of-00003) as one. */
export function groupVariants(entries: unknown): ModelVariant[] {
  if (!Array.isArray(entries)) throw new HfError('bad-answer', 'Arbre de fichiers inattendu');
  const groups = new Map<string, { files: { path: string; size: number; sha256: string | null; part: number }[]; of: number }>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, any>;
    if (typeof e.path !== 'string' || (e.type !== undefined && e.type !== 'file')) continue;
    const path: string = e.path;
    if (!/\.gguf$/i.test(path) || /mmproj/i.test(path)) continue;
    const size = asNumber(e.lfs?.size, asNumber(e.size, -1));
    if (size < 0) continue;
    const oid = e.lfs && typeof e.lfs === 'object' ? e.lfs.oid : null;
    const sha256 = typeof oid === 'string' && /^[0-9a-f]{64}$/i.test(oid) ? oid.toLowerCase() : null;
    const split = PART.exec(path);
    const name = split ? split[1] : path.replace(/\.gguf$/i, '');
    const group = groups.get(name) ?? { files: [], of: split ? Number(split[3]) : 1 };
    if (split && group.of !== Number(split[3])) continue; // parts of two different sets under one name: keep the first
    group.files.push({ path, size, sha256, part: split ? Number(split[2]) : 1 });
    groups.set(name, group);
  }
  const variants: ModelVariant[] = [];
  for (const [name, group] of groups) {
    group.files.sort((a, b) => a.part - b.part || a.path.localeCompare(b.path));
    // An incomplete or duplicated set of parts cannot be installed: it is not offered.
    if (group.files.length !== group.of || group.files.some((f, i) => f.part !== i + 1)) continue;
    const files = group.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    variants.push({ name, files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) });
  }
  return variants.sort((a, b) => a.totalBytes - b.totalBytes || a.name.localeCompare(b.name));
}

function nextLink(response: Response, current: URL): URL | null {
  const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(response.headers.get('link') ?? '');
  if (!match) return null;
  try {
    const next = new URL(match[1], current);
    return next.origin === current.origin ? next : null;
  } catch { return null; }
}

export async function modelVariants(id: string, options: { baseUrl?: string; token?: string; signal?: AbortSignal } = {}): Promise<ModelVariant[]> {
  if (!isRepoId(id)) throw new HfError('bad-answer', 'Identifiant de dépôt invalide');
  let url: URL | null = new URL(`/api/models/${id}/tree/main`, options.baseUrl ?? HF_BASE_URL);
  url.searchParams.set('recursive', 'true');
  const entries: unknown[] = [];
  for (let page = 0; url && page < MAX_TREE_PAGES; page++) {
    const response = await getResponse(url, options);
    const body = await readJson(response, options);
    if (!Array.isArray(body)) throw new HfError('bad-answer', 'Arbre de fichiers inattendu');
    entries.push(...body);
    url = nextLink(response, url);
  }
  return groupVariants(entries);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * The file's base name, safe to create inside the models folder. Throws 'Nom de fichier refusé' on an empty name,
 * a `..` segment, a separator or drive marker left after normalising, a reserved Windows name, or anything
 * that does not end in .gguf.
 */
export function safeModelFileName(path: string): string {
  const refuse = (): never => { throw new Error('Nom de fichier refusé'); };
  if (typeof path !== 'string') return refuse();
  const normalised = path.normalize('NFC').replace(/\\/g, '/');
  const segments = normalised.split('/');
  if (segments.some(s => s === '..')) return refuse();
  const base = segments[segments.length - 1];
  if (!base || base === '.') return refuse();
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(base)) return refuse();
  if (/[. ]$/.test(base)) return refuse();
  if (!/\.gguf$/i.test(base) || base.length === '.gguf'.length) return refuse();
  if (RESERVED.test(base.split('.')[0].trim())) return refuse();
  return base;
}
