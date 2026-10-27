// What the tool definitions cost in the prompt, in the model's own tokens: the model's chat wrapper (the one LlamaChat
// resolves for it) renders a fixed two-message history with and without the tools, and the difference of the two
// token counts is the tools' cost. Only the vocabulary is loaded (vocabOnly): no weights, no context.
// CLI: `node --experimental-strip-types bench/tool-tokens.mts --model <gguf> [--slim]` prints { slim, chars, tokens,
// perTool } for the default tool set (the built-ins in an empty temp folder, agent_mode auto, permission_mode demander);
// `--slim` counts them under the slimToolDefinitions lever (default: the lever in effect, shipped off).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveChatWrapper, type ChatHistoryItem, type ChatModelFunctions } from 'node-llama-cpp';
import type { ToolSchema } from '../core/model-types.mts';
import { toGgufFunctions } from '../core/local-provider.mts';
import { runtimeLlama, disposeLlama } from '../core/llama-runtime.mts';
import { builtInTools } from '../core/builtin-tools.mts';
import { toolSchemas, type AgentSettings } from '../core/agent.mts';
import { perfLevers } from '../core/perf-levers.mts';

/** The settings the default tool set is offered under: what a fresh install's agentSettingsOf (worker.mjs) returns. */
export const DEFAULT_TOOL_SETTINGS: AgentSettings = { mode: 'auto', permission_mode: 'demander', files_ask: true, shell_ask: true, search_ask: false };

/** `compact`: the engine's compactSchema, as the slimToolDefinitions lever applies it (default: the lever in effect). */
export async function toolDefinitionTokens(modelPath: string, tools: readonly ToolSchema[], compact: boolean = perfLevers().slimToolDefinitions): Promise<{ chars: number; tokens: number; perTool: { name: string; chars: number }[] }> {
  const llama = await runtimeLlama();
  const model = await llama.loadModel({ modelPath, vocabOnly: true });
  try {
    const wrapper = resolveChatWrapper(model);
    const history: ChatHistoryItem[] = [{ type: 'system', text: 'x' }, { type: 'user', text: 'y' }];
    // The same mapping the engine sends (local-engine.mts::completeLocal); its params are JSON schemas typed `unknown`.
    const count = (availableFunctions?: ChatModelFunctions) =>
      wrapper.generateContextState({ chatHistory: history, availableFunctions }).contextText.tokenize(model.tokenizer).length;
    return {
      chars: JSON.stringify(tools).length,
      tokens: count(toGgufFunctions(tools, compact) as ChatModelFunctions | undefined) - count(undefined),
      perTool: tools.map(tool => ({ name: tool.function.name, chars: JSON.stringify(tool).length })),
    };
  } finally {
    await model.dispose();
  }
}

/** The default tool set's schemas, built in a temp folder removed afterwards; `slim`: their slimmed texts. */
export async function defaultToolSchemas(slim: boolean = perfLevers().slimToolDefinitions): Promise<ToolSchema[]> {
  const folder = await mkdtemp(join(tmpdir(), 'openagent-bench-tools-'));
  try {
    return toolSchemas(await builtInTools(folder, folder, '', slim), DEFAULT_TOOL_SETTINGS);
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { model: { type: 'string' }, slim: { type: 'boolean' } } });
  if (!values.model) {
    console.error('Usage : bench/tool-tokens.mts --model <fichier .gguf> [--slim]');
    process.exit(2);
  }
  try {
    const slim = values.slim === true || perfLevers().slimToolDefinitions;
    console.log(JSON.stringify({ slim, ...await toolDefinitionTokens(resolve(values.model), await defaultToolSchemas(slim), slim) }, null, 2));
  } finally {
    await disposeLlama();
  }
}
