import { join, isAbsolute } from 'node:path';
import { JsonStore, metadataDirectory, object } from './json-store.mts';

export const globalDefaults = {
  agent_mode: 'auto', auto_compact: true, compact_threshold: 70,
  max_tokens: null as number | null, reserved_tokens: 2048, show_context_bar: true,
  session_retention_days: 30, animations: true, restore_last_folder: true,
  permission_mode: 'demander', shell_ask: true, files_ask: false, search_ask: false,
  data_dir: '', theme: 'dark', accent_color: '#3b82f6', onboarding_done: false,
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
  // Data directory changes have a separate, transactional migration operation.
  theme: choice('dark', 'light'), accent_color: v => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v),
  onboarding_done: bool,
};
const projectRules: Record<string, Rule> = {
  agent_mode: choice('inherit', 'ask', 'auto', 'plan'), ignored_patterns: text(10000),
  custom_prompt: text(50000), override_permissions: bool, ...permissionRules,
};

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
  async saveProject(folder: string, patch: Config) {
    validatePatch(patch, projectRules);
    await this.store.update<Config>(join(await metadataDirectory(folder), 'config.json'), {}, saved => {
      object(saved); return { ...saved, ...patch };
    });
    return this.project(folder);
  }
  async effective(folder: string) {
    const [global, project] = await Promise.all([this.global(), this.project(folder)]);
    const result = { ...global, ...project };
    result.agent_mode = project.agent_mode === 'inherit' ? global.agent_mode : project.agent_mode;
    if (!project.override_permissions) {
      for (const key of Object.keys(permissionRules)) result[key] = global[key];
    }
    return result;
  }
}
