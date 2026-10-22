import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptOpensThought, generationPromptOf, opensThought } from '../core/thought-prefill.mts';

// Published GGUF chat templates, trimmed to the parts that matter here (the message loop and the generation prompt).
// QwQ-32B (Qwen/QwQ-32B, tokenizer_config.json, same tail in Qwen3-*-Thinking-2507): the generation prompt opens
// <think> itself, so the model writes only its reasoning and then </think>.
const QWQ = "{%- for message in messages %}{%- if (message.role == \"user\") or (message.role == \"system\") %}{{- '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>' + '\\n' }}{%- elif message.role == \"assistant\" %}{%- set content = message.content %}{%- if '</think>' in content %}{%- set content = content.split('</think>')[-1].lstrip('\\n') %}{%- endif %}{{- '<|im_start|>' + message.role + '\\n' + content + '<|im_end|>' + '\\n' }}{%- endif %}{%- endfor %}\n{%- if add_generation_prompt %}\n    {{- '<|im_start|>assistant\\n<think>\\n' }}\n{%- endif %}\n";
// Qwen3-8B (Qwen/Qwen3-8B, tokenizer_config.json): nothing opened when thinking is on; with thinking off, an EMPTY
// CLOSED block <think>\n\n</think>\n\n — which is not an open thought.
const QWEN3 = "{%- for message in messages %}{%- if (message.role == \"user\") or (message.role == \"system\") %}{{- '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>' + '\\n' }}{%- elif message.role == \"assistant\" %}{{- '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>' + '\\n' }}{%- endif %}{%- endfor %}\n{%- if add_generation_prompt %}\n    {{- '<|im_start|>assistant\\n' }}\n    {%- if enable_thinking is defined and enable_thinking is false %}\n        {{- '<think>\\n\\n</think>\\n\\n' }}\n    {%- endif %}\n{%- endif %}";
// Llama-2-chat (meta-llama/Llama-2-7b-chat-hf): no think at all.
const LLAMA2 = "{% if messages[0]['role'] == 'system' %}{% set loop_messages = messages[1:] %}{% set system_message = messages[0]['content'] %}{% else %}{% set loop_messages = messages %}{% set system_message = false %}{% endif %}{% for message in loop_messages %}{% if (message['role'] == 'user') != (loop.index0 % 2 == 0) %}{{ raise_exception('Conversation roles must alternate user/assistant/user/assistant/...') }}{% endif %}{% if loop.index0 == 0 and system_message != false %}{% set content = '<<SYS>>\\n' + system_message + '\\n<</SYS>>\\n\\n' + message['content'] %}{% else %}{% set content = message['content'] %}{% endif %}{% if message['role'] == 'user' %}{{ bos_token + '[INST] ' + content.strip() + ' [/INST]' }}{% elif message['role'] == 'assistant' %}{{ ' '  + content.strip() + ' ' + eos_token }}{% endif %}{% endfor %}";

test('promptOpensThought: only a <think> left open at the very end counts', () => {
  assert.equal(promptOpensThought('<|im_start|>assistant\n<think>\n'), true);
  assert.equal(promptOpensThought('<|im_start|>assistant\n<think>'), true);
  assert.equal(promptOpensThought('<|im_start|>assistant\n<think>\n\n</think>\n\n'), false, 'an empty closed block is not open');
  assert.equal(promptOpensThought('<|im_start|>assistant\n'), false);
  assert.equal(promptOpensThought('<think>\nquelque chose'), false, 'text after the tag: the prompt does not end inside it');
  assert.equal(promptOpensThought(''), false);
});

test('generationPromptOf renders the generation prompt of a real template through node-llama-cpp', () => {
  assert.equal(generationPromptOf(QWQ, true), '<|im_end|>\n<|im_start|>assistant\n<think>\n');
  assert.equal(generationPromptOf(QWEN3, true), '<|im_end|>\n<|im_start|>assistant\n');
  assert.equal(generationPromptOf(QWEN3, false), '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
  assert.equal(generationPromptOf(LLAMA2, true), ' [/INST]');
  assert.equal(generationPromptOf('{{ raise_exception("non") }}', true), null, 'a template that cannot render gives null');
});

test('opensThought: QwQ opens <think> itself; Qwen3 (empty closed block or nothing) and Llama-2 do not', () => {
  assert.equal(opensThought({ template: QWQ }), true);
  assert.equal(opensThought({ template: QWEN3 }), false);
  assert.equal(opensThought({ template: QWEN3, reasoning: false }), false, 'the empty closed block written with thinking off');
  assert.equal(opensThought({ template: LLAMA2 }), false);
  assert.equal(opensThought({ template: undefined }), false, 'no template in the file');
});

test('opensThought: a wrapper that opens the thought segment itself keeps it off; a thought segment the model must open does not', () => {
  // QwenChatWrapper 3.5 (thoughts « auto ») and a Jinja template read as openedOnStart: node-llama-cpp streams a
  // thought segment from the first token, nothing to do here.
  assert.equal(opensThought({ template: QWQ, thought: { prefix: '<think>\n', suffix: '\n</think>', openOnResponseStart: true } }), false);
  assert.equal(opensThought({ template: QWQ, thought: { prefix: { type: 'openedOnStart' }, suffix: '</think>' } }), false);
  // The segment QwQ's own Jinja wrapper declares (prefix <think>, no openOnResponseStart): node-llama-cpp waits for
  // the model to write <think>, which a prefilled model never does.
  assert.equal(opensThought({ template: QWQ, thought: { prefix: '<think>', suffix: '</think>' } }), true);
});
