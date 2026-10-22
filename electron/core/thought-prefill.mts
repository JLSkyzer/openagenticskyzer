// Whether a model's chat template opens <think> itself in the generation prompt (QwQ, the Qwen3 « Thinking » models,
// the DeepSeek-R1 distills…): such a model writes only its reasoning and then </think>, so its reply is reasoning from
// the first token (core/reasoning-split.mts, `startInThought`). Decided once per load (local-engine.mts::keep).
//
// The GGUF template is rendered through node-llama-cpp's own Jinja engine, with add_generation_prompt. The resolved
// chat wrapper's own rendering cannot tell: JinjaTemplateChatWrapper renders the coming reply as an assistant message,
// never through add_generation_prompt, and no specialised wrapper writes an open <think> (checked on 3.21.1: QwQ's
// template, DeepSeek, Qwen 3 and 3.5 all end at the assistant header). Importing node-llama-cpp loads no native
// binding: only getLlama does (llama-runtime.mts).
import { JinjaTemplateChatWrapper, SpecialTokensText } from 'node-llama-cpp';

const OPEN = '<think>';
const CLOSE = '</think>';
const PROBE = 'OPENAGENT-PROBE-7d1f';

/** The prompt ends inside an open <think>: the last <think> has no </think> after it, and nothing but whitespace.
 * An empty closed block (<think>\n\n</think>, thinking off) is not open. */
export function promptOpensThought(prompt: string): boolean {
  const open = prompt.lastIndexOf(OPEN);
  if (open < 0) return false;
  const rest = prompt.slice(open + OPEN.length);
  return !rest.includes(CLOSE) && rest.trim() === '';
}

/** What `template` writes after one user message when asked for the generation prompt (the user message's own end
 * included), or null when it cannot be rendered. `reasoning` is the enable_thinking node-llama-cpp passes. */
export function generationPromptOf(template: string, reasoning: boolean): string | null {
  try {
    const wrapper = new JinjaTemplateChatWrapper({ template, reasoning, additionalRenderParameters: { add_generation_prompt: true } });
    const { contextText } = wrapper.generateContextState({ chatHistory: [{ type: 'user', text: PROBE }] });
    const rendered = contextText.values
      .map(value => typeof value === 'string' ? value : value instanceof SpecialTokensText ? value.value : '')
      .join('');
    const at = rendered.lastIndexOf(PROBE);
    return at < 0 ? null : rendered.slice(at + PROBE.length);
  } catch {
    return null;
  }
}

/** The chat wrapper's thought segment, as node-llama-cpp declares it (settings.segments.thought). */
export interface ThoughtSegment { prefix?: unknown; suffix?: unknown; openOnResponseStart?: boolean }

/**
 * Whether the reply starts inside a thought the app must split itself:
 * - no when the wrapper opens the thought segment itself on the response start (openOnResponseStart, or a prefix
 *   « openedOnStart »): node-llama-cpp then streams a thought segment from the first token;
 * - else yes when the GGUF template's generation prompt ends inside an open <think>. A thought segment the model must
 *   open by writing its prefix does not count: a model whose template prefilled <think> never writes it.
 */
export function opensThought({ template, reasoning = true, thought }: { template: string | undefined; reasoning?: boolean; thought?: ThoughtSegment | null }): boolean {
  if (thought?.openOnResponseStart === true) return false;
  const prefix = thought?.prefix as { type?: unknown } | undefined;
  if (prefix && typeof prefix === 'object' && !Array.isArray(prefix) && prefix.type === 'openedOnStart') return false;
  if (!template) return false;
  const prompt = generationPromptOf(template, reasoning);
  return prompt !== null && promptOpensThought(prompt);
}
