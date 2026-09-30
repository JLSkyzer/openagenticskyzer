import { readdir } from 'node:fs/promises';
import { isAbsolute, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentTool } from './agent.mts';
import { metadataDirectory } from './json-store.mts';
import { defineTool, type ToolSpec } from './tool-kit.mts';

const PLUGIN_EXTENSIONS = new Set(['.mjs', '.mts']);

export interface PluginLoadResult {
  tools: AgentTool[];
  errors: string[];
}

async function pluginDirectories(folder: string | null, home: string): Promise<string[]> {
  const dirs = [join(home, 'tools')];
  if (folder) {
    dirs.push(join(folder, 'tools'));
    try { dirs.push(join(await metadataDirectory(folder), 'tools')); }
    catch { /* folder invalid/redirected — the other two directories still get scanned */ }
  }
  return dirs;
}

async function pluginFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter(entry => entry.isFile() && PLUGIN_EXTENSIONS.has(extname(entry.name)) && !entry.name.startsWith('.') && !entry.name.startsWith('__init__'))
    .map(entry => join(dir, entry.name))
    .sort();
}

function isValidSpec(value: unknown): value is ToolSpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as Record<string, unknown>;
  return typeof spec.name === 'string' && spec.name.length > 0 && typeof spec.execute === 'function';
}

/**
 * Loads agent tools from user-authored plugin files — the Node-native equivalent of Python's
 * plugins/loader.py (same 3 scan directories: global, project/tools, project/.openagent/tools —
 * the last two skipped when `folder` is null, matching Python's own `if folder:` guard). A plugin
 * file exports getTools() returning ToolSpec-shaped objects (core/tool-kit.mts, the same contract
 * every internal tool already uses) and an optional onLoad(folder) hook. The category a plugin
 * declares is always ignored and forced to 'extension' — the same trust level MCP tools already
 * get, since a plugin is arbitrary, unsandboxed code that must never self-declare 'read' to skip
 * permission confirmation. One broken plugin file is isolated and never blocks the others.
 */
export async function loadPlugins(folder: string | null, home: string): Promise<PluginLoadResult> {
  if (!isAbsolute(home)) throw new Error('Chemins absolus requis');
  if (folder !== null && !isAbsolute(folder)) throw new Error('Chemins absolus requis');
  const tools: AgentTool[] = [];
  const errors: string[] = [];
  for (const dir of await pluginDirectories(folder, home)) {
    for (const file of await pluginFiles(dir)) {
      try {
        const module = await import(pathToFileURL(file).href);
        if (typeof module.getTools !== 'function') throw new Error('pas de fonction getTools()');
        const loaded = await module.getTools();
        if (!Array.isArray(loaded)) throw new Error('getTools() doit retourner un tableau');
        const fileTools = loaded.map((spec: unknown) => {
          if (!isValidSpec(spec)) throw new Error('getTools() contient un outil invalide');
          return defineTool({ ...(spec as ToolSpec), category: 'extension' });
        });
        tools.push(...fileTools);
        if (typeof module.onLoad === 'function' && folder) await module.onLoad(folder);
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : 'Erreur inconnue'}`);
      }
    }
  }
  return { tools, errors };
}
