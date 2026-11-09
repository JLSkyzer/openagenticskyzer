import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import { metadataDirectory } from './json-store.mts';
import { SettingsService } from './settings.mts';

export async function buildInstructions(options: { folder: string; home: string; base: string }) {
  if (!isAbsolute(options.folder) || !isAbsolute(options.home)) throw new Error('Chemins absolus requis');
  const folder = await realpath(options.folder);
  const metadata = await metadataDirectory(folder);
  const warnings: string[] = [];
  const load = async (file: string): Promise<string | undefined> => {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Fichier redirigé ou trop volumineux');
      return (await readFile(file, 'utf8')).trim();
    } catch (e: any) {
      if (e.code !== 'ENOENT') warnings.push(`${basename(file)} non chargé (${e.code || 'format ou taille invalide'})`);
      return undefined;
    }
  };
  const blocks: string[] = [];
  for (const name of ['OPENAGENT.md', 'CLAUDE.md']) {
    const content = await load(join(folder, name));
    if (content === undefined) continue;
    if (content) blocks.push(`[INSTRUCTIONS PROJET — ${name}]\n${content.slice(0, 8000)}\n[FIN INSTRUCTIONS PROJET]`);
    break;
  }
  const settings = await new SettingsService(options.home).project(folder);
  if (settings.custom_prompt.trim()) blocks.push(`[CONTEXTE PERSONNALISÉ]\n${settings.custom_prompt.slice(0, 8000)}\n[FIN CONTEXTE PERSONNALISÉ]`);
  for (const [scope, dir] of [['GLOBALE', options.home], ['PROJET', metadata]]) {
    const memory = await load(join(dir, 'memory.md'));
    if (memory) blocks.push(`[MÉMOIRE ${scope}]\n${memory.slice(-4000)}\n[FIN MÉMOIRE]`);
  }
  const learned: string[] = [];
  const seen = new Set<string>();
  for (const dir of [metadata, options.home]) {
    const source = await load(join(dir, 'learnings.jsonl'));
    if (!source) continue;
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (!value || typeof value.id !== 'string' || typeof value.confirmed !== 'boolean' || typeof value.mistake !== 'string' || typeof value.correction !== 'string') throw new Error();
        if (!value.confirmed || seen.has(value.id)) continue;
        seen.add(value.id);
        if (learned.length < 20) learned.push(`À éviter : ${value.mistake.slice(0, 500)}\nFaire plutôt : ${value.correction.slice(0, 500)}`);
      } catch { warnings.push('Une ligne invalide de learnings.jsonl a été ignorée'); }
    }
  }
  if (learned.length) blocks.push(`[LEÇONS CONFIRMÉES]\n${learned.join('\n').slice(0, 6000)}\n[FIN LEÇONS]`);
  const prefix = blocks.join('\n\n');
  if (prefix.length > 20000) warnings.push('Contexte persistant tronqué à 20 000 caractères');
  return { instructions: [prefix.slice(0, 20000), options.base].filter(Boolean).join('\n\n'), warnings: [...new Set(warnings)] };
}
