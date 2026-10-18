import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufFileInfo, GgufInsights } from 'node-llama-cpp';
import { completeLocal, disposeEngine, warmModelPath, LOCAL_OUTPUT_CAP, engineContextSize, loadedContextSize, localProvider, loadLocalModel, loadedPlacement, localModelTooBig, warmContext, nativeLoadCount, liveModelCount } from '../core/local-engine.mts';
import { runtimeLlama, backendOf } from '../core/llama-runtime.mts';
import { removeAtEnd } from './teardown.mts';
import { withTrainContext } from './support/gguf-fixture.mts';
import { runAgent, TRUNCATED_NOTICE } from '../core/agent.mts';
import { estimateRequestTokens } from '../core/request-context.mts';

// Real node-llama-cpp, real tiny GGUF (llama.cpp's own CI asset, 1.1 MB, stories260K — a toy model: its
// text is low quality, but the MECHANICS (load, stream, abort, unload) are exactly what a real model uses.
const execFileAsync = promisify(execFile);
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

// M3 on the built-in engine: the output requested is min(8192, window − estimated request). The toy model never
// ends by itself, so the reply runs to whatever cap it was given: 8192 tokens before the fix, a few dozen here.
test('a turn on the built-in engine asks for no more output than its window leaves (the provider the worker uses)', { timeout: 180000 }, async t => {
  t.after(() => disposeEngine());
  const provider = localProvider(modelPath);
  assert.equal(provider.outputCap(), LOCAL_OUTPUT_CAP);
  const messages = [{ role: 'user' as const, content: 'Once upon a time' }];
  const room = 24;
  const result = await runAgent({
    provider, messages, instructions: 'Tu es un conteur.', tools: [],
    settings: { mode: 'auto', permission_mode: 'auto' }, confirm: async () => true,
    contextWindow: estimateRequestTokens('Tu es un conteur.', [], messages) + room,
  });
  const reply = String(result.at(-1)?.content);
  assert.ok(reply.endsWith(TRUNCATED_NOTICE), 'cut by the reduced cap');
  const text = reply.slice(0, -TRUNCATED_NOTICE.length).trimEnd();
  const longest = 32; // no token of this 512-token vocabulary is longer
  assert.ok(text.length <= room * longest, `at most ${room} tokens of text, got ${text.length} characters`);
});

test('engineContextSize loads the model and reports the context size the request budget must use', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  await disposeEngine();
  assert.equal(loadedContextSize(modelPath), null, 'nothing loaded yet: no size, and reading it loads nothing');
  assert.equal(warmModelPath(), null);
  const size = await engineContextSize(modelPath);
  assert.ok(Number.isInteger(size) && size >= 16384, `the toy model (trained for 2048) runs with the 16384 floor, got ${size}`);
  assert.equal(warmModelPath(), modelPath, 'loaded once, kept warm for the turn that follows');
  assert.equal(loadedContextSize(modelPath), size, 'once loaded, the size the engine really runs with');
  assert.equal(loadedContextSize(`${modelPath}.other`), null, 'another path is not the loaded model');
});

test('GGUF tool-call ids never repeat across engine restarts (two workers = two app launches)', { timeout: 30000 }, async () => {
  const url = new URL('../core/local-engine.mts', import.meta.url).href;
  const mint = () => new Promise<string[]>((resolve, reject) => {
    const worker = new Worker(`import(${JSON.stringify(url)}).then(m => require('node:worker_threads').parentPort.postMessage([m.mintCallId(), m.mintCallId()]))`, { eval: true });
    worker.once('message', ids => { void worker.terminate(); resolve(ids); });
    worker.once('error', reject);
  });
  const ids = [...await mint(), ...await mint()];
  for (const id of ids) assert.match(id, /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, 4, `the second engine reuses none of the first one's ids: ${ids.join(', ')}`);
});

test('loadLocalModel loads with fitContext: the placement is model.gpuLayers, the total layers and the exact context size', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  await disposeEngine();
  const p = await loadLocalModel(modelPath, 16384);
  assert.equal(p.source, 'loaded');
  assert.equal(p.contextSize, 16384, 'the exact context asked for, not one that follows free memory');
  const totalLayers = (await GgufInsights.from(await readGgufFileInfo(modelPath))).totalLayers;
  assert.equal(p.totalLayers, totalLayers);
  assert.ok(Number.isInteger(p.gpuLayers) && p.gpuLayers >= 0 && p.gpuLayers <= p.totalLayers, `0 <= ${p.gpuLayers} <= ${p.totalLayers}`);
  const llama = await runtimeLlama();
  assert.equal(p.backend, backendOf(llama), 'the runtime Llama loaded it');
  // Both branches, whichever backend this process resolved to: no card puts every layer on the processor; any card
  // holds all of a 1 MB model.
  if (llama.gpu === false) assert.equal(p.gpuLayers, 0, 'no card: every layer on the processor');
  else assert.equal(p.gpuLayers, p.totalLayers, `a card (${llama.gpu}) holds all of a 1 MB model`);
  assert.equal(p.memoryMeasured, false);
  assert.ok(p.vramBytes >= 0 && p.ramBytes > 0, `node-llama-cpp's own footprint estimate: ${p.vramBytes} / ${p.ramBytes}`);
  assert.deepEqual(loadedPlacement(modelPath), p, 'the placement shown after the load is the loaded one');
  assert.equal(loadedPlacement(`${modelPath}.other`), null);
});

/** Runs `body` in a Node process of its own, `m` being core/local-engine.mts and `r` core/llama-runtime.mts, and
 * returns what it assigned to `out`. A child that never ends is killed rather than left holding this run open. */
async function inChild(body: string, env: NodeJS.ProcessEnv = {}): Promise<any> {
  const source = `
    const m = await import(${JSON.stringify(new URL('../core/local-engine.mts', import.meta.url).href)});
    const r = await import(${JSON.stringify(new URL('../core/llama-runtime.mts', import.meta.url).href)});
    const out = {};
    ${body}
    await r.disposeLlama();
    process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n');`;
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 100000,
  });
  const line = stdout.split('\n').find(text => text.startsWith('RESULT '));
  assert.ok(line, `the child printed its result: ${stdout.slice(-500)}`);
  return JSON.parse(line.slice('RESULT '.length));
}

// On the processor (NODE_LLAMA_CPP_GPU=false), in a process of its own: 2^28 tokens of KV cache is hundreds of GB.
// - on a Vulkan card, node-llama-cpp's fitContext resolution of such a size was seen aborting the whole process
//   natively (ggml-backend.cpp:941, « pre-allocated tensor (cache_k_l0) in a buffer (Vulkan0) that cannot run the
//   operation », 2026-10-18, node-llama-cpp 3.21.1): the pre-check in loadLocalModel now refuses it before any native code;
// - a cpu binary loaded beside this process's Vulkan one killed the whole tests/all.mts process once, silently
//   (2026-10-18). The app never mixes two backends in one process.
test('a context the machine cannot hold fails with localModelTooBig and leaves nothing loaded', { timeout: 120000 }, async () => {
  const out = await inChild(`
    const path = ${JSON.stringify(modelPath)};
    try { await m.loadLocalModel(path, 2 ** 28); out.loaded = true; } catch (error) { out.message = error.message; }
    out.warm = m.warmModelPath();
    out.placement = m.loadedPlacement(path);
    out.next = (await m.loadLocalModel(path, 16384)).contextSize;
    out.backend = m.loadedPlacement(path).backend;`, { NODE_LLAMA_CPP_GPU: 'false' });
  assert.equal(out.loaded, undefined, 'the load was refused');
  assert.equal(out.message, localModelTooBig(2 ** 28));
  assert.equal(out.warm, null, 'nothing kept warm');
  assert.equal(out.placement, null);
  assert.equal(out.next, 16384, 'the next normal load works');
  assert.equal(out.backend, 'cpu');
});

// On whatever backend a fresh process resolves to (the card when there is one), in a process of its own in case the
// pre-check ever let it through. 2^30 tokens is about 1.4 TB of f16 KV cache for stories260K.
test('the pre-check refuses « max » on a huge train context before node-llama-cpp loads anything', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-local-engine-'));
  removeAtEnd(t, root);
  const patched = join(root, 'stories-huge.gguf');
  await withTrainContext(modelPath, patched, 2 ** 30);
  const out = await inChild(`
    const path = ${JSON.stringify(patched)};
    out.size = await m.plannedContextSize(path, { setting: 'max' });
    try { await m.loadLocalModel(path, out.size); out.loaded = true; } catch (error) { out.message = error.message; }
    out.nativeLoads = m.nativeLoadCount();
    out.live = m.liveModelCount();
    out.warm = m.warmModelPath();
    out.small = (await m.loadLocalModel(path, 16384)).contextSize;
    out.nativeAfter = m.nativeLoadCount();
    await m.disposeEngine();
    out.liveAfter = m.liveModelCount();`);
  assert.equal(out.size, 2 ** 30, '« max » is the train size');
  assert.equal(out.loaded, undefined);
  assert.equal(out.message, localModelTooBig(2 ** 30));
  assert.equal(out.nativeLoads, 0, 'loadModel was never reached');
  assert.equal(out.live, 0);
  assert.equal(out.warm, null);
  assert.equal(out.small, 16384, 'a size that fits is not refused');
  assert.equal(out.nativeAfter, 1);
  assert.equal(out.liveAfter, 0);
});

test('the engine reloads when the context size changes, and only then', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  const root = await mkdtemp(join(tmpdir(), 'openagent-local-engine-'));
  removeAtEnd(t, root);
  const patched = join(root, 'stories-131072.gguf');
  await withTrainContext(modelPath, patched, 131072);
  const a = await loadLocalModel(patched, 32768);
  assert.equal(a.contextSize, 32768);
  const first = warmContext();
  assert.ok(first);
  const loads = nativeLoadCount();
  const b = await loadLocalModel(patched, 32768);
  assert.deepEqual(b, a);
  assert.equal(warmContext(), first, 'the same request reuses the very same context object');
  assert.equal(nativeLoadCount(), loads, 'and calls loadModel no more');
  const c = await loadLocalModel(patched, 65536);
  assert.equal(c.contextSize, 65536, 'a new size reloads the engine');
  assert.notEqual(warmContext(), first, 'a new context object');
  assert.equal(first.disposed, true, 'the old one freed');
  assert.equal(nativeLoadCount(), loads + 1);
  assert.equal(loadedContextSize(patched), 65536);
});

// A new runtime generation (the Llama disposed and created again) is checked in a process of its own: recreating the
// Llama here could resolve another backend beside the one already loaded in this process.
test('the engine reloads when the runtime generation changes, even for the same request', { timeout: 120000 }, async () => {
  const out = await inChild(`
    const path = ${JSON.stringify(modelPath)};
    await m.loadLocalModel(path, 16384);
    const first = m.warmContext();
    await m.loadLocalModel(path, 16384);
    out.reused = m.warmContext() === first;
    const generation = r.runtimeGeneration();
    await r.disposeLlama();
    out.bumped = r.runtimeGeneration() === generation + 1;
    out.firstDisposed = first.disposed;
    await m.loadLocalModel(path, 16384);
    out.fresh = m.warmContext() !== null && m.warmContext() !== first;
    out.nativeLoads = m.nativeLoadCount();`);
  assert.deepEqual(out, { reused: true, bumped: true, firstDisposed: true, fresh: true, nativeLoads: 2 });
});

test('two concurrent loads with different requests end with exactly one warm model and nothing leaked', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  await disposeEngine();
  const root = await mkdtemp(join(tmpdir(), 'openagent-local-engine-'));
  removeAtEnd(t, root);
  const patched = join(root, 'stories-131072.gguf');
  await withTrainContext(modelPath, patched, 131072);
  assert.equal(liveModelCount(), 0, 'nothing loaded before');
  const loads = nativeLoadCount();
  const [a, b] = await Promise.all([loadLocalModel(patched, 32768), loadLocalModel(patched, 65536)]);
  assert.equal(a.contextSize, 32768, 'each call got the placement of its own load');
  assert.equal(b.contextSize, 65536);
  assert.equal(nativeLoadCount(), loads + 2);
  assert.equal(liveModelCount(), 1, 'the first model was disposed, not overwritten');
  assert.equal(loadedContextSize(patched), 65536, 'the last request wins');
  assert.equal(warmContext()?.disposed, false);
});
