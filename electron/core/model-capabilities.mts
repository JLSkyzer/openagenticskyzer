// Can a model's chat template call tools? Asked of node-llama-cpp itself: the template's text cannot decide, since the
// library gives a template without tools a syntax of its own, and a template can name tools without ever printing them.
// Pure and synchronous, no model and no network; expensive though, up to 6 s for a long template (measured 2026-11-09).
import { resolveChatWrapper, type ChatHistoryItem, type ChatModelFunctions } from 'node-llama-cpp';

export type ToolSupport = 'yes' | 'no' | 'unknown';

const PROBE_TOOL = 'zz_probe_tool';
const PROBE_FUNCTIONS: ChatModelFunctions = { [PROBE_TOOL]: { description: 'Probe.', params: { type: 'object', properties: { value: { type: 'string' } } } } };
// Ends on an empty model message, as every history LlamaChat renders does: some templates print the tools only when the
// last message is a user's, and then never show them to the model.
const PROBE_HISTORY: ChatHistoryItem[] = [{ type: 'system', text: 'System.' }, { type: 'user', text: 'User.' }, { type: 'model', response: [] }];

/** `yes`: the tools reach the prompt the library renders with this template. `no`: they do not. `unknown`: no template,
 * or one the resolution rejects (the app's loaded model has the native Jinja renderer on top, this check has not). */
export function toolSupportOf(chatTemplate: string | undefined | null): ToolSupport {
  if (typeof chatTemplate !== 'string' || chatTemplate.trim() === '') return 'unknown';
  try {
    // Without the fallback, a template that fails is not replaced by a wrapper guessed from a fragment of its text.
    const wrapper = resolveChatWrapper({ customWrapperSettings: { jinjaTemplate: { template: chatTemplate } }, warningLogs: false, fallbackToOtherWrappersOnJinjaError: false });
    if (wrapper == null) return 'unknown';
    const { contextText } = wrapper.generateContextState({ chatHistory: PROBE_HISTORY, availableFunctions: PROBE_FUNCTIONS });
    return contextText.toString().includes(PROBE_TOOL) ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}
