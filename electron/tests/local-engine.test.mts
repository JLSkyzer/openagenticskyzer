import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufFileInfo, GgufInsights, LlamaChat, JinjaTemplateChatWrapper, QwenChatWrapper, type ChatModelFunctions, type ChatWrapper } from 'node-llama-cpp';
import type { GgufFunctions, GgufHistoryItem } from '../core/local-provider.mts';
import { commonPrefixLength, type PromptCheckpointFigures } from '../core/reuse.mts';
import { SHIPPED_LEVERS } from '../core/perf-levers.mts';
import { GenerationMeter, generationLimits, completeLocal, disposeEngine, warmModelPath, LOCAL_OUTPUT_CAP, engineContextSize, loadedContextSize, localProvider, loadLocalModel, loadedPlacement, localModelTooBig, warmContext, nativeLoadCount, liveModelCount, loadedChatWrapper, chatWrapperLogLine, sequenceOptions, stablePromptLength, checkpointPromptEnd, chatHistoryOf, TurnLock, thoughtBudget } from '../core/local-engine.mts';
import type { GenerationStats, LoadEvent } from '../core/model-types.mts';
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

// On the processor (NODE_LLAMA_CPP_GPU=false), in a process of its own in case the pre-check ever let it through: a
// `node --input-type=module -e` child cannot resolve a card (node-llama-cpp's binary test fork() inherits execArgv and
// dies), so asking it for one would only test that failed fallback. The pre-check is pure JS and backend-independent.
// 2^30 tokens is about 1.4 TB of f16 KV cache for stories260K.
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
    out.backend = m.loadedPlacement(path).backend;
    await m.disposeEngine();
    out.liveAfter = m.liveModelCount();`, { NODE_LLAMA_CPP_GPU: 'false' });
  assert.equal(out.size, 2 ** 30, '« max » is the train size');
  assert.equal(out.loaded, undefined);
  assert.equal(out.message, localModelTooBig(2 ** 30));
  assert.equal(out.nativeLoads, 0, 'loadModel was never reached');
  assert.equal(out.live, 0);
  assert.equal(out.warm, null);
  assert.equal(out.small, 16384, 'a size that fits is not refused');
  assert.equal(out.nativeAfter, 1);
  assert.equal(out.liveAfter, 0);
  assert.equal(out.backend, 'cpu');
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

// M1: the clauses below cannot tell loadSignal from createSignal (liveModelCount moves only after loadModel resolves);
// what they prove is the AbortError, the progress reported, and nothing left loaded.
test('a. an abort during the load rejects with AbortError, after progress was reported, and leaves nothing loaded', { timeout: 60000 }, async () => {
  await disposeEngine();
  const before = liveModelCount();
  const c = new AbortController();
  const seen: number[] = [];
  await assert.rejects(loadLocalModel(modelPath, 16384, { signal: c.signal, onLoad: e => { if (e.kind === 'progress') { seen.push(e.progress); c.abort(); } } }), { name: 'AbortError' });
  assert.ok(seen.length >= 1, 'onLoadProgress was passed to loadModel');
  for (const value of seen) assert.ok(value > 0 && value <= 1, `a progress in (0, 1]: ${value}`);
  assert.equal(warmModelPath(), null);
  assert.equal(liveModelCount(), before);
  await disposeEngine(); // waits for the aborted load to leave the lock
  assert.equal(warmModelPath(), null, 'the aborted load kept nothing, even once finished');
  assert.equal(liveModelCount(), before, 'and leaked no model');
});

test('b. a signal aborted while waiting for the load lock rejects at once; the queued load never runs', { timeout: 120000 }, async t => {
  t.after(() => disposeEngine());
  await disposeEngine();
  const root = await mkdtemp(join(tmpdir(), 'openagent-local-engine-'));
  removeAtEnd(t, root);
  const patched = join(root, 'stories-131072.gguf');
  await withTrainContext(modelPath, patched, 131072);
  const loads = nativeLoadCount();
  let firstDone = false;
  const first = loadLocalModel(patched, 65536).finally(() => { firstDone = true; });
  const c = new AbortController();
  const second = loadLocalModel(modelPath, 16384, { signal: c.signal });
  c.abort();
  let firstDoneAtRejection: boolean | undefined;
  await assert.rejects(second.catch(error => { firstDoneAtRejection = firstDone; throw error; }), { name: 'AbortError' });
  assert.equal(firstDoneAtRejection, false, 'the stop did not wait for the load ahead of it (S6)');
  await first;
  assert.equal(nativeLoadCount(), loads + 1, 'the queued load never called loadModel');
  assert.equal(warmModelPath(), patched);
  await assert.rejects(loadLocalModel(patched, 65536, { signal: AbortSignal.abort() }), { name: 'AbortError' }, 'an aborted signal rejects on the warm path too');
});

test('c. a real load reports start, rising progress ending at 1, then end with its time and chat wrapper; a reused engine reports nothing', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  await disposeEngine();
  const events: LoadEvent[] = [];
  await localProvider(modelPath).contextWindow({ onLoad: e => events.push(e) });
  assert.equal(events[0]?.kind, 'start', JSON.stringify(events));
  const progress = events.flatMap(e => e.kind === 'progress' ? [e.progress] : []);
  assert.ok(progress.length >= 1, JSON.stringify(events));
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], `non-decreasing: ${progress.join(', ')}`);
  assert.equal(progress.at(-1), 1, `ends at 1: ${progress.join(', ')}`);
  const last = events.at(-1)!;
  assert.equal(last.kind, 'end');
  if (last.kind !== 'end') return;
  assert.ok(last.ms >= 0);
  assert.equal(typeof last.wrapper.name, 'string');
  assert.ok(last.wrapper.name.length > 0);
  assert.deepEqual(loadedChatWrapper(modelPath), last.wrapper);
  assert.equal(loadedChatWrapper(`${modelPath}.other`), null);
  assert.equal(chatWrapperLogLine({ name: 'Qwen', segments: { thought: { prefix: '<think>' } }, opensThought: false, toolsAfterSystem: true, thoughtKept: { previousTurn: false, currentTurn: true } }), '[chat] wrapper Qwen · segments {"thought":{"prefix":"<think>"}} · réflexion ouverte par le modèle de conversation : non · contexte après les outils : oui · réflexion renvoyée rendue en place : non (tour précédent), oui (tour en cours)');
  assert.equal(chatWrapperLogLine({ name: 'JinjaTemplate', segments: null, opensThought: true, toolsAfterSystem: false, thoughtKept: { previousTurn: false, currentTurn: false } }), '[chat] wrapper JinjaTemplate · segments null · réflexion ouverte par le modèle de conversation : oui · contexte après les outils : non · réflexion renvoyée rendue en place : non (tour précédent), non (tour en cours)');
  assert.equal(last.wrapper.opensThought, false, 'stories260K has no think: the reply never starts as reasoning (Task 5b)');
  const again: LoadEvent[] = [];
  await localProvider(modelPath).contextWindow({ onLoad: e => again.push(e) });
  assert.deepEqual(again, [], 'the warm engine was reused: no load, no event');
});

test('d. completeLocal reports its stats once, and a plain model gets no reasoning key', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  const stats: GenerationStats[] = [];
  const message = await completeLocal({ modelPath, messages: [{ role: 'user', content: 'Once upon a time' }], maxTokens: 16, onStats: s => stats.push(s) });
  assert.equal(stats.length, 1, JSON.stringify(stats));
  assert.ok(stats[0].outputTokens >= 1 && stats[0].outputTokens <= 16, JSON.stringify(stats[0]));
  assert.ok(stats[0].inputTokens > 0, JSON.stringify(stats[0]));
  assert.ok(stats[0].generationMs >= 0);
  assert.equal('reasoning' in message, false);
  assert.equal('reasoningMs' in message, false);
});

test('e. a stopped generation still reports its stats', { timeout: 60000 }, async t => {
  t.after(() => disposeEngine());
  const stats: GenerationStats[] = [];
  const c = new AbortController();
  await assert.rejects(completeLocal({ modelPath, messages: [{ role: 'user', content: 'Once upon a time' }], maxTokens: 200, signal: c.signal,
    onDelta: () => c.abort(), onStats: s => stats.push(s) }), { name: 'AbortError' });
  assert.equal(stats.length, 1, JSON.stringify(stats));
  assert.ok(stats[0].outputTokens >= 1, JSON.stringify(stats[0]));
});

// I1 (final review): on a model whose thought is a native segment (Qwen3), node-llama-cpp sends an EMPTY segment-start
// chunk as soon as the prompt starts being read; the rate's clock started there, so it counted the prompt reading
// as generation (part B: 0,4 tok/s shown, about 0,5 real). The clock starts at the first chunk that carries tokens.
test('GenerationMeter: an empty segment-start chunk does not start the generation clock; the first token does', () => {
  let now = 1000;
  const meter = new GenerationMeter(() => now);
  meter.chunk(0); // the segment start, sent before the prompt is read
  now += 60000; // reading a 4000-token prompt
  meter.chunk(3);
  now += 1500;
  meter.chunk(0);
  meter.chunk(2);
  now += 500;
  assert.deepEqual(meter.stats(17), { inputTokens: 17, outputTokens: 5, generationMs: 2000 });
  const idle = new GenerationMeter(() => now);
  idle.chunk(0);
  now += 5000;
  assert.deepEqual(idle.stats(4), { inputTokens: 4, outputTokens: 0, generationMs: 0 }, 'no token written: no generation time');
});

test('f. a real load reports its stages and the model architecture; a generation reports promptMs and its reuse', { timeout: 60000 }, async t => {
  const ends: LoadEvent[] = [];
  t.after(() => disposeEngine());
  await disposeEngine();
  const stats: GenerationStats[] = [];
  for (const text of ['Once upon a time', 'Once upon a time there']) {
    await completeLocal({ modelPath, messages: [{ role: 'user', content: text }], maxTokens: 8, onStats: s => stats.push(s),
      onLoad: (e: LoadEvent) => { if (e.kind === 'end') ends.push(e); } });
  }
  assert.equal(ends.length, 1, 'one real load, the second call reuses the warm engine');
  const end = ends[0] as Extract<LoadEvent, { kind: 'end' }>;
  assert.deepEqual(end.stages.map(s => s.stage), ['engine', 'precheck', 'loadModel', 'createContext', 'chat']);
  assert.ok(end.stages.every(s => s.ok && s.ms >= 0));
  assert.deepEqual(end.architecture, { hybrid: false, recurrent: false, swaSize: null, mtpWeights: false });
  assert.ok(stats[0].promptMs != null && stats[0].promptMs >= 0);
  assert.equal(stats[0].reuse?.held, 0);
  assert.ok((stats[1].reuse?.reused ?? 0) > 0, 'the second prompt starts like the first: an attention model reuses it');
});

// Ruling F5: no `budgets` unless a thought cap applies — without one, LlamaChat limits no segment, as today.
test('generationLimits: the shipped levers send no budgets and the cap; a thought cap sends budgets; the lever bounds any maxTokens', () => {
  assert.deepEqual(generationLimits(SHIPPED_LEVERS, undefined), { maxTokens: LOCAL_OUTPUT_CAP });
  assert.equal('budgets' in generationLimits(SHIPPED_LEVERS, 100), false);
  assert.deepEqual(generationLimits(SHIPPED_LEVERS, 100), { maxTokens: 100 });
  assert.deepEqual(generationLimits({ ...SHIPPED_LEVERS, outputCap: 32, thoughtTokens: 512 }, 1000), { maxTokens: 32, budgets: { thoughtTokens: 512 } });
  assert.deepEqual(generationLimits({ ...SHIPPED_LEVERS, thoughtTokens: 0 }, undefined), { maxTokens: LOCAL_OUTPUT_CAP, budgets: { thoughtTokens: 0 } });
});

// « Longueur maximale de la réflexion » (Task 9, rulings F5 and T9/F5): no limit means no `budgets` at all — the
// request is today's (node-llama-cpp 3.21.1 caps an undefined thoughtTokens at 75 % of the context, not no budgets).
test('thoughtBudget: null when neither the setting nor the lever caps; the lever wins over the setting; no budgets without a cap', () => {
  assert.equal(thoughtBudget(null, null), null);
  assert.equal(thoughtBudget(1024, null), 1024);
  assert.equal(thoughtBudget(1024, 256), 256);
  assert.equal(thoughtBudget(null, 256), 256);
  // What generateResponse receives (completeLocal spreads generationLimits into its options).
  assert.equal('budgets' in generationLimits(SHIPPED_LEVERS, 100, null), false);
  assert.equal('budgets' in generationLimits(SHIPPED_LEVERS, undefined), false);
  assert.deepEqual(generationLimits(SHIPPED_LEVERS, 100, 1024), { maxTokens: 100, budgets: { thoughtTokens: 1024 } });
  assert.deepEqual(generationLimits({ ...SHIPPED_LEVERS, thoughtTokens: 256 }, 100, 1024), { maxTokens: 100, budgets: { thoughtTokens: 256 } });
});

test('sequenceOptions passes the checkpoint levers to getSequence as they are', () => {
  assert.deepEqual(sequenceOptions(SHIPPED_LEVERS), { checkpoints: { max: 32, interval: 8192, maxMemory: null } });
  assert.deepEqual(sequenceOptions({ ...SHIPPED_LEVERS, checkpointInterval: 512, checkpointMaxMemory: 1 << 30 }).checkpoints, { max: 32, interval: 512, maxMemory: 1 << 30 });
});

// Task 3b: the prompt checkpoint. stories260K is an attention model (needsCheckpoints false), so takeCheckpoint is a
// no-op there: these tests prove WHERE the checkpoint is taken and that LlamaChat then reads only the rest of the
// prompt, never that a hybrid model restores from it (S2 measures that on the 27B).
// The two parts of the Qwen 3.6 27B template (S1's model, read from its GGUF header) that decide where the next turn
// diverges: an assistant turn is rendered back with its thought (stripped, so empty), and the generation prompt opens
// the thought itself.
const QWEN_LIKE_TEMPLATE = "{%- for message in messages %}{%- if message.role == 'assistant' %}{%- set reasoning_content = '' %}{%- if message.reasoning_content is string %}{%- set reasoning_content = message.reasoning_content|trim %}{%- endif %}{{ '<|im_start|>assistant\\n<think>\\n' + reasoning_content + '\\n</think>\\n\\n' + message.content + '<|im_end|>\\n' }}{%- else %}{{ '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>\\n' }}{%- endif %}{%- endfor %}{%- if add_generation_prompt %}{{ '<|im_start|>assistant\\n<think>\\n' }}{%- endif %}";

test('stablePromptLength: the prompt but its last token, for a template that opens the thought (the 27B\'s) and for a plain one', { timeout: 60000 }, async t => {
  const model = await (await runtimeLlama()).loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 512 });
  t.after(async () => { await context.dispose(); await model.dispose(); });
  const history: GgufHistoryItem[] = [{ type: 'system', text: 'You are a storyteller.' }, { type: 'user', text: 'Once upon a time' }];
  const qwenWrapper = new JinjaTemplateChatWrapper({ template: QWEN_LIKE_TEMPLATE });
  assert.deepEqual(qwenWrapper.settings.segments?.thought?.prefix, { type: 'openedOnStart' }, 'node-llama-cpp reads this template as the 27B\'s');
  const qwen = stablePromptLength(qwenWrapper, model.tokenizer, history, undefined);
  assert.ok(model.detokenize(qwen.tokens, true).endsWith('assistant\n<think>\n'), 'the prompt ends inside the opened thought');
  assert.equal(qwen.stable, qwen.tokens.length - 1);
  assert.equal(model.detokenize(qwen.tokens.slice(qwen.stable), true), '\n', 'left out: the one token the next turn renders as \\n\\n');
  const plain = stablePromptLength(new LlamaChat({ contextSequence: context.getSequence() }).chatWrapper, model.tokenizer, history, undefined);
  assert.equal(plain.stable, plain.tokens.length - 1, 'Llama2Chat renders the reply after the whole prompt: all but the token LlamaChat reads itself');
});

// Both the stories default wrapper (Llama2Chat, no tools) and the 27B's path (openedOnStart thought, tools rendered by
// node-llama-cpp itself since the template has none): the lever's prompt must be LlamaChat's to the token.
const STORY_TOOLS: GgufFunctions = { get_time: { description: 'The current time', params: { type: 'object', properties: {} } } };
const MIRROR_CASES: [string, () => JinjaTemplateChatWrapper | undefined, GgufFunctions | undefined][] = [
  ['Llama2Chat', () => undefined, undefined],
  ['QWEN_LIKE (openedOnStart) with tools', () => new JinjaTemplateChatWrapper({ template: QWEN_LIKE_TEMPLATE }), STORY_TOOLS],
];
for (const [name, makeWrapper, functions] of MIRROR_CASES) {
  test(`checkpointPromptEnd, ${name}: the prompt is evaluated up to its stable end and checkpointed there; LlamaChat reads only the rest, and the next prompt diverges at or after it`, { timeout: 60000 }, async t => {
    const model = await (await runtimeLlama()).loadModel({ modelPath });
    const context = await model.createContext({ contextSize: 2048 });
    t.after(async () => { await context.dispose(); await model.dispose(); });
    const sequence = context.getSequence();
    const wrapper = makeWrapper();
    const chat = new LlamaChat({ contextSequence: sequence, ...(wrapper ? { chatWrapper: wrapper } : {}) });
    let history: GgufHistoryItem[] = [{ type: 'system', text: 'You are a storyteller.' }, { type: 'user', text: 'Once upon a time' }];
    let previous: PromptCheckpointFigures | null = null;
    for (const next of ['And then', 'The end']) {
      const held = sequence.contextTokens;
      const { tokens } = stablePromptLength(chat.chatWrapper, model.tokenizer, history, functions);
      const divergence = commonPrefixLength(held, tokens);
      // The property the lever exists for: the previous checkpoint sits before where this prompt diverges.
      if (previous) assert.ok(previous.index !== null && previous.index < divergence, `checkpoint ${previous.index} < divergence ${divergence}`);
      const before = sequence.tokenMeter.getState();
      const figures = await checkpointPromptEnd(sequence, chat.chatWrapper, history, functions);
      assert.ok(figures);
      assert.deepEqual(figures, { prompt: tokens.length, stable: figures.stable, from: divergence, index: figures.stable - 1 });
      assert.ok(figures.stable > divergence && figures.stable < tokens.length);
      assert.deepEqual(sequence.contextTokens, tokens.slice(0, figures.stable), 'the state at the checkpoint is the prompt up to its stable end');
      const reply = await chat.generateResponse(chatHistoryOf(history), { maxTokens: 8, ...(functions ? { functions: functions as ChatModelFunctions } : {}) });
      assert.deepEqual(sequence.contextTokens.slice(0, tokens.length), tokens, 'LlamaChat evaluated the same prompt the lever predicted');
      // Read once in all (the last prompt token is counted as output, F27): nothing pre-evaluated was read again.
      assert.equal(sequence.tokenMeter.diff(before).usedInputTokens, tokens.length - 1 - divergence);
      history = [...history, { type: 'model', response: [reply.response] }, { type: 'user', text: next }];
      previous = figures;
    }
  });
}

// Task 5 (keepThought): with the thoughts sent back, the lever's prompt must stay LlamaChat's to the token — a previous
// turn's kept thought, and tool steps whose model item ends in a function call after a thought, where LlamaChat reopens
// the thought before reading (`reopenAfterFunctionCalls`, uncovered in 3b). The toy model never calls a tool: the tool
// steps are written by hand.
const thought = (text: string) => ({ type: 'segment' as const, segmentType: 'thought' as const, text, ended: true as const });
const toolStep = (result: string) => ({ type: 'functionCall' as const, name: 'get_time', params: {}, result });
const KEPT_THOUGHT_HISTORIES: GgufHistoryItem[][] = [
  [{ type: 'system', text: 'You are a storyteller.' }, { type: 'user', text: 'Once upon a time' }, { type: 'model', response: [thought('She thought of a cat.'), 'A cat came.'] }, { type: 'user', text: 'And then' }],
  [{ type: 'system', text: 'You are a storyteller.' }, { type: 'user', text: 'Once upon a time' }, { type: 'model', response: [thought('What time is it?'), toolStep('noon')] }],
  [{ type: 'system', text: 'You are a storyteller.' }, { type: 'user', text: 'Once upon a time' }, { type: 'model', response: [thought('What time is it?'), toolStep('noon'), thought('Again.'), toolStep('one')] }],
];
const KEPT_THOUGHT_CASES: [string, () => ChatWrapper | undefined, GgufFunctions | undefined, number[]][] = [
  ['Llama2Chat', () => undefined, undefined, [0]],
  ['QWEN_LIKE (openedOnStart, reopens after calls) with tools', () => new JinjaTemplateChatWrapper({ template: QWEN_LIKE_TEMPLATE }), STORY_TOOLS, [0, 1, 2]],
  ['QwenChatWrapper keeping past thoughts, with tools', () => new QwenChatWrapper({ keepOnlyLastThought: false }), STORY_TOOLS, [0, 1, 2]],
];
for (const [name, makeWrapper, functions, cases] of KEPT_THOUGHT_CASES) {
  test(`checkpointPromptEnd with kept thoughts, ${name}: LlamaChat evaluates the prompt the lever predicted and reads only the rest`, { timeout: 60000 }, async t => {
    const model = await (await runtimeLlama()).loadModel({ modelPath });
    const context = await model.createContext({ contextSize: 2048 });
    t.after(async () => { await context.dispose(); await model.dispose(); });
    const sequence = context.getSequence();
    const wrapper = makeWrapper();
    const chat = new LlamaChat({ contextSequence: sequence, ...(wrapper ? { chatWrapper: wrapper } : {}) });
    for (const index of cases) {
      const history = KEPT_THOUGHT_HISTORIES[index];
      await sequence.clearHistory(); // each history from an empty state: the checkpoint is really taken, not skipped because an earlier case already held the prompt
      const { tokens } = stablePromptLength(chat.chatWrapper, model.tokenizer, history, functions);
      const divergence = commonPrefixLength(sequence.contextTokens, tokens);
      const before = sequence.tokenMeter.getState();
      const figures = await checkpointPromptEnd(sequence, chat.chatWrapper, history, functions);
      assert.ok(figures && figures.index !== null, `history ${index}: checkpointed ${JSON.stringify(figures)} held ${model.detokenize(sequence.contextTokens, true).slice(-80)} prompt ${model.detokenize(tokens, true).slice(-120)}`);
      await chat.generateResponse(chatHistoryOf(history), { maxTokens: 4, ...(functions ? { functions: functions as ChatModelFunctions } : {}) });
      assert.deepEqual(model.detokenize(sequence.contextTokens.slice(0, tokens.length), true), model.detokenize(tokens, true), `history ${index}: the same text`);
      assert.deepEqual(sequence.contextTokens.slice(0, tokens.length), tokens, `history ${index}: LlamaChat evaluated the prompt the lever predicted`);
      assert.equal(sequence.tokenMeter.diff(before).usedInputTokens, tokens.length - 1 - divergence, `history ${index}: nothing pre-evaluated was read again`);
    }
  });
}

// Review I1: a stopped turn must not run a full prompt decode (about 30 s on the 27B) before its stop takes effect.
test('checkpointPromptEnd: an aborted signal rejects before anything is evaluated', { timeout: 60000 }, async t => {
  const model = await (await runtimeLlama()).loadModel({ modelPath });
  const context = await model.createContext({ contextSize: 2048 });
  t.after(async () => { await context.dispose(); await model.dispose(); });
  const sequence = context.getSequence();
  const chat = new LlamaChat({ contextSequence: sequence });
  const before = sequence.tokenMeter.getState();
  await assert.rejects(checkpointPromptEnd(sequence, chat.chatWrapper, [{ type: 'user', text: 'Once upon a time' }], undefined, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(sequence.tokenMeter.diff(before).usedInputTokens, 0);
  assert.equal(sequence.nextTokenIndex, 0);
});

test('TurnLock: one task at a time in call order; a stopped waiter is released at once and its task never runs (review M2)', async () => {
  const lock = new TurnLock();
  const order: string[] = [];
  let release!: () => void;
  const first = lock.run(async () => { order.push('first start'); await new Promise<void>(r => { release = r; }); order.push('first end'); });
  const controller = new AbortController();
  const stopped = lock.run(async () => { order.push('stopped ran'); }, controller.signal);
  const third = lock.run(async () => { order.push('third'); });
  await new Promise(r => setImmediate(r));
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(stopped, { name: 'AbortError' });
  assert.deepEqual(order, ['first start'], 'the third still waits for the first');
  release();
  await Promise.all([first, third]);
  assert.deepEqual(order, ['first start', 'first end', 'third']);
});
