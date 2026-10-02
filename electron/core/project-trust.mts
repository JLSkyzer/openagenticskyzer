import { createHash } from 'node:crypto';
import { readFile, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { JsonStore } from './json-store.mts';
import { projectPluginFiles } from './plugin-loader.mts';
import { parseProjectMcpConfig, type McpServerConfig } from './mcp-config.mts';
import { RELAXABLE_KEYS, relaxationsOf, type Relaxations, type SettingsService } from './settings.mts';

export type TrustState = 'none' | 'pending' | 'trusted' | 'ignored';
export type TrustDecision = 'trusted' | 'ignored';
/** Plugins + .mcp.json servers, decided together under one fingerprint. */
export type ContentStatus = 'none' | 'pending' | TrustDecision;
export type RelaxationStatus = 'approved' | 'ignored' | 'pending';
export interface ProjectInventory { plugins: string[]; mcpServers: McpServerConfig[]; relaxations: Relaxations }
export interface ProjectTrust {
  /** Aggregate, for "is anything waiting?": pending if any part is pending, else ignored if any part
   * is refused, else trusted. Never enough to say what IS applied — read the per-part fields. */
  state: TrustState;
  /** The content was TRUSTED for another fingerprint: the plugins/.mcp.json changed since that approval. */
  changed: boolean;
  /** What the user was shown. decide() refuses a token that no longer matches the project. */
  token: string;
  contentStatus: ContentStatus;
  contentTrusted: boolean;
  /** The project's content could not be read (plugin file, .mcp.json): nothing of it is loaded. */
  unreadable: boolean;
  /** Per current relaxation: is ITS project value applied (approved), refused (ignored) or undecided. */
  relaxationStatus: Record<string, RelaxationStatus>;
  approvedRelaxations: Record<string, unknown>;
  inventory: ProjectInventory;
}
interface TrustRecord {
  content?: { decision: TrustDecision; fingerprint: string; decided_at: string };
  approved_relaxations?: Record<string, unknown>;
  ignored_relaxations?: Record<string, unknown>;
}
type Registry = Record<string, TrustRecord>;

const CHANGED_MESSAGE = 'Le contenu du projet a changé depuis l’affichage : relis la liste avant de décider.';
const RELAXABLE = new Set(RELAXABLE_KEYS);

function isRegistry(value: unknown): value is Registry {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Lists and hashes what a project brings, WITHOUT importing or running any of it. */
async function scanContent(folder: string, home: string) {
  const files = await projectPluginFiles(folder, home);
  const plugins = files.map(file => relative(folder, file).split(sep).join('/'));
  const parts: Array<[string, Buffer]> = [];
  for (let i = 0; i < files.length; i++) parts.push([plugins[i], await readFile(files[i])]);
  // .mcp.json is read ONCE and both parsed and hashed from those same bytes. Only "absent" (ENOENT) means
  // nothing to approve; any other read error throws, so the project can never look unchanged by accident.
  const mcpPath = join(folder, '.mcp.json');
  let mcpBytes: Buffer | null = null;
  try { mcpBytes = await readFile(mcpPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const mcpServers = mcpBytes ? parseProjectMcpConfig(mcpBytes.toString('utf8'), mcpPath, { expandEnv: false }) : [];
  // An .mcp.json that yields no valid server starts nothing: inert, nothing to approve.
  if (mcpBytes && mcpServers.length) parts.push(['.mcp.json', mcpBytes]);
  parts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let fingerprint: string | null = null;
  if (parts.length) {
    const hash = createHash('sha256');
    for (const [name, bytes] of parts) hash.update(`${name}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
    fingerprint = hash.digest('hex');
  }
  return { fingerprint, plugins, mcpServers };
}

/**
 * Per-project approval of what a project brings that can run code or widen the agent's permissions:
 * its plugin files, its .mcp.json servers, its permission relaxations. Read-only toward the project
 * (nothing of it is ever imported or run here); the registry lives in the user's data home, keyed
 * by the project's real path — never in the project, which could otherwise ship its own approval.
 * Every failure resolves to "not approved".
 */
export class ProjectTrustService {
  private readonly home: string;
  private readonly settings: SettingsService;
  private readonly store = new JsonStore();
  constructor(home: string, settings: SettingsService) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.home = home;
    this.settings = settings;
  }
  private path() {
    return join(this.home, 'trusted-projects.json');
  }

  private async recordFor(folder: string): Promise<TrustRecord> {
    try {
      const value = await this.store.read<unknown>(this.path(), {});
      if (!isRegistry(value)) return {};
      return value[await realpath(folder)] ?? {};
    } catch (error) {
      console.error(`[trust] registre illisible, rien n'est approuvé : ${error instanceof Error ? error.message : error}`);
      return {};
    }
  }

  /** A corrupt registry is moved aside (kept, never deleted) so the decision can still be written. */
  private async change(folder: string, update: (record: TrustRecord) => TrustRecord | undefined) {
    const key = await realpath(folder);
    const apply = () => this.store.update<unknown>(this.path(), {}, current => {
      const all: Registry = isRegistry(current) ? { ...current } : {};
      const next = update(all[key] ?? {});
      if (next) all[key] = next;
      else delete all[key];
      return all;
    });
    try {
      await apply();
    } catch (error) {
      if (!(error instanceof Error && /JSON illisible/.test(error.message))) throw error;
      await rename(this.path(), `${this.path()}.corrupt-${Date.now()}`);
      await apply();
    }
  }

  private async assess(folder: string) {
    if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
    const [global, project] = await Promise.all([this.settings.global(), this.settings.project(folder)]);
    const relaxations = relaxationsOf(global, project);
    let scan: Awaited<ReturnType<typeof scanContent>> | null = null;
    let realFolder: string | null = null;
    // Scanned under the real path: the plugin loader resolves .openagent/tools there, so paths relative
    // to a junction/symlink would not match. A failing realpath leaves scan null: pending, never approved.
    try { realFolder = await realpath(folder); scan = await scanContent(realFolder, this.home); }
    catch (error) { console.error(`[trust] contenu du projet illisible, non approuvé : ${error instanceof Error ? error.message : error}`); }
    const record = await this.recordFor(folder);
    const fingerprint = scan?.fingerprint ?? null;
    const contentStatus: ContentStatus =
      scan === null ? 'pending'
      : fingerprint === null ? 'none'
      : record.content?.fingerprint === fingerprint && (record.content.decision === 'trusted' || record.content.decision === 'ignored') ? record.content.decision
      : 'pending';
    const approved = record.approved_relaxations ?? {};
    const ignored = record.ignored_relaxations ?? {};
    const relaxationStatus: Record<string, RelaxationStatus> = {};
    for (const [key, { project: value }] of Object.entries(relaxations)) {
      relaxationStatus[key] = approved[key] === value ? 'approved' : ignored[key] === value ? 'ignored' : 'pending';
    }
    const statuses = Object.values(relaxationStatus);
    const state: TrustState =
      contentStatus === 'none' && statuses.length === 0 ? 'none'
      : contentStatus === 'pending' || statuses.includes('pending') ? 'pending'
      : contentStatus === 'ignored' || statuses.includes('ignored') ? 'ignored'
      : 'trusted';
    const trust: ProjectTrust = {
      state,
      changed: scan !== null && fingerprint !== null && record.content?.decision === 'trusted' && record.content.fingerprint !== fingerprint,
      // The real path is hashed in too: a token shown for one folder never decides another (defence in depth).
      token: createHash('sha256').update(JSON.stringify([realFolder, fingerprint, scan === null, relaxations])).digest('hex'),
      contentStatus,
      contentTrusted: contentStatus === 'trusted',
      unreadable: scan === null,
      relaxationStatus,
      approvedRelaxations: approved,
      inventory: { plugins: scan?.plugins ?? [], mcpServers: scan?.mcpServers ?? [], relaxations },
    };
    return { trust, fingerprint, contentStatus };
  }

  async evaluate(folder: string): Promise<ProjectTrust> {
    return (await this.assess(folder)).trust;
  }

  /** "Faire confiance" approves the current content and every current relaxation; "Ignorer" refuses
   * only what is pending — it never flips trusted content nor an approved relaxation. */
  async decide(folder: string, decision: TrustDecision, token: string): Promise<ProjectTrust> {
    if (decision !== 'trusted' && decision !== 'ignored') throw new Error('Décision de confiance invalide');
    const { trust, fingerprint, contentStatus } = await this.assess(folder);
    if (token !== trust.token) throw new Error(CHANGED_MESSAGE);
    const values = Object.entries(trust.inventory.relaxations).map(([key, { project }]) => [key, project] as const);
    await this.change(folder, record => {
      const next: TrustRecord = { ...record };
      if (fingerprint !== null && (decision === 'trusted' || contentStatus === 'pending')) {
        next.content = { decision, fingerprint, decided_at: new Date().toISOString() };
      }
      const approved = { ...record.approved_relaxations };
      const ignored = { ...record.ignored_relaxations };
      for (const [key, value] of values) {
        if (decision === 'trusted') { approved[key] = value; delete ignored[key]; }
        else if (approved[key] !== value) ignored[key] = value;
      }
      next.approved_relaxations = approved;
      next.ignored_relaxations = ignored;
      return next;
    });
    return this.evaluate(folder);
  }

  async revoke(folder: string): Promise<ProjectTrust> {
    await this.change(folder, () => undefined);
    return this.evaluate(folder);
  }

  /** Values the USER just wrote through the app ("Toujours", project settings) — only those fields:
   * a value the repository already contained is never approved this way. */
  async approveRelaxations(folder: string, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields).filter(([key]) => RELAXABLE.has(key));
    if (!entries.length) return;
    await this.change(folder, record => {
      const approved = { ...record.approved_relaxations };
      const ignored = { ...record.ignored_relaxations };
      for (const [key, value] of entries) { approved[key] = value; delete ignored[key]; }
      return { ...record, approved_relaxations: approved, ignored_relaxations: ignored };
    });
  }
}
