'use strict';
// The data home, resolved in ONE place for both processes: main.cjs (the connections vault) requires it, worker.mjs
// (everything else) and core/data-dir.mts import it. CommonJS on purpose: main.cjs loads it with a plain require(), so
// the packaged app needs no dynamic import of a TypeScript module at startup to find the vault. Packaged by the
// `core/**/*` entry of build.files.
const { lstat, readFile } = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');

const REDIRECT_FILE = 'redirect.json';

/** An error about the redirect file itself; `redirectFile` lets main.cjs tell the user exactly which file to fix. */
function redirectError(file, error) {
  const result = error instanceof Error ? error : new Error(String(error));
  result.redirectFile = file;
  return result;
}

/**
 * The real data home behind the fixed default location: the absolute `data_dir` of `<defaultHome>/redirect.json`
 * (written by core/data-dir.mts::migrateDataDir, Réglages › Général › Répertoire de données), or `defaultHome`
 * itself when there is no redirect. Reads the pointer as core/json-store.mts reads any data file: a missing file is
 * "no redirect"; a non-regular file or unreadable JSON is an error naming the file (`error.redirectFile`), never
 * silently replaced by the default — a vault or a history written to the wrong folder would look like lost data.
 */
async function resolveDataHome(defaultHome) {
  const file = path.join(defaultHome, REDIRECT_FILE);
  let raw;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Fichier de données non régulier : ${file}`);
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultHome;
    throw redirectError(file, error);
  }
  let pointer;
  try { pointer = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw redirectError(file, new Error(`JSON illisible : ${file}. Le fichier est conservé.`)); }
  const dataDir = pointer && typeof pointer === 'object' && typeof pointer.data_dir === 'string' ? pointer.data_dir : '';
  return dataDir && path.isAbsolute(dataDir) ? dataDir : defaultHome;
}

/**
 * `defaultHome` is the fixed location that holds the redirect: `~/.openagent`, or OPENAGENT_HOME when it is set
 * (tests only — it replaces that whole location, so a test never reads the real one, redirect included).
 * `dataHome` is where the data really lives. `env` and `userHome` are parameters for tests only.
 */
async function resolveHomes(env = process.env, userHome = homedir()) {
  const defaultHome = env.OPENAGENT_HOME || path.join(userHome, '.openagent');
  return { defaultHome, dataHome: await resolveDataHome(defaultHome) };
}

module.exports = { REDIRECT_FILE, resolveDataHome, resolveHomes };
