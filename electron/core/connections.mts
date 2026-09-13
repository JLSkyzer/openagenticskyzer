import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { JsonStore, metadataDirectory, object } from './json-store.mts';

export const providers = {
  openrouter: 'https://openrouter.ai/api/v1', together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1', mistral: 'https://api.mistral.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1', lmstudio: 'http://localhost:1234/v1',
  llamacpp: 'http://localhost:8080/v1',
};
export type Provider = keyof typeof providers;
interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface Profile {
  model?: string; base_url?: string; api_key?: string | null; key_endpoint?: string;
  authorized_from?: string; authorized_to?: string;
}
interface Scope { provider?: Provider; profiles: Partial<Record<Provider, Profile>> }
interface Vault { scopes: Record<string, Scope> }
interface Envelope { version: 1; payload: string }
export interface ConnectionPatch { provider: Provider; model?: string; base_url?: string; api_key?: string | null }

function providerValue(v: unknown): asserts v is Provider {
  if (typeof v !== 'string' || !Object.hasOwn(providers, v)) throw new Error('Provider invalide');
}
export function endpoint(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('URL invalide'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('URL sans identifiants, paramètres ou fragment requise');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) throw new Error('HTTPS requis hors serveur local');
  return url.toString().replace(/\/+$/, '');
}
async function envFile(path: string): Promise<Record<string, string>> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (e: any) { if (e.code === 'ENOENT') return {}; throw new Error('Configuration historique inaccessible'); }
  const result: Record<string, string> = Object.create(null);
  // No expansion and no mutation of process.env. Quoted # characters stay literal.
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]; const end = value.lastIndexOf(quote);
      if (end === 0) throw new Error('Valeur historique entre guillemets incomplète');
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

export class Connections {
  private home: string;
  private cipher: Cipher;
  private environment: Record<string, string | undefined>;
  private legacyGlobalEnv?: string;
  private store = new JsonStore();
  constructor(options: { home: string; cipher: Cipher; environment: Record<string, string | undefined>; legacyGlobalEnv?: string }) {
    if (!isAbsolute(options.home)) throw new Error('Répertoire absolu requis');
    this.home = options.home; this.cipher = options.cipher;
    this.environment = { ...options.environment }; this.legacyGlobalEnv = options.legacyGlobalEnv;
  }
  private async scopeKey(folder: string | null) {
    if (folder === null) return 'global';
    await metadataDirectory(folder);
    let canonical = await realpath(folder);
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    return createHash('sha256').update(canonical).digest('hex');
  }
  private decrypt(envelope: Envelope | undefined): Vault {
    if (envelope === undefined) return { scopes: {} };
    if (!this.cipher.isEncryptionAvailable()) throw new Error('Chiffrement système indisponible');
    try {
      if (envelope.version !== 1 || typeof envelope.payload !== 'string') throw new Error();
      const vault = JSON.parse(this.cipher.decryptString(Buffer.from(envelope.payload, 'base64')));
      object(vault.scopes);
      for (const [key, scope] of Object.entries(vault.scopes) as [string, Scope][]) {
        if (key !== 'global' && !/^[a-f0-9]{64}$/.test(key)) throw new Error();
        object(scope); object(scope.profiles);
        if (scope.provider !== undefined) providerValue(scope.provider);
        for (const [name, profile] of Object.entries(scope.profiles)) {
          providerValue(name); object(profile);
          for (const [field, value] of Object.entries(profile)) {
            if (!['model', 'base_url', 'api_key', 'key_endpoint', 'authorized_from', 'authorized_to'].includes(field)) throw new Error();
            if (typeof value !== 'string' && !(field === 'api_key' && value === null)) throw new Error();
          }
        }
      }
      return vault;
    } catch { throw new Error('Coffre illisible ou verrouillé. Les données sont conservées.'); }
  }
  private async vault() { return this.decrypt(await this.store.read<Envelope | undefined>(join(this.home, 'connections.v1.json'), undefined)); }
  private async legacy(folder: string | null) {
    const [globalEnv, localEnv, globalConfig, localConfig] = await Promise.all([
      this.legacyGlobalEnv ? envFile(this.legacyGlobalEnv) : {} as Record<string, string>,
      folder ? envFile(join(folder, '.env')) : {} as Record<string, string>,
      this.store.read<Record<string, unknown>>(join(this.home, 'config.json'), {}),
      folder ? this.store.read<Record<string, unknown>>(join(await metadataDirectory(folder), 'config.json'), {}) : {},
    ]);
    object(globalConfig); object(localConfig);
    return { globalEnv: { ...this.environment, ...globalEnv }, localEnv, globalConfig, localConfig };
  }
  private async compose(folder: string | null, vault: Vault, allowUnbound = false) {
    const key = await this.scopeKey(folder);
    const local = folder ? vault.scopes[key] : undefined;
    const global = vault.scopes.global;
    const legacy = await this.legacy(folder);
    const detected = Object.keys(providers).find(p => legacy.localEnv[p.toUpperCase() + '_API_KEY'] || legacy.localEnv[p.toUpperCase() + '_MODEL'])
      ?? Object.keys(providers).find(p => legacy.globalEnv[p.toUpperCase() + '_API_KEY'] || legacy.globalEnv[p.toUpperCase() + '_MODEL']);
    const selected = local?.provider ?? global?.provider ?? legacy.localConfig.current_provider ?? legacy.globalConfig.current_provider ?? detected ?? 'openrouter';
    providerValue(selected);
    const p = local?.profiles[selected] ?? {}; const g = global?.profiles[selected] ?? {};
    const prefix = selected.toUpperCase();
    const legacyEndpoint = (env: Record<string, string | undefined>) => {
      const base = env[prefix + '_BASE_URL'] || env.OPENAI_BASE_URL || providers[selected];
      return endpoint(selected === 'ollama' && !base.replace(/\/+$/, '').endsWith('/v1') ? base.replace(/\/+$/, '') + '/v1' : base);
    };
    const base_url = endpoint(p.base_url ?? g.base_url ?? (legacy.localEnv[prefix + '_BASE_URL'] || legacy.localEnv.OPENAI_BASE_URL ? legacyEndpoint(legacy.localEnv) : legacyEndpoint(legacy.globalEnv)));
    const model = p.model ?? g.model ?? (legacy.localConfig.current_provider === selected ? legacy.localConfig.current_model as string : undefined)
      ?? legacy.localEnv[prefix + '_MODEL']?.split(',')[0].trim() ?? legacy.globalEnv[prefix + '_MODEL']?.split(',')[0].trim() ?? '';
    let api_key = ''; let key_endpoint = base_url; let key_source = 'none';
    if (Object.hasOwn(p, 'api_key')) { api_key = p.api_key ?? ''; key_endpoint = p.key_endpoint ?? providers[selected]; key_source = 'project'; }
    else if (Object.hasOwn(g, 'api_key')) { api_key = g.api_key ?? ''; key_endpoint = g.key_endpoint ?? providers[selected]; key_source = 'global'; }
    else if (legacy.localEnv[prefix + '_API_KEY']) { api_key = legacy.localEnv[prefix + '_API_KEY']; key_endpoint = legacyEndpoint(legacy.localEnv); key_source = 'legacy-project'; }
    else if (legacy.globalEnv[prefix + '_API_KEY']) { api_key = legacy.globalEnv[prefix + '_API_KEY']!; key_endpoint = legacyEndpoint(legacy.globalEnv); key_source = 'legacy-global'; }
    const authorization = folder ? p : g;
    if (api_key && key_endpoint !== base_url && !(authorization.authorized_from === key_endpoint && authorization.authorized_to === base_url) && !allowUnbound) {
      throw new Error('Confirmation requise avant de transmettre la clé à une autre URL');
    }
    return { provider: selected, model, base_url, api_key, key_endpoint, key_source,
      legacy_plaintext: Boolean(legacy.localEnv[prefix + '_API_KEY'] || legacy.globalEnv[prefix + '_API_KEY']),
      model_source: p.model !== undefined ? 'project' : g.model !== undefined ? 'global' : 'legacy',
    };
  }
  /** Main/agent boundary only. Never forward this result to the renderer. */
  async resolve(folder: string | null) { return this.compose(folder, await this.vault()); }
  async snapshot(folder: string | null) {
    const { api_key, key_endpoint, ...publicValue } = await this.resolve(folder);
    return { ...publicValue, key_configured: Boolean(api_key) };
  }
  async save(folder: string | null, patch: ConnectionPatch, authorization: { confirmEndpoint?: boolean } = {}) {
    object(patch); providerValue(patch.provider);
    for (const field of Object.keys(patch)) if (!['provider', 'model', 'base_url', 'api_key'].includes(field)) throw new Error('Champ connexion inconnu');
    for (const field of ['model', 'base_url', 'api_key'] as const) {
      const value = patch[field];
      if (value !== undefined && !(field === 'api_key' && value === null) && (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value))) throw new Error('Valeur connexion invalide');
    }
    if (!this.cipher.isEncryptionAvailable()) throw new Error('Chiffrement système indisponible');
    const key = await this.scopeKey(folder);
    await this.store.update<Envelope | undefined>(join(this.home, 'connections.v1.json'), undefined, async envelope => {
      const vault = this.decrypt(envelope);
      const scope = vault.scopes[key] ??= { profiles: {} };
      scope.provider = patch.provider;
      const before = await this.compose(folder, vault, true);
      const profile = scope.profiles[patch.provider] ??= {};
      if (patch.model !== undefined) profile.model = patch.model.trim();
      if (patch.base_url !== undefined) profile.base_url = endpoint(patch.base_url);
      const candidate = await this.compose(folder, vault, true);
      if (before.api_key && before.base_url !== candidate.base_url && !authorization.confirmEndpoint) throw new Error('Confirmation requise avant de changer l’URL associée à une clé');
      if (patch.api_key !== undefined) {
        profile.api_key = patch.api_key === null ? null : patch.api_key.trim();
        profile.key_endpoint = candidate.base_url;
      } else if (candidate.api_key && candidate.key_endpoint !== candidate.base_url && !(profile.authorized_from === candidate.key_endpoint && profile.authorized_to === candidate.base_url)) {
        if (!authorization.confirmEndpoint) throw new Error('Confirmation requise pour la clé héritée');
        profile.authorized_from = candidate.key_endpoint; profile.authorized_to = candidate.base_url;
      }
      return { version: 1, payload: this.cipher.encryptString(JSON.stringify(vault)).toString('base64') };
    });
    return this.snapshot(folder);
  }
}
