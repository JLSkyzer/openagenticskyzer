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

export async function builtInTools(folder: string, dataHome: string, ignoredPatterns: string): Promise<AgentTool[]> {
  return [
    ...await workspaceTools(folder, ignoredPatterns),
    ...await memoryTools(folder, dataHome),
    ...await gitTools(folder, ignoredPatterns),
    ...projectTools(folder),
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome, ignoredPatterns),
  ];
}
