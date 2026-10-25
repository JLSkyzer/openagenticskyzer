import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JinjaTemplateChatWrapper, QwenChatWrapper } from 'node-llama-cpp';
import { toolsAfterSystem, thoughtKept, contextItem, CONTEXT_HEADER } from '../core/prompt-layout.mts';
import { historyFromMessages, toGgufFunctions } from '../core/local-provider.mts';

// Two minimal templates: one renders the tools inside the system part, after its text (the Qwen family's form); the
// other renders them in a part of their own, before every message. Without tools, the first renders the system part
// alone, as the Qwen templates do: node-llama-cpp's sanity test renders the template without tools. Both render tool
// calls and results (LOOP, Qwen's form): without that, node-llama-cpp extracts no function-call syntax from the template
// and documents the functions in the system text itself, never through the template's `tools`.
const LOOP = `{%- if m.role == 'tool' %}<|im_start|>user\n<tool_response>\n{{ m.content }}\n</tool_response><|im_end|>\n{%- else %}<|im_start|>{{ m.role }}\n{{ m.content }}{%- if m.tool_calls %}{%- for c in m.tool_calls %}\n<tool_call>\n{"name": "{{ c.function.name }}", "arguments": {{ c.function.arguments | tojson }}}\n</tool_call>{%- endfor %}{%- endif %}<|im_end|>\n{%- endif %}`;
const QWEN_LIKE = `{%- if tools %}<|im_start|>system\n{{ messages[0].content }}\n# Tools\n{%- for t in tools %}\n{{ t | tojson }}{%- endfor %}<|im_end|>\n{%- else %}<|im_start|>system\n{{ messages[0].content }}<|im_end|>\n{%- endif %}{%- for m in messages[1:] %}${LOOP}{%- endfor %}<|im_start|>assistant\n`;
const TOOLS_FIRST = `{%- if tools %}<|im_start|>tools\n{%- for t in tools %}{{ t | tojson }}{%- endfor %}<|im_end|>\n{%- endif %}{%- for m in messages %}${LOOP}{%- endfor %}<|im_start|>assistant\n`;

test('toolsAfterSystem: true for a template that renders the tools inside the system part, false when they come first', () => {
  assert.equal(toolsAfterSystem(new JinjaTemplateChatWrapper({ template: QWEN_LIKE })), true);
  assert.equal(toolsAfterSystem(new JinjaTemplateChatWrapper({ template: TOOLS_FIRST })), false);
});

test('the context reaches the rendered prompt once, after the tools and before the first user message', () => {
  const wrapper = new JinjaTemplateChatWrapper({ template: QWEN_LIKE });
  const history = historyFromMessages([{ role: 'system', content: 'BASE' }, { role: 'user', content: 'QUESTION' }], { projectContext: 'MÉMOIRE-X', placement: 'after-tools' });
  assert.deepEqual(history[1], contextItem('MÉMOIRE-X'));
  const text = wrapper.generateContextState({ chatHistory: history as never, availableFunctions: toGgufFunctions([{ type: 'function', function: { name: 'read_file', description: 'LIRE', parameters: { type: 'object', properties: {} } } }]) as never }).contextText.toString();
  assert.equal(text.split('MÉMOIRE-X').length, 2);
  assert.ok(text.indexOf('LIRE') < text.indexOf(CONTEXT_HEADER) && text.indexOf(CONTEXT_HEADER) < text.indexOf('QUESTION'));
});

// Ruling carried into Task 5: the probe renders the layout the lever really sends — [system, context, question] — so a
// template that refuses two user messages in a row (when node-llama-cpp does not join them) answers false.
const STRICT = `{%- for m in messages %}{%- if not loop.first and m.role == 'user' and loop.previtem.role == 'user' %}{{ raise_exception('Two user messages in a row.') }}{%- endif %}{%- endfor %}${QWEN_LIKE}`;

test('toolsAfterSystem renders the real after-tools layout: false for a template that rejects two user messages in a row', () => {
  assert.equal(toolsAfterSystem(new JinjaTemplateChatWrapper({ template: STRICT, joinAdjacentMessagesOfTheSameType: false })), false);
  assert.equal(toolsAfterSystem(new JinjaTemplateChatWrapper({ template: QWEN_LIKE, joinAdjacentMessagesOfTheSameType: false })), true, 'the same template without the rule');
  assert.equal(toolsAfterSystem(new JinjaTemplateChatWrapper({ template: STRICT })), true, 'node-llama-cpp joins adjacent user messages by default: the rule never fires');
});

// Task 5, F15: a minimal equivalent of the 27B's template (Qwen 3.6, read from its GGUF header): the template opens the
// thought itself and renders an assistant turn's thought from `reasoning_content` only, which node-llama-cpp 3.21.1
// fills for none but the last message. A thought sent back lands in the reply text, after an empty <think></think>.
const OPENS_THOUGHT = `{%- if tools %}<|im_start|>system\n{{ messages[0].content }}\n# Tools\n{%- for t in tools %}\n{{ t | tojson }}{%- endfor %}<|im_end|>\n{%- else %}<|im_start|>system\n{{ messages[0].content }}<|im_end|>\n{%- endif %}{%- for m in messages[1:] %}{%- if m.role == 'tool' %}<|im_start|>user\n<tool_response>\n{{ m.content }}\n</tool_response><|im_end|>\n{%- elif m.role == 'assistant' %}{%- set r = '' %}{%- if m.reasoning_content is string %}{%- set r = m.reasoning_content|trim %}{%- endif %}<|im_start|>assistant\n<think>\n{{ r }}\n</think>\n\n{{ m.content }}{%- if m.tool_calls %}{%- for c in m.tool_calls %}\n<tool_call>\n{"name": "{{ c.function.name }}", "arguments": {{ c.function.arguments | tojson }}}\n</tool_call>{%- endfor %}{%- endif %}<|im_end|>\n{%- else %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{%- endif %}{%- endfor %}{%- if add_generation_prompt %}<|im_start|>assistant\n<think>\n{%- endif %}`;

test('thoughtKept: no place for a template that opens the thought itself (the 27B\'s); every place for a wrapper that keeps past thoughts; the turn in progress only for one that keeps the last', () => {
  const opens = new JinjaTemplateChatWrapper({ template: OPENS_THOUGHT });
  assert.deepEqual(opens.settings.segments?.thought?.prefix, { type: 'openedOnStart' }, 'node-llama-cpp reads it as the 27B\'s');
  assert.deepEqual(thoughtKept(opens), { previousTurn: false, currentTurn: false });
  assert.deepEqual(thoughtKept(new QwenChatWrapper({ keepOnlyLastThought: false })), { previousTurn: true, currentTurn: true });
  assert.deepEqual(thoughtKept(new QwenChatWrapper()), { previousTurn: false, currentTurn: true }, 'keepOnlyLastThought drops the previous turn\'s');
  assert.deepEqual(thoughtKept({ generateContextState: () => { throw new Error('refusé'); } }), { previousTurn: false, currentTurn: false });
});
