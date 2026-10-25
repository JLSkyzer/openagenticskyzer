// Where the project context goes in a local model's prompt (Task 4, lever `contextPlacement`). Today it heads the system
// text, before the tool block: any change to it (save_memory, a compaction note, the memory's last 4 000 characters
// sliding) makes the engine read the ~3 700 tool tokens again. After the tools, such a change costs only the context
// and what follows. That holds only when the template renders the tools after the system text: `toolsAfterSystem`
// renders a probe and says so. No import of node-llama-cpp: the wrapper is passed in (structural type).

export interface RenderingWrapper {
  generateContextState(o: { chatHistory: readonly unknown[]; availableFunctions?: Record<string, { description?: string; params?: unknown }> }): { contextText: { toString(): string } };
}

/**
 * Whether `wrapper` renders the tools after the system text and before the first user message: a probe history
 * [system '§S§', user '§U§', model []] with one function 'sonde_outil' described '§T§', true when the rendered text
 * holds §S§, then §T§, then §U§. false when it renders otherwise, or throws.
 */
export function toolsAfterSystem(wrapper: RenderingWrapper): boolean {
  try {
    const text = wrapper.generateContextState({
      chatHistory: [{ type: 'system', text: '§S§' }, { type: 'user', text: '§U§' }, { type: 'model', response: [] }],
      availableFunctions: { sonde_outil: { description: '§T§', params: { type: 'object', properties: {} } } },
    }).contextText.toString();
    const system = text.indexOf('§S§');
    const tools = text.indexOf('§T§');
    const user = text.indexOf('§U§');
    return system >= 0 && system < tools && tools < user;
  } catch {
    return false;
  }
}

export const CONTEXT_HEADER = '[CONTEXTE DU PROJET]';

/** The project context as its own item, right after the system one: a user item, since the Jinja wrapper merges
 * adjacent system items (the context would go back before the tools). */
export function contextItem(projectContext: string): { type: 'user'; text: string } {
  return { type: 'user', text: `${CONTEXT_HEADER}\n${projectContext}` };
}
