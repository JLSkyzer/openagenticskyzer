import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentTool } from './agent.mts';
import { metadataDirectory } from './json-store.mts';
import { defineTool } from './tool-kit.mts';

// Memory is a markdown file of timestamped entries separated by a blank line — the format
// context.mts already reads back into the model's instructions (last 4000 characters).
const ENTRY_SPLIT = /\n\n(?=<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2} -->)/;
const MAX_FACTS = 20000;
const MAX_FILE = 1024 * 1024;
const READ_LIMIT = 2 * 1024 * 1024;
const SCOPES = ['project', 'global'];

// One writer at a time per file: two concurrent saves would otherwise both read the same
// content and the second rename would silently drop the first entry.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

async function readMemory(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > READ_LIMIT) throw new Error('Mémoire illisible : fichier redirigé ou trop volumineux');
    return (await readFile(file, 'utf8')).trim();
  } catch (error: any) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/** Atomic replace (temp file + rename). An empty memory removes the file instead of leaving an empty one. */
async function writeMemory(file: string, content: string) {
  await mkdir(dirname(file), { recursive: true });
  if (!content) { await rm(file, { force: true }); return; }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

const two = (n: number) => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Persistent notes for the agent. Only these tools write memory.md; the file tools cannot reach .openagent. */
export async function memoryTools(folder: string, home: string): Promise<AgentTool[]> {
  if (!isAbsolute(folder) || !isAbsolute(home)) throw new Error('Chemins absolus requis');
  // metadataDirectory refuses a project whose .openagent was redirected by a link/junction.
  const memoryFile = async (scope: string) => (scope === 'global' ? join(home, 'memory.md') : join(await metadataDirectory(folder), 'memory.md'));
  const label = (scope: string) => (scope === 'global' ? 'globale' : 'projet');
  const scopeRule = { type: 'string' as const, enum: SCOPES, description: 'project (défaut) ou global' };

  return [
    defineTool({
      name: 'save_memory',
      description: 'Mémoriser des faits durables (préférences, décisions, conventions) pour les prochaines sessions. scope : project (défaut) ou global.',
      category: 'write',
      properties: { facts: { type: 'string', maxLength: MAX_FACTS, description: 'Faits à retenir' }, scope: scopeRule },
      required: ['facts'],
      execute: async args => {
        const facts = (args.facts as string).trim();
        const scope = (args.scope as string | undefined) ?? 'project';
        if (!facts) return 'Rien à mémoriser : texte vide.';
        const file = await memoryFile(scope);
        return serialized(file, async () => {
          const existing = await readMemory(file);
          const entry = `<!-- ${stamp()} -->\n${facts}`;
          const next = existing ? `${existing}\n\n${entry}` : entry;
          if (next.length > MAX_FILE) throw new Error('Mémoire pleine (1 Mio) : oubliez des entrées avant d’en ajouter');
          await writeMemory(file, next);
          return `✓ Mémorisé dans la mémoire ${label(scope)}.`;
        });
      },
    }),
    defineTool({
      name: 'read_memory',
      description: 'Relire la mémoire globale et la mémoire du projet.',
      category: 'read',
      properties: {},
      execute: async () => {
        const sections: string[] = [];
        const global = await readMemory(await memoryFile('global'));
        if (global) sections.push(`[Mémoire globale]\n${global}`);
        const project = await readMemory(await memoryFile('project'));
        if (project) sections.push(`[Mémoire projet]\n${project}`);
        return sections.length ? sections.join('\n\n') : 'La mémoire est vide.';
      },
    }),
    defineTool({
      name: 'forget_memory',
      description: 'Oublier les entrées de mémoire qui contiennent un mot-clé (insensible à la casse). scope : project (défaut) ou global.',
      category: 'write',
      properties: { keyword: { type: 'string', maxLength: 200, description: 'Mot-clé à retrouver' }, scope: scopeRule },
      required: ['keyword'],
      execute: async args => {
        const keyword = (args.keyword as string).trim();
        // An empty keyword is contained in every entry: it would silently wipe the whole memory.
        if (!keyword) throw new Error('Mot-clé vide');
        const scope = (args.scope as string | undefined) ?? 'project';
        const file = await memoryFile(scope);
        return serialized(file, async () => {
          const existing = await readMemory(file);
          if (!existing) return `Aucune entrée ne contient '${keyword}'.`;
          // Whole entries only: dropping just the matching line of a multi-line fact would
          // leave an orphan timestamp header or a meaningless fragment behind.
          const entries = existing.split(ENTRY_SPLIT);
          const needle = keyword.toLowerCase();
          const kept = entries.filter(entry => !entry.toLowerCase().includes(needle));
          const removed = entries.length - kept.length;
          if (!removed) return `Aucune entrée ne contient '${keyword}'.`;
          await writeMemory(file, kept.join('\n\n'));
          return `✓ ${removed} entrée(s) contenant '${keyword}' supprimée(s).`;
        });
      },
    }),
  ];
}
