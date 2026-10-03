import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { completeLocal, disposeEngine, warmModelPath, LOCAL_OUTPUT_CAP, engineContextSize } from '../core/local-engine.mts';

// Real node-llama-cpp, real tiny GGUF (llama.cpp's own CI asset, 1.1 MB, stories260K — a toy model: its
// text is low quality, but the MECHANICS (load, stream, abort, unload) are exactly what a real model uses.
const modelPath = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

test('completeLocal: real text generation from a real .gguf, streamed via onDelta, in our ChatMessage shape', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  const chunks: string[] = [];
  const message = await completeLocal({
    modelPath,
    messages: [{ role: 'user', content: 'Once upon a time' }],
    maxTokens: 16,
    onDelta: text => chunks.push(text),
  });
  assert.equal(message.role, 'assistant');
  assert.equal(typeof message.content, 'string');
  assert.ok(message.content.length > 0, 'the toy model still produced some text');
  assert.equal('tool_calls' in message, false, 'no tools were offered, so none were called');
  assert.ok(chunks.length > 0, 'onDelta received at least one chunk');
  assert.equal(chunks.join(''), message.content, 'the streamed chunks reassemble exactly into the final content');
});

test('the model stays warm across two calls on the same path, and disposeEngine really frees it', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  assert.equal(warmModelPath(), null);
  await completeLocal({ modelPath, messages: [{ role: 'user', content: 'Hi' }], maxTokens: 4 });
  assert.equal(warmModelPath(), modelPath, 'kept loaded after the first turn');
  const loadStart = Date.now();
  await completeLocal({ modelPath, messages: [{ role: 'user', content: 'Hi again' }], maxTokens: 4 });
  const secondTurnMs = Date.now() - loadStart;
  assert.equal(warmModelPath(), modelPath, 'still the same instance, not reloaded');
  assert.ok(secondTurnMs < 3000, `a warm second turn should be fast, not a full reload (${secondTurnMs}ms)`);
  await disposeEngine();
  assert.equal(warmModelPath(), null, 'really unloaded');
});

test('a real AbortSignal really stops generation and rejects — the exact contract agent.mts\'s Stop button relies on', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  const controller = new AbortController();
  const promise = completeLocal({ modelPath, messages: [{ role: 'user', content: 'Once upon a time' }], maxTokens: 200, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { name?: string }).name, 'AbortError', 'a real DOMException AbortError, the same shape a fetch-based provider rejects with');
    return true;
  });
});

test('completeLocal never hangs when the caller sets no maxTokens at all — unlike a real HTTP provider, nothing else would ever stop it', { timeout: 180000 }, async t => {
  t.after(() => disposeEngine());
  const message = await completeLocal({ modelPath, messages: [{ role: 'user', content: 'Once upon a time' }] });
  assert.equal(typeof message.content, 'string');
  assert.equal(message.truncated, true, 'the toy model never ends by itself: it was stopped by the 8192-token cap, and says so');
});

test('toGgufFunctions rejects nothing real: a genuine tool schema does not crash the real engine even on a toy model that never calls it', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'Lit un fichier', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
  const message = await completeLocal({ modelPath, messages: [{ role: 'user', content: 'Bonjour' }], tools, maxTokens: 16 });
  assert.equal(message.role, 'assistant');
  assert.equal(typeof message.content, 'string');
});

test('the built-in engine is capped at 8192 output tokens, like the local HTTP servers in Python\'s table', () => {
  assert.equal(LOCAL_OUTPUT_CAP, 8192);
});

test('engineContextSize loads the model and reports the context size the request budget must use', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  const size = await engineContextSize(modelPath);
  assert.ok(Number.isInteger(size) && size >= 16384, `the toy model (trained for 2048) runs with the 16384 floor, got ${size}`);
  assert.equal(warmModelPath(), modelPath, 'loaded once, kept warm for the turn that follows');
});
