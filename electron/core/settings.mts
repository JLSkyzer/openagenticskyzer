import { join, isAbsolute } from 'node:path';
import { JsonStore, metadataDirectory, object } from './json-store.mts';

export const globalDefaults = {
  agent_mode: 'auto', auto_compact: true, compact_threshold: 70,
  max_tokens: null as number | null, reserved_tokens: 2048, show_context_bar: true,
  session_retention_days: 30, animations: true, restore_last_folder: true,
  // Writes (files, git, memory) ask by default since 2026-10-03, as Python's "demander" did; web search does not.
  permission_mode: 'demander', shell_ask: true, files_ask: true, search_ask: false,
  data_dir: '', theme: 'dark', accent_color: '#3b82f6', onboarding_done: false,
  // Which entry of the .gguf library (gguf-library.mts) is the active model, if any — empty means a
  // remote connection is active instead. Not a secret (unlike connections.mts's vault): just an id.
  active_local_model: '',
};
export const projectDefaults = {
  agent_mode: 'inherit', ignored_patterns: 'node_modules/, .env, dist/',
  custom_prompt: '', override_permissions: false,
};
type Config = Record<string, any>;
type Rule = (v: unknown) => boolean;
const choice = (...values: unknown[]): Rule => v => values.includes(v);
const bool: Rule = v => typeof v === 'boolean';
const text = (max: number): Rule => v => typeof v === 'string' && v.length <= max && !v.includes('\0');
const integer = (min: number, max: number): Rule => v => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
const permissionRules = {
  permission_mode: choice('demander', 'auto', 'strict'), shell_ask: bool, files_ask: bool, search_ask: bool,
};
const globalRules: Record<string, Rule> = {
  agent_mode: choice('ask', 'auto', 'plan'), auto_compact: bool, compact_threshold: integer(40, 95),
  max_tokens: v => v === null || integer(2048, 2097152)(v), reserved_tokens: integer(1, 65536),
  show_context_bar: bool, session_retention_days: choice(0, 7, 30, 90), animations: bool,
  restore_last_folder: bool, ...permissionRules,
  data_dir: text(1000), hf_token: text(1000),
  // Data directory changes have a separate, transactional migration operation.
  theme: choice('dark', 'light'), accent_color: v => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v),
  onboarding_done: bool,
  active_local_model: text(200),
};
const projectRules: Record<string, Rule> = {
  agent_mode: choice('inherit', 'ask', 'auto', 'plan'), ignored_patterns: text(10000),
  custom_prompt: text(50000), override_permissions: bool, ...permissionRules,
};

export type Relaxations = Record<string, { project: unknown; global: unknown }>;
/** Fields a project can use to make the agent MORE permissive than the global settings. */
export const RELAXABLE_KEYS: readonly string[] = [...Object.keys(permissionRules), 'agent_mode'];
const PERMISSION_MODE_RANK: Record<string, number> = { auto: 0, demander: 1, strict: 2 };
const READ_ONLY_MODES = new Set(['ask', 'plan']);

/** True when using `project` for `key` instead of `global` would make the agent more permissive. */
function isRelaxation(key: string, project: unknown, global: unknown): boolean {
  if (key === 'shell_ask' || key === 'files_ask' || key === 'search_ask') return project === false && global === true;
  if (key === 'permission_mode') return PERMISSION_MODE_RANK[String(project)] < PERMISSION_MODE_RANK[String(global)];
  if (key === 'agent_mode') return project === 'auto' && READ_ONLY_MODES.has(String(global));
  return false;
}

/** What a project's own config.json would relax, field by field — the part a repository could ship to
 * switch off confirmations. A stricter-or-equal value is not listed: it needs no approval. */
export function relaxationsOf(global: Config, project: Config): Relaxations {
  const result: Relaxations = {};
  if (project.override_permissions) {
    for (const key of Object.keys(permissionRules)) {
      if (Object.hasOwn(project, key) && isRelaxation(key, project[key], global[key])) {
        result[key] = { project: project[key], global: global[key] };
      }
    }
  }
  if (project.agent_mode !== 'inherit' && isRelaxation('agent_mode', project.agent_mode, global.agent_mode)) {
    result.agent_mode = { project: project.agent_mode, global: global.agent_mode };
  }
  return result;
}

function validatePatch(patch: unknown, rules: Record<string, Rule>) {
  object(patch);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(rules, key) || !rules[key](value)) throw new Error(`Paramètre invalide : ${key}`);
  }
}
function validateContext(config: Config) {
  if (config.max_tokens !== null && config.reserved_tokens >= config.max_tokens) {
    throw new Error('Les tokens réservés doivent être inférieurs à la limite de contexte');
  }
}
function validateSaved(saved: Config, rules: Record<string, Rule>) {
  for (const [key, value] of Object.entries(saved)) {
    if (Object.hasOwn(rules, key) && !rules[key](value)) throw new Error(`Paramètre historique invalide : ${key}`);
  }
}
export class SettingsService {
  readonly home: string;
  private store = new JsonStore();
  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error('Répertoire de données absolu requis');
    this.home = home;
  }
  async global(): Promise<Config> {
    const saved = await this.store.read(join(this.home, 'config.json'), {});
    object(saved);
    validateSaved(saved, globalRules);
    return { ...globalDefaults, ...saved };
  }
  async project(folder: string): Promise<Config> {
    const saved = await this.store.read(join(await metadataDirectory(folder), 'config.json'), {});
    object(saved);
    validateSaved(saved, projectRules);
    return { ...projectDefaults, ...saved };
  }
  async publicGlobal() {
    const saved = await this.global();
    const result: Config = {};
    for (const key of Object.keys(globalDefaults)) result[key] = saved[key];
    result.hf_token_configured = typeof saved.hf_token === 'string' && saved.hf_token.length > 0;
    // The real, currently-resolved absolute data directory — distinct from the `data_dir` setting
    // above (an inert display field the migration operation itself never needs to read or write).
    result.data_home = this.home;
    // OPENAGENT_SKIP_ONBOARDING=1 reports the first-launch wizard as already done WITHOUT writing anything: the
    // tests (which all start on an empty data directory) set it so the wizard does not cover the interface they
    // drive. Here, in the one place every reader of the global settings goes through — the worker AND the tests
    // that use this service directly. Only the exact value "1" counts, and it can only ever mean "done".
    if (process.env.OPENAGENT_SKIP_ONBOARDING === '1') result.onboarding_done = true;
    return result;
  }
  async saveGlobal(patch: Config) {
    validatePatch(patch, globalRules);
    await this.store.update<Config>(join(this.home, 'config.json'), {}, saved => {
      object(saved);
      const result = { ...saved, ...patch };
      validateContext({ ...globalDefaults, ...result });
      return result;
    });
    return this.global();
  }
  /** Drops every custom global value (secrets included) so all defaults apply again. */
  async resetGlobal() {
    await this.store.update<Config>(join(this.home, 'config.json'), {}, () => ({}));
    return this.publicGlobal();
  }
  async saveProject(folder: string, patch: Config) {
    validatePatch(patch, projectRules);
    await this.store.update<Config>(join(await metadataDirectory(folder), 'config.json'), {}, saved => {
      object(saved); return { ...saved, ...patch };
    });
    return this.project(folder);
  }
  /** A project value applies when it is stricter-or-equal to the global one, or when it is a
   * relaxation the user approved at exactly this value (core/project-trust.mts). Without
   * `approvedRelaxations`, no relaxation applies: a repository cannot ship its own permissions. */
  async effective(folder: string, { approvedRelaxations = {} }: { approvedRelaxations?: Record<string, unknown> } = {}) {
    const [global, project] = await Promise.all([this.global(), this.project(folder)]);
    const result = { ...global, ...project };
    const allowed = (key: string, value: unknown) => !isRelaxation(key, value, global[key]) || approvedRelaxations[key] === value;
    for (const key of Object.keys(permissionRules)) {
      const fromProject = project.override_permissions && Object.hasOwn(project, key) && allowed(key, project[key]);
      result[key] = fromProject ? project[key] : global[key];
    }
    const mode = project.agent_mode === 'inherit' ? global.agent_mode : project.agent_mode;
    result.agent_mode = allowed('agent_mode', mode) ? mode : global.agent_mode;
    return result;
  }
}
