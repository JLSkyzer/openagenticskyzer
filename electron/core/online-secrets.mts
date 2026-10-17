// Startup erasure of the online-provider secrets that earlier versions left in the data home (local-only models,
// spec objective 3). main.cjs::prepareDataHome runs it at every start, before the worker exists, so no write to these
// files can be in flight. It is idempotent: once everything is gone, a run reads the folder and changes nothing.
//
// Erased: the connections vault (connections.v1.json) with its JsonStore copies (pre-Electron backup and temp files),
// and the keys current_provider / current_model of the global config.json AND of its pre-Electron backup — that
// backup is cleaned, never deleted. hf_token is a kept setting (the Hugging Face token): it is never erased.
// The user's projects' .env files are never opened, and nothing outside the data home is read.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonStore } from './json-store.mts';

export const ERASED_CONFIG_KEYS = ['current_provider', 'current_model'] as const; // hf_token is a kept setting, never erased

export interface ErasureReport { removed: string[]; cleaned: string[]; errors: string[] }

const VAULT_FILE = /^connections\.v1\.json(\.pre-electron\.bak|\.[0-9a-f-]{36}\.tmp)?$/i;
const CONFIG_TEMP = /^config\.json\.[0-9a-f-]{36}\.tmp$/i;
const CONFIG_FILES = ['config.json', 'config.json.pre-electron.bak'];

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The same object, key order kept, without the erased keys. */
function without(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(ERASED_CONFIG_KEYS as readonly string[]).includes(key)));
}

/** Never throws: every failure is reported in `errors` as "<name> : <reason>", and retried at the next start. */
export async function eraseOnlineSecrets(dataHome: string): Promise<ErasureReport> {
  const report: ErasureReport = { removed: [], cleaned: [], errors: [] };
  let names: string[];
  try { names = await readdir(dataHome); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') report.errors.push(`${dataHome} : ${reason(error)}`);
    return report;
  }

  // Whatever their content (encrypted, corrupt or empty). Not recursive: a directory in their place is reported.
  for (const name of names.filter(name => VAULT_FILE.test(name))) {
    try { await rm(join(dataHome, name)); report.removed.push(name); }
    catch (error) { report.errors.push(`${name} : ${reason(error)}`); }
  }

  // Orphans of an interrupted config.json write: one may still hold the erased keys.
  for (const name of names.filter(name => CONFIG_TEMP.test(name))) {
    try { await rm(join(dataHome, name)); report.removed.push(name); }
    catch (error) { report.errors.push(`${name} : ${reason(error)}`); }
  }

  const store = new JsonStore();
  for (const name of CONFIG_FILES) {
    const file = join(dataHome, name);
    try {
      const value = await store.read<unknown>(file, null); // unreadable JSON throws: the file is kept as is
      if (!plainObject(value) || !ERASED_CONFIG_KEYS.some(key => Object.hasOwn(value, key))) continue;
      // backup: false, or JsonStore would first copy the file — keys included — to <file>.pre-electron.bak.
      await store.update<unknown>(file, {}, current => (plainObject(current) ? without(current) : current), { backup: false });
      report.cleaned.push(name);
    } catch (error) { report.errors.push(`${name} : ${reason(error)}`); }
  }
  return report;
}
