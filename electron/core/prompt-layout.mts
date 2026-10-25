// How a chat template renders what the levers change in a local model's prompt. No import of node-llama-cpp: the wrapper
// is passed in (structural type).
//
// Where the project context goes (Task 4, lever `contextPlacement`). Today it heads the system text, before the tool
// block: any change to it (save_memory, a compaction note, the memory's last 4 000 characters sliding) makes the engine
// read the ~3 700 tool tokens again. After the tools, such a change costs only the context and what follows. That holds
// only when the template renders the tools after the system text: `toolsAfterSystem` renders a probe and says so.
//
// Whether a resent thought lands where the model wrote it (Task 5, lever `keepThought`, F15): `thoughtKept`.

export interface RenderingWrapper {
  generateContextState(o: { chatHistory: readonly unknown[]; availableFunctions?: Record<string, { description?: string; params?: unknown }> }): { contextText: { toString(): string } };
  /** The wrapper's thought segment, as node-llama-cpp declares it (ChatWrapperSettings). */
  settings?: { segments?: { thought?: { prefix?: unknown; reopenAfterFunctionCalls?: boolean } | null } | null };
}

export const CONTEXT_HEADER = '[CONTEXTE DU PROJET]';

/** The project context as its own item, right after the system one: a user item, since the Jinja wrapper merges
 * adjacent system items (the context would go back before the tools). */
export function contextItem(projectContext: string): { type: 'user'; text: string } {
  return { type: 'user', text: `${CONTEXT_HEADER}\n${projectContext}` };
}

const PROBE_FUNCTIONS = { sonde_outil: { description: '§T§', params: { type: 'object', properties: {} } } };

/**
 * Whether `wrapper` renders the tools after the system text and before the context item, in the layout the lever really
 * sends (ruling carried into Task 5): [system '§S§', the context item '§C§', user '§U§', model []] with one function
 * 'sonde_outil' described '§T§'; true when the rendered text holds §S§, then §T§, then §C§, then §U§. false when it
 * renders otherwise, or throws — a template that refuses two user messages in a row makes it false, so the lever
 * keeps today's layout instead of failing the turn.
 */
export function toolsAfterSystem(wrapper: RenderingWrapper): boolean {
  try {
    const text = wrapper.generateContextState({
      chatHistory: [{ type: 'system', text: '§S§' }, contextItem('§C§'), { type: 'user', text: '§U§' }, { type: 'model', response: [] }],
      availableFunctions: PROBE_FUNCTIONS,
    }).contextText.toString();
    const at = ['§S§', '§T§', '§C§', '§U§'].map(mark => text.indexOf(mark));
    return at[0] >= 0 && at.every((position, index) => index === 0 || position > at[index - 1]);
  } catch {
    return false;
  }
}

/** Where a resent thought lands right, per place: before a later user message (the previous turn's last reply), and in
 * the turn in progress (the tool steps). */
export interface ThoughtKept { previousTurn: boolean; currentTurn: boolean }

const thoughtSegment = (text: string, ended = true) => ({ type: 'segment', segmentType: 'thought', text, ended });
const probeCall = (result: string) => ({ type: 'functionCall', name: 'sonde_outil', params: {}, result });

/** The text the model writes to open a thought: none when the template opens it itself (`openedOnStart`). */
function thoughtPrefix(wrapper: RenderingWrapper): string {
  const prefix = wrapper.settings?.segments?.thought?.prefix;
  if (prefix == null) return '';
  if (typeof prefix === 'string') return prefix;
  if ((prefix as { type?: unknown }).type === 'openedOnStart') return '';
  return String(prefix);
}

/**
 * Whether `wrapper` renders a thought sent back in the history where the model generated it: the history with the
 * thought must start with the prompt the model read before writing it, then (after whitespace) the thought prefix the
 * model writes, then the thought. Tested before a later user message, and in a tool step (first step, then a second
 * one after a function call, where node-llama-cpp reopens the thought: `reopenAfterFunctionCalls`). Through
 * node-llama-cpp 3.21.1 a template that opens the thought itself (Qwen 3.5/3.6, the 27B) renders it otherwise: inside
 * the reply text, after an empty <think></think>. false for a place whose rendering throws.
 */
export function thoughtKept(wrapper: RenderingWrapper): ThoughtKept {
  const render = (chatHistory: unknown[], functions = false) => wrapper.generateContextState({ chatHistory, ...(functions ? { availableFunctions: PROBE_FUNCTIONS } : {}) }).contextText.toString();
  const prefix = thoughtPrefix(wrapper);
  const lands = (read: string, kept: string, mark: string, opened = false) => {
    if (!kept.startsWith(read)) return false;
    let rest = kept.slice(read.length).trimStart();
    if (!opened && prefix && rest.startsWith(prefix)) rest = rest.slice(prefix.length).trimStart();
    return rest.startsWith(mark);
  };
  const safely = (probe: () => boolean) => { try { return probe(); } catch { return false; } };
  const base = [{ type: 'system', text: '§S§' }, { type: 'user', text: '§U1§' }];
  const previousTurn = safely(() => lands(
    render([...base, { type: 'model', response: [] }]),
    render([...base, { type: 'model', response: [thoughtSegment('§R1§'), '§A§'] }, { type: 'user', text: '§U2§' }, { type: 'model', response: [] }]),
    '§R1§'));
  const reopens = wrapper.settings?.segments?.thought?.reopenAfterFunctionCalls === true;
  const firstStep = [thoughtSegment('§R1§'), probeCall('§O1§')];
  const currentTurn = safely(() => lands(render([...base, { type: 'model', response: [] }], true), render([...base, { type: 'model', response: firstStep }], true), '§R1§')
    && lands(
      render([...base, { type: 'model', response: [...firstStep, ...(reopens ? [thoughtSegment('', false)] : [])] }], true),
      render([...base, { type: 'model', response: [...firstStep, thoughtSegment('§R2§'), probeCall('§O2§')] }], true),
      '§R2§', reopens));
  return { previousTurn, currentTurn };
}
