import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JinjaTemplateChatWrapper } from 'node-llama-cpp';
import { toolsAfterSystem, contextItem, CONTEXT_HEADER } from '../core/prompt-layout.mts';
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
