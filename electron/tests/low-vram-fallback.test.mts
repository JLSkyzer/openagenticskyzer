// A full card must not refuse a model the RAM can hold (turn diagnostics, Task 1b). With a game holding most of the
// VRAM, node-llama-cpp's fitContext resolution throws InsufficientMemoryError as soon as even 0 layers needs some
// VRAM (3.21.1, resolveModelGpuLayersOption.js), and the app showed « Modèle trop gros » for a 1 MB model with 11 GiB
// of free RAM. Now the load and the estimate both fall back to the processor through the same cpuFallback, and refuse
// only when the RAM cannot hold it. Real node-llama-cpp, stories260K only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufFileInfo, GgufInsights } from 'node-llama-cpp';
import { cpuFallback, placementLogLine, outcomeNote, stepDownMax, MAX_STEP_DOWNS } from '../core/local-engine.mts';
import { runtimeLlama, envGpuChoice, vramPaddingFor } from '../core/llama-runtime.mts';
import { removeAtEnd } from './teardown.mts';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const modelPath = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

/** Runs `body` in a Node process of its own, from a script FILE: node-llama-cpp tests a GPU binary in a fork() that
 * inherits execArgv, so an `-e` child can never resolve a card. `n` node-llama-cpp (the very module the engine
 * imports), `m` core/local-engine.mts, `r` core/llama-runtime.mts, `e` core/offload-estimate.mts. NODE_LLAMA_CPP_GPU is removed: the runtime Llama resolves « auto » as the app does. */
async function inChild(t: { after(fn: () => unknown): void }, body: string): Promise<{ out: any; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openagent-low-vram-'));
  removeAtEnd(t, root);
  const script = join(root, 'child.mjs');
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  await writeFile(script, `
    const n = await import(${JSON.stringify(import.meta.resolve('node-llama-cpp'))});
    const m = await import(${url('../core/local-engine.mts')});
    const r = await import(${url('../core/llama-runtime.mts')});
    const e = await import(${url('../core/offload-estimate.mts')});
    const out = {};
    ${body}
    await r.disposeLlama();
    process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n');`);
  const env: NodeJS.ProcessEnv = { ...process.env, OPENAGENT_HOME: root };
  delete env.NODE_LLAMA_CPP_GPU;
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--experimental-strip-types', script], {
    env, maxBuffer: 16 * 1024 * 1024, timeout: 150000,
  });
  const line = stdout.split('\n').find(text => text.startsWith('RESULT '));
  assert.ok(line, `the child printed its result: ${stdout.slice(-800)} ${stderr.slice(-800)}`);
  return { out: JSON.parse(line.slice('RESULT '.length)), stdout, stderr };
}

test('a full card (setVramCap(1)): stories260K at 16384 tokens loads on the processor, generates, and the estimate says « processeur »', { timeout: 200000 }, async t => {
  const { out, stdout } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      // Not 0: a total of 0 makes the resolver answer 0 layers without the error the user saw.
      await llama.setVramCap(1);
      out.estimate = await e.estimatePlacement({ kind: 'file', path }, { contextSize: 16384 });
      try { out.placement = await m.loadLocalModel(path, 16384); } catch (error) { out.message = error.message; }
      if (out.placement) {
        out.loadsBefore = m.nativeLoadCount();
        const reply = await m.completeLocal({ modelPath: path, messages: [{ role: 'user', content: 'Once upon a time' }], maxTokens: 16, contextRequest: { setting: 16384 } });
        out.text = reply.content;
        out.after = m.loadedPlacement(path);
        out.loads = m.nativeLoadCount();
      }
      await m.disposeEngine();
      out.live = m.liveModelCount();
    }`);
  if (out.gpu === false) {
    t.skip('no GPU backend here: a processor Llama never asks the card for anything');
    return;
  }
  assert.equal(out.message, undefined, `the load was not refused: ${out.message}`);
  assert.equal(out.placement.gpuLayers, 0, 'no layer on the card');
  assert.equal(out.placement.fit, 'cpu');
  assert.equal(out.placement.contextSize >= 16384, true);
  assert.equal(typeof out.text, 'string');
  assert.ok(out.text.length > 0, 'a real generation returned text');
  assert.equal(out.loadsBefore, 2, 'one fitContext attempt refused, then the fallback load');
  assert.equal(out.loads, out.loadsBefore, 'the generation reused the fallback load');
  assert.equal(out.after.gpuLayers, 0);
  assert.equal(out.live, 0, 'nothing leaked');
  assert.equal(out.estimate.gpuLayers, 0, 'the estimate gives 0 layers');
  assert.equal(out.estimate.fit, 'cpu', 'the estimate says « processeur seul », not « ne tient pas »');
  const placement = stdout.split('\n').filter(line => line.startsWith('[placement]'));
  assert.equal(placement.length, 1, stdout.slice(-2000));
  assert.match(placement[0], /couches 0\/\d+/);
  assert.match(placement[0], /repli processeur/);
  assert.match(placement[0], /mmap oui/, 'the fallback keeps mmap: the weights are mapped, not copied into RAM');
});

// The regression of 2026-10-24 (.superpowers/runs/cuda-placement-regression.md): a 27B loaded 25/66 layers on the
// card, then createContext threw InsufficientMemoryError (the context did not fit the VRAM left), and the single try
// of Task 1b sent it to the processor fallback: 0/66. createContext refusing once must cost a few layers, not all.
/** In the child: createContext throws `error` on its first call made without ignoreMemorySafetyChecks, then works. */
const failFirstContext = (error: string) => `
    const original = n.LlamaModel.prototype.createContext;
    out.refusals = 0;
    n.LlamaModel.prototype.createContext = function (options = {}) {
      if (out.refusals === 0 && !options.ignoreMemorySafetyChecks) {
        out.refusals += 1;
        out.refusedAt = this.gpuLayers;
        return Promise.reject(${error});
      }
      return original.call(this, options);
    };`;

test('A: createContext refusing the context once (InsufficientMemoryError) retries with fewer layers, still on the card, never the processor fallback', { timeout: 200000 }, async t => {
  const { out, stdout, stderr } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      ${failFirstContext(`new n.InsufficientMemoryError('A context size of 16384 is too large for the available VRAM')`)}
      try { out.placement = await m.loadLocalModel(path, 16384); } catch (error) { out.message = error.message; }
      out.loads = m.nativeLoadCount();
      out.liveLoaded = m.liveModelCount();
      out.outcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.live = m.liveModelCount();
    }`);
  if (out.gpu === false) {
    t.skip('no GPU backend here: a processor Llama has no layer to step down');
    return;
  }
  assert.equal(out.message, undefined, `the load was not refused: ${out.message}`);
  assert.equal(out.refusals, 1, 'the refusal really happened');
  assert.ok(out.refusedAt > 0, `the first load put layers on the card: ${out.refusedAt}`);
  assert.ok(out.placement.gpuLayers > 0, `still on the card: ${out.placement.gpuLayers} layers`);
  assert.ok(out.placement.gpuLayers < out.refusedAt, 'with fewer layers than the refused attempt');
  assert.notEqual(out.placement.fit, 'cpu');
  assert.equal(out.loads, 2, 'the refused load, then one retry');
  assert.equal(out.liveLoaded, 1, 'the refused model was freed');
  assert.equal(out.live, 0, 'nothing leaked');
  assert.deepEqual(out.outcome, { kind: 'step-down', refused: [out.refusedAt] });
  const placement = stdout.split('\n').filter(line => line.startsWith('[placement]'));
  assert.equal(placement.length, 1, stdout.slice(-2000));
  assert.doesNotMatch(placement[0], /repli/);
  assert.doesNotMatch(placement[0], /carte pleine/);
  assert.match(placement[0], /moins de couches/);
  assert.match(stderr, new RegExp(`\\[placement\\] InsufficientMemoryError \\(createContext, ${out.refusedAt} couches\\) : A context size of 16384 is too large`), stderr.slice(-2000));
});

test('a context refused at every step-down ends on the processor after MAX_STEP_DOWNS retries, said as such, not « carte pleine »', { timeout: 200000 }, async t => {
  const { out, stdout, stderr } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      const original = n.LlamaModel.prototype.createContext;
      out.layers = [];
      n.LlamaModel.prototype.createContext = function (options = {}) {
        if (!options.ignoreMemorySafetyChecks) { out.layers.push(this.gpuLayers); return Promise.reject(new n.InsufficientMemoryError('too large for the available VRAM')); }
        return original.call(this, options);
      };
      const events = [];
      try { out.placement = await m.loadLocalModel(path, 16384, { onLoad: event => events.push(event.kind === 'retry' ? 'retry:' + event.mode : event.kind) }); } catch (error) { out.message = error.message; }
      out.events = events.filter(kind => kind !== 'progress');
      out.outcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.live = m.liveModelCount();
    }`);
  if (out.gpu === false) {
    t.skip('no GPU backend here');
    return;
  }
  assert.equal(out.message, undefined, `the load was not refused: ${out.message}`);
  assert.equal(out.placement.gpuLayers, 0);
  assert.equal(out.layers.length, 1 + 3, `the first load, then three with fewer layers: ${out.layers}`);
  for (let i = 1; i < out.layers.length; i++) assert.ok(out.layers[i] < out.layers[i - 1] || out.layers[i] === 0, `fewer layers each time: ${out.layers}`);
  assert.deepEqual(out.outcome, { kind: 'fallback', cause: 'createContext', refused: out.layers });
  assert.deepEqual(out.events, ['start', 'retry:fewer-layers', 'retry:fewer-layers', 'retry:fewer-layers', 'retry:cpu', 'end'], 'each new load is announced');
  assert.equal(out.live, 0);
  const placement = stdout.split('\n').filter(line => line.startsWith('[placement]'));
  assert.equal(placement.length, 1);
  assert.match(placement[0], /repli processeur : le contexte ne tenait toujours pas/);
  assert.doesNotMatch(placement[0], /carte pleine/);
  assert.equal(stderr.split('\n').filter(line => line.includes('[placement] InsufficientMemoryError (createContext,')).length, 4, stderr.slice(-2000));
});

test('B: a plain Error from createContext comes out unchanged, with no retry and no fallback', { timeout: 200000 }, async t => {
  const { out, stdout } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    ${failFirstContext(`new Error('x')`)}
    try { out.placement = await m.loadLocalModel(path, 16384); } catch (error) { out.message = error.message; out.name = error.constructor.name; }
    out.loads = m.nativeLoadCount();
    out.live = m.liveModelCount();
    out.warm = m.warmModelPath();`);
  assert.equal(out.refusals, 1);
  assert.equal(out.message, 'x', 'the error itself');
  assert.equal(out.name, 'Error');
  assert.equal(out.loads, 1, 'no retry, no fallback load');
  assert.equal(out.live, 0, 'the model was freed');
  assert.equal(out.warm, null);
  assert.equal(stdout.split('\n').filter(line => line.startsWith('[placement]')).length, 0);
});

test('C: nothing the app does lowers the free VRAM the resolver reads: no cap, no reservation, the padding of the backend, before and after a load and a cancelled estimate', { timeout: 200000 }, async t => {
  const { out } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      const read = async () => {
        const seen = await llama._vramOrchestrator.getMemoryState();
        const native = await llama.getVramState();
        return { cap: llama.getVramCap(), reserved: llama._vramOrchestrator._reservedMemory, padding: llama.vramPaddingSize, total: native.total, seen: seen.free, expected: Math.max(0, native.free - llama.vramPaddingSize) };
      };
      out.before = await read();
      await m.loadLocalModel(path, 16384);
      await m.disposeEngine();
      out.afterLoad = await read();
      const controller = new AbortController();
      const estimate = e.estimatePlacement({ kind: 'file', path }, { contextSize: 16384, signal: controller.signal, onPhase: phase => { if (phase === 'insights') controller.abort(); } });
      try { await estimate; out.estimateEnded = 'done'; } catch (error) { out.estimateEnded = error.name; }
      out.afterEstimate = await read();
    }`);
  if (out.gpu === false) {
    t.skip('no GPU backend here: no VRAM to read');
    return;
  }
  assert.equal(out.estimateEnded, 'AbortError', 'the estimate was cancelled');
  const own = vramPaddingFor(out.gpu, process.platform);
  for (const name of ['before', 'afterLoad', 'afterEstimate']) {
    const state = out[name];
    assert.equal(state.cap, null, `${name}: no VRAM cap`);
    assert.equal(state.reserved, 0, `${name}: no reservation left`);
    assert.equal(state.padding, own ? own(state.total) : Math.floor(Math.min(state.total * 0.08, 1.6 * GIB)), `${name}: the backend's padding`);
    assert.ok(Math.abs(state.seen - state.expected) <= 64 * 1024 ** 2, `${name}: the resolver's free (${state.seen}) is the native free minus the padding (${state.expected})`);
  }
});

test('cpuFallback: fits when the RAM holds 0 layers at that context, not when it does not', { timeout: 60000 }, async () => {
  const insights = await GgufInsights.from(await readGgufFileInfo(modelPath), await runtimeLlama());
  const fits = await cpuFallback(insights, 16384, true);
  assert.equal(fits.fits, true);
  assert.ok(fits.ramBytes > 0, 'the RAM figure is the 0-layer estimate');
  const tooSmall = await cpuFallback(insights, 16384, true, { ramTotal: fits.ramBytes - 1 });
  assert.deepEqual({ ...tooSmall, fits: false }, tooSmall, 'one byte short: it does not fit');
  assert.equal(tooSmall.ramBytes, fits.ramBytes, 'same estimate, only the total changed');
  assert.equal((await cpuFallback(insights, 16384, true, { ramTotal: fits.ramBytes })).fits, true, 'exactly enough fits, the rule of fitOf');
});

test('the [placement] line says how the load got there: as placed, fewer layers, or the processor — and « carte pleine » only when it was', () => {
  const base = { backend: 'vulkan', gpuLayers: 0, totalLayers: 6, useMmap: true, vramBefore: null, padding: 0, contextSize: 16384 };
  assert.doesNotMatch(placementLogLine(base), /repli|moins de couches/);
  assert.doesNotMatch(placementLogLine({ ...base, outcome: { kind: 'direct' } }), /repli|moins de couches/);
  const stepped = placementLogLine({ ...base, gpuLayers: 22, totalLayers: 66, outcome: { kind: 'step-down', refused: [25] } });
  assert.match(stepped, /couches 22\/66 sur la carte · moins de couches : le contexte ne tenait pas sur la carte avec 25 couches ·/);
  assert.doesNotMatch(stepped, /repli|carte pleine/);
  const full = placementLogLine({ ...base, outcome: { kind: 'fallback', cause: 'loadModel', refused: [] } });
  assert.match(full, /repli processeur : la carte ne prenait même pas 0 couche avec ce contexte \(carte pleine\)/);
  const context = placementLogLine({ ...base, outcome: { kind: 'fallback', cause: 'createContext', refused: [25, 22, 19, 17] } });
  assert.match(context, /repli processeur : le contexte ne tenait toujours pas sur la carte \(essais à 25 puis 22 puis 19 puis 17 couches\)/);
  assert.doesNotMatch(context, /carte pleine/, 'the card was not full: the context did not fit');
  assert.equal(outcomeNote(undefined), '');
});

test('stepDownMax: about 10 % fewer layers, at least one, none below 1', () => {
  assert.equal(stepDownMax(25), 22);
  assert.equal(stepDownMax(66), 59);
  assert.equal(stepDownMax(6), 5);
  assert.equal(stepDownMax(2), 1);
  assert.equal(stepDownMax(1), null);
  assert.equal(stepDownMax(0), null);
  assert.equal(MAX_STEP_DOWNS, 3);
});

test('envGpuChoice reads NODE_LLAMA_CPP_GPU as node-llama-cpp does', () => {
  for (const value of [undefined, '', 'auto', 'whatever']) assert.equal(envGpuChoice(value), 'auto', String(value));
  for (const value of ['false', 'off', 'none', 'disable', 'disabled']) assert.equal(envGpuChoice(value), 'cpu', value);
  for (const value of ['cuda', 'vulkan', 'metal'] as const) assert.equal(envGpuChoice(value), value);
});

test('the padding goes with the backend really resolved: per backend and platform, and « auto » gets the one of what it became', { timeout: 120000 }, async t => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const backend of ['cuda', 'vulkan', 'metal', 'cpu'] as const) {
      const padding = vramPaddingFor(backend, platform);
      if (backend === 'vulkan' && platform === 'win32') assert.equal(padding?.(8 * GIB), Math.floor(8 * GIB * 0.2));
      else assert.equal(padding, undefined, `${backend} on ${platform}: node-llama-cpp's default`);
    }
  }
  const { out } = await inChild(t, `
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    out.padding = llama.vramPaddingSize;
    out.total = llama.gpu === false ? 0 : (await llama.getVramState()).total;`);
  if (out.gpu === false) {
    assert.equal(out.padding, 0);
    return;
  }
  const own = vramPaddingFor(out.gpu, process.platform);
  const expected = own ? own(out.total) : Math.floor(Math.min(out.total * 0.08, 1.6 * GIB));
  assert.equal(out.padding, expected, `auto resolved to ${out.gpu}: its own padding`);
});
