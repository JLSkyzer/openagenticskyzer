// The built-in tools for a real project folder, in the order the model is offered them: shared by the worker
// (worker.mjs) and the bench's tool-definition count (bench/tool-tokens.mts), so both measure the same set.
// Building them starts no process.
import type { AgentTool } from './agent.mts';
import { workspaceTools } from './workspace.mts';
import { memoryTools } from './memory-tools.mts';
import { gitTools } from './git-tools.mts';
import { projectTools } from './project-analyzer.mts';
import { shellTools } from './shell-tool.mts';
import { webTools } from './web-tools.mts';
import { searchTools } from './search-tools.mts';
import { perfLevers } from './perf-levers.mts';
import { slimToolDefinitions } from './tool-texts-slim.mts';

/** `slim`: the slimmed descriptions (tool-texts-slim.mts) instead of the modules' own; the slimToolDefinitions lever by
 * default (shipped off). */
export async function builtInTools(folder: string, dataHome: string, ignoredPatterns: string, slim: boolean = perfLevers().slimToolDefinitions): Promise<AgentTool[]> {
  const tools = [
    ...await workspaceTools(folder, ignoredPatterns),
    ...await memoryTools(folder, dataHome),
    ...await gitTools(folder, ignoredPatterns),
    ...projectTools(folder),
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome, ignoredPatterns),
  ];
  return slim ? slimToolDefinitions(tools) : tools;
}
