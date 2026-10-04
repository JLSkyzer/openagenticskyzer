import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOL_NAME_PATTERN, type AgentTool } from './agent.mts';
import { metadataDirectory } from './json-store.mts';
import { defineTool, type ToolSpec } from './tool-kit.mts';

const PLUGIN_EXTENSIONS = new Set(['.mjs', '.mts']);

export interface PluginLoadResult {
  tools: AgentTool[];
  errors: string[];
}

async function pluginDirectories(folder: string | null, home: string): Promise<string[]> {
  const candidates = [join(home, 'tools')];
  if (folder) {
    candidates.push(join(folder, 'tools'));
    try { candidates.push(join(await metadataDirectory(folder), 'tools')); }
    catch { /* folder invalid/redirected — the other two directories still get scanned */ }
  }
  // Two paths can name one physical directory (a project opened at the parent of the data
  // folder: <projet>/.openagent/tools IS <home>/tools). Scanning it twice would register every
  // tool in it twice — Python's loader guards the same way with its `seen` set.
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of candidates) {
    let key = dir;
    try { key = await realpath(dir); }
    catch { /* not there yet: not a duplicate, pluginFiles() skips it */ }
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/** The files of `dir` a plugin can be: no hidden file, no __init__* (a missing directory is just empty). */
async function directoryFiles(dir: string): Promise<import('node:fs').Dirent[]> {
  try { return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('__init__')); }
  catch { return []; }
}

async function pluginFiles(dir: string): Promise<string[]> {
  return (await directoryFiles(dir))
    .filter(entry => PLUGIN_EXTENSIONS.has(extname(entry.name)))
    .map(entry => join(dir, entry.name))
    .sort();
}

/** The previous app's Python plugins in `dir`, selected like the .mjs ones — never imported, never executed: only
 * reported so the user knows they must be ported (parity row 32). */
async function pythonPluginFiles(dir: string): Promise<string[]> {
  return (await directoryFiles(dir))
    .filter(entry => extname(entry.name).toLowerCase() === '.py')
    .map(entry => join(dir, entry.name))
    .sort();
}

export function pythonPluginError(name: string): string {
  return `Plugin Python non pris en charge : ${name} — à réécrire en .mjs`;
}

/** A name runAgent would refuse must fail HERE, as this file's own error: runAgent refuses the
 * whole tool list, so one bad plugin name would otherwise fail every turn in every project. */
function isValidSpec(value: unknown): value is ToolSpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as Record<string, unknown>;
  return typeof spec.name === 'string' && TOOL_NAME_PATTERN.test(spec.name) && typeof spec.execute === 'function';
}

/** Node caches an ES module by URL for the whole process: the same URL after an edit returns the
 * old module (or its old top-level error) forever. Keying the URL on the file's mtime/size makes
 * an edit a new URL. Each edit leaves its previous instance in memory — Node cannot evict one —
 * which is fine for files reloaded a few times per session. Only the plugin file itself is
 * re-imported: a helper module it imports is still cached. */
async function freshImport(file: string) {
  const { mtimeMs, size } = await stat(file);
  return import(`${pathToFileURL(file).href}?v=${mtimeMs}-${size}`);
}

/**
 * Loads agent tools from user-authored plugin files — the Node-native equivalent of Python's
 * plugins/loader.py (same 3 scan directories: global, project/tools, project/.openagent/tools —
 * the last two skipped when `folder` is null, matching Python's own `if folder:` guard). A plugin
 * file exports getTools() returning ToolSpec-shaped objects (core/tool-kit.mts, the same contract
 * every internal tool already uses) and an optional onLoad(folder) hook. The category a plugin
 * declares is always ignored and forced to 'extension' — the same trust level MCP tools already
 * get, since a plugin is arbitrary, unsandboxed code that must never self-declare 'read' to skip
 * permission confirmation. One broken plugin file is isolated and never blocks the others; a file
 * reusing a name an earlier file (in scan order) already registered is rejected whole, like any
 * other invalid file.
 */
export async function loadPlugins(
  folder: string | null,
  home: string,
  { includeProject = true, projectPython = includeProject }: { includeProject?: boolean; projectPython?: boolean } = {},
): Promise<PluginLoadResult> {
  if (!isAbsolute(home)) throw new Error('Chemins absolus requis');
  if (folder !== null && !isAbsolute(folder)) throw new Error('Chemins absolus requis');
  const tools: AgentTool[] = [];
  const errors: string[] = [];
  const registered = new Set<string>();
  // A project not approved yet (core/project-trust.mts): its directories are not even scanned —
  // importing a file runs its top-level code.
  // `projectPython`: the project's folders are still LISTED for .py files to report — never imported, never run.
  const allDirs = includeProject || projectPython ? await pluginDirectories(folder, home) : [join(home, 'tools')];
  const globalDir = join(home, 'tools');
  for (const dir of allDirs) {
    const imported = includeProject || dir === globalDir;
    for (const file of imported ? await pluginFiles(dir) : []) {
      try {
        const module = await freshImport(file);
        if (typeof module.getTools !== 'function') throw new Error('pas de fonction getTools()');
        const loaded = await module.getTools();
        if (!Array.isArray(loaded)) throw new Error('getTools() doit retourner un tableau');
        const fileTools = loaded.map((spec: unknown) => {
          if (!isValidSpec(spec)) throw new Error('getTools() contient un outil invalide');
          return defineTool({ ...(spec as ToolSpec), category: 'extension' });
        });
        const names = new Set<string>();
        for (const tool of fileTools) {
          if (registered.has(tool.name) || names.has(tool.name)) throw new Error(`nom d'outil déjà utilisé : ${tool.name}`);
          names.add(tool.name);
        }
        tools.push(...fileTools);
        for (const name of names) registered.add(name);
        if (typeof module.onLoad === 'function' && folder) await module.onLoad(folder);
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
      }
    }
    for (const file of await pythonPluginFiles(dir)) errors.push(pythonPluginError(basename(file)));
  }
  return { tools, errors };
}

/** The plugin files a project itself brings (its tools/ and .openagent/tools/), selected exactly as
 * loadPlugins selects them and listed WITHOUT importing anything — what core/project-trust.mts
 * fingerprints and shows. A project directory that is physically <home>/tools is global content. */
export async function projectPluginFiles(folder: string, home: string): Promise<string[]> {
  return (await Promise.all((await projectDirectories(folder, home)).map(pluginFiles))).flat();
}

/** The legacy .py plugins a project brings, from the same directories — what the Outils tab lists, like a .mjs, as not
 * loaded while the project is not approved. Never fingerprinted by core/project-trust.mts: a .py never runs. */
export async function projectPythonPluginFiles(folder: string, home: string): Promise<string[]> {
  return (await Promise.all((await projectDirectories(folder, home)).map(pythonPluginFiles))).flat();
}

async function projectDirectories(folder: string, home: string): Promise<string[]> {
  if (!isAbsolute(home) || !isAbsolute(folder)) throw new Error('Chemins absolus requis');
  const globalDir = join(home, 'tools');
  return (await pluginDirectories(folder, home)).filter(dir => dir !== globalDir);
}
