import { createHash } from 'node:crypto';
import { readFile, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { JsonStore } from './json-store.mts';
import { projectPluginFiles } from './plugin-loader.mts';
import { readProjectMcpConfig, type McpServerConfig } from './mcp-config.mts';
import { RELAXABLE_KEYS, relaxationsOf, type Relaxations, type SettingsService } from './settings.mts';

export type TrustState = 'none' | 'pending' | 'trusted' | 'ignored';
export type TrustDecision = 'trusted' | 'ignored';
export interface ProjectInventory { plugins: string[]; mcpServers: McpServerConfig[]; relaxations: Relaxations }
export interface ProjectTrust {
  state: TrustState;
  /** A content decision exists, but for another fingerprint: the plugins/.mcp.json changed since. */
  changed: boolean;
  /** What the user was shown. decide() refuses a token that no longer matches the project. */
  token: string;
  contentTrusted: boolean;
  approvedRelaxations: Record<string, unknown>;
  inventory: ProjectInventory;
}
interface TrustRecord {
  content?: { decision: TrustDecision; fingerprint: string; decided_at: string };
  approved_relaxations?: Record<string, unknown>;
  ignored_relaxations?: Record<string, unknown>;
}
type Registry = Record<string, TrustRecord>;
type ContentStatus = 'none' | 'pending' | TrustDecision;

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
  const mcpServers = await readProjectMcpConfig(folder, { expandEnv: false });
  // An .mcp.json that yields no valid server starts nothing: inert, nothing to approve.
  if (mcpServers.length) parts.push(['.mcp.json', await readFile(join(folder, '.mcp.json'))]);
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
    try { scan = await scanContent(folder, this.home); }
    catch (error) { console.error(`[trust] contenu du projet illisible, non approuvé : ${error instanceof Error ? error.message : error}`); }
    const record = await this.recordFor(folder);
    const fingerprint = scan?.fingerprint ?? null;
    const contentStatus: ContentStatus =
      scan === null ? 'pending'
      : fingerprint === null ? 'none'
      : record.content?.fingerprint === fingerprint ? record.content.decision
      : 'pending';
    const approved = record.approved_relaxations ?? {};
    const ignored = record.ignored_relaxations ?? {};
    const entries = Object.entries(relaxations);
    const pendingRelaxation = entries.some(([key, { project: value }]) => approved[key] !== value && ignored[key] !== value);
    const refusedRelaxation = entries.some(([key, { project: value }]) => approved[key] !== value && ignored[key] === value);
    const state: TrustState =
      contentStatus === 'none' && entries.length === 0 ? 'none'
      : contentStatus === 'pending' || pendingRelaxation ? 'pending'
      : contentStatus === 'ignored' || refusedRelaxation ? 'ignored'
      : 'trusted';
    const trust: ProjectTrust = {
      state,
      changed: scan !== null && fingerprint !== null && record.content !== undefined && record.content.fingerprint !== fingerprint,
      token: createHash('sha256').update(JSON.stringify([fingerprint, scan === null, relaxations])).digest('hex'),
      contentTrusted: contentStatus === 'trusted',
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
