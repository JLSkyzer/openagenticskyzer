'use strict';
// `<dataHome>/logs/turns`, the turn log's folder, checked in ONE place for both processes (M-e): core/turn-log.mts (the
// worker's writer and prune) imports it, and main.cjs (« Ouvrir le dossier des journaux ») requires it. CommonJS for
// the same reason as core/data-home.cjs: main.cjs loads it with a plain require(). Packaged by the `core/**/*` entry of
// build.files.
const { lstat, mkdir } = require('node:fs/promises');
const path = require('node:path');

/**
 * `<dataHome>/logs/turns`, once `logs` and `logs/turns` are checked to be real folders — never a link or a junction,
 * whose target could be outside the data home (the prune would delete there, the writer write there, the « Ouvrir »
 * button open there). `create` makes what is missing, one level at a time; without it, a missing folder gives null.
 * Throws for anything else.
 * @param {string} dataHome
 * @param {{ create: boolean }} options
 * @returns {Promise<string | null>}
 */
async function realLogDir(dataHome, { create }) {
  let dir = dataHome;
  for (const name of ['logs', 'turns']) {
    dir = path.join(dir, name);
    let stats;
    try { stats = await lstat(dir); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!create) return null;
      await mkdir(dir).catch(made => { if (made?.code !== 'EEXIST') throw made; });
      stats = await lstat(dir);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${dir} n'est pas un vrai dossier : rien n'y est écrit, supprimé ni ouvert`);
  }
  return dir;
}

module.exports = { realLogDir };
