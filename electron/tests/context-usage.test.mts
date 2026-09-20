import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_WINDOWS,
  computeContext,
  contextLevel,
  contextLimit,
  estimateTokens,
  formatContextLabel,
  shouldAutoCompact,
  shouldCompact,
} from '../renderer-src/src/state/context.ts';

const msg = (role: string, content: string) => ({ role, content });

test('windows table is the one of the NiceGUI app (utils.py::_DEFAULT_CTX_LIMITS), nothing invented', () => {
  assert.deepEqual(CONTEXT_WINDOWS, {
    together: 128_000, groq: 128_000, mistral: 32_000, gemini: 1_000_000,
    openrouter: 128_000, ollama: 32_000, lmstudio: 32_000, llamacpp: 32_000,
  });
});

test('estimateTokens: 4 characters per token, user and assistant messages only', () => {
  // 8 + 12 characters → 20 // 4 = 5. The tool output (a big one) and the system message do not count.
  const messages = [msg('user', '12345678'), msg('assistant', '123456789012'), msg('tool', 'x'.repeat(4000)), msg('system', 'y'.repeat(400))];
  assert.equal(estimateTokens(messages), 5);
});

test('estimateTokens reads legacy roles and rounds down like Python (//)', () => {
  assert.equal(estimateTokens([msg('human', 'abc'), msg('ai', 'de')]), 1, '5 characters // 4');
  assert.equal(estimateTokens([msg('user', 'abc')]), 0, 'under 4 characters is 0 tokens');
  assert.equal(estimateTokens([]), 0);
});

test('estimateTokens counts characters like Python len(): an emoji is one character, not two', () => {
  assert.equal(estimateTokens([msg('user', '😀😀😀😀')]), 1, '4 characters // 4, not 8 UTF-16 units // 4 = 2');
});

test('an assistant turn that only calls a tool (empty content) counts for nothing', () => {
  assert.equal(estimateTokens([msg('assistant', '')]), 0);
});

test('contextLimit: the configured max_tokens wins over the provider window; reserved tokens are deducted', () => {
  assert.equal(contextLimit('groq', null, 2048), 128_000 - 2048);
  assert.equal(contextLimit('groq', 10_000, 2048), 10_000 - 2048);
  assert.equal(contextLimit('gemini', null, 0), 1_000_000);
});

test('contextLimit: no provider or an unknown one falls back on the local default window, and never drops below 1', () => {
  assert.equal(contextLimit(null, null, 2048), 32_000 - 2048);
  assert.equal(contextLimit('inconnu', null, 2048), 32_000 - 2048);
  assert.equal(contextLimit('groq', 100, 5000), 1, 'reserved tokens larger than the window cannot make a zero or negative limit');
});

test('computeContext returns tokens and a percentage capped at 100', () => {
  const half = computeContext([msg('user', 'x'.repeat(4 * 15_000))], { provider: 'ollama', max_tokens: null, reserved_tokens: 2000 });
  assert.equal(half.tokens, 15_000);
  assert.equal(half.pct, 50, '15 000 / (32 000 - 2 000)');
  const over = computeContext([msg('user', 'x'.repeat(4 * 100_000))], { provider: 'ollama', max_tokens: null, reserved_tokens: 2000 });
  assert.equal(over.pct, 100, 'never above 100');
  assert.equal(over.tokens, 100_000, 'the token count itself is not capped');
  assert.deepEqual(computeContext([], { provider: 'groq', max_tokens: null, reserved_tokens: 2048 }), { tokens: 0, pct: 0 });
});

test('contextLevel: purple under 70, yellow under 90, red from 90 (context_bar.py colours)', () => {
  assert.equal(contextLevel(0), 'normal');
  assert.equal(contextLevel(69.9), 'normal');
  assert.equal(contextLevel(70), 'warning');
  assert.equal(contextLevel(89.9), 'warning');
  assert.equal(contextLevel(90), 'critical');
  assert.equal(contextLevel(100), 'critical');
});

test('shouldCompact: from the threshold included', () => {
  assert.equal(shouldCompact(69.9, 70), false);
  assert.equal(shouldCompact(70, 70), true);
  assert.equal(shouldCompact(100, 95), true);
});

test('shouldAutoCompact needs BOTH the setting on and the threshold reached (input_bar.py:484)', () => {
  assert.equal(shouldAutoCompact({ auto_compact: true, compact_threshold: 70 }, 70), true);
  assert.equal(shouldAutoCompact({ auto_compact: true, compact_threshold: 70 }, 69.9), false);
  assert.equal(shouldAutoCompact({ auto_compact: false, compact_threshold: 70 }, 100), false, 'switched off: never, even when full');
});

test('formatContextLabel: rounded percentage, comma as thousands separator (as the f"{tokens:,}" of context_bar.py)', () => {
  assert.equal(formatContextLabel({ tokens: 1234567, pct: 41.6 }), '42% · ~1,234,567 tokens');
  assert.equal(formatContextLabel({ tokens: 0, pct: 0 }), '0% · ~0 tokens');
});
