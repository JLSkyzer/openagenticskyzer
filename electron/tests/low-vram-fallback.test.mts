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
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufFileInfo, GgufInsights } from 'node-llama-cpp';
import { cpuFallback, placementLogLine, outcomeNote, stepDownMax, MAX_STEP_DOWNS, limitStillHolds, LIMIT_RETRY_MIN_BYTES } from '../core/local-engine.mts';
import { runtimeLlama, envGpuChoice, vramPaddingFor } from '../core/llama-runtime.mts';
import { removeAtEnd } from './teardown.mts';
import { PERF_LEVERS_ENV } from '../core/perf-levers.mts';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const modelPath = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

/** Runs `body` in a Node process of its own, from a script FILE: node-llama-cpp tests a GPU binary in a fork() that
 * inherits execArgv, so an `-e` child can never resolve a card. `n` node-llama-cpp (the very module the engine
 * imports), `m` core/local-engine.mts, `r` core/llama-runtime.mts, `e` core/offload-estimate.mts. NODE_LLAMA_CPP_GPU is removed: the runtime Llama resolves « auto » as the app does. */
async function inChild(t: { after(fn: () => unknown): void }, body: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ out: any; stdout: string; stderr: string }> {
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
  const env: NodeJS.ProcessEnv = { ...process.env, OPENAGENT_HOME: root, ...extraEnv };
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

// Part B of 2026-10-24: the 27B stepped down 25 → 22 → 19 on EVERY cold load (3 loads, 33 s), and the estimate kept
// showing 25. A step-down's outcome is remembered per file, context size and hardware (layer-limits.v1.json beside the
// estimate cache): the next load starts at it, the estimate shows it.
/** In the child: the engine remembers its limits in `home` (as worker.mjs does with its EstimateCache), and `key(path,
 * size)` is that cache's key. */
const rememberIn = (home: string) => `
    const cache = new e.EstimateCache(${JSON.stringify(home)});
    m.setLayerLimits(cache.layerLimits());
    const key = async (p, size) => e.estimateKey({ kind: 'file', path: p }, size, await e.hardwareKey());`;

test('a remembered step-down: the second cold load makes exactly 1 attempt, at the remembered count, said in [placement], and the estimate shows it', { timeout: 200000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-layer-limit-'));
  removeAtEnd(t, home);
  const { out, stdout } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      ${rememberIn(home)}
      ${failFirstContext(`new n.InsufficientMemoryError('A context size of 16384 is too large for the available VRAM')`)}
      out.first = await m.loadLocalModel(path, 16384);
      out.firstOutcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.loads1 = m.nativeLoadCount();
      // The estimate of that key: node-llama-cpp's resolver would say refusedAt layers again; the known-good count wins.
      out.estimate = await e.estimateAndRemember(cache, await key(path, 16384), { kind: 'file', path }, { contextSize: 16384 });
      out.cached = await cache.get(await key(path, 16384));
      console.log('--- second load');
      const events = [];
      out.second = await m.loadLocalModel(path, 16384, { onLoad: event => events.push(event.kind === 'retry' ? 'retry:' + event.mode : event.kind) });
      out.events = events.filter(kind => kind !== 'progress');
      out.loads2 = m.nativeLoadCount();
      out.secondOutcome = m.loadedOutcome(path);
      out.decision = await m.replacementCheck(path);
      await m.disposeEngine();
      out.live = m.liveModelCount();
    }`);
  if (out.gpu === false) {
    t.skip('no GPU backend here: a processor Llama has no layer to step down');
    return;
  }
  const known = out.first.gpuLayers;
  assert.equal(out.refusals, 1, 'only the first load was refused');
  assert.ok(known > 0 && known < out.refusedAt, `the first load stepped down: ${out.refusedAt} → ${known}`);
  assert.deepEqual(out.firstOutcome, { kind: 'step-down', refused: [out.refusedAt] }, 'no limit known yet on the first load');
  assert.equal(out.loads2 - out.loads1, 1, 'the second cold load is a single load');
  assert.deepEqual(out.events, ['start', 'end'], 'no retry announced');
  assert.equal(out.second.gpuLayers, known, 'at the remembered count');
  assert.deepEqual(out.secondOutcome, { kind: 'direct', limit: known });
  assert.equal(out.estimate.gpuLayers, known, `the estimate shows the known-good count, not ${out.refusedAt}`);
  assert.equal(out.estimate.source, 'estimate');
  assert.equal(out.cached.gpuLayers, known, 'the cached estimate too');
  assert.equal(out.decision.replace, false, 'nothing changed: no re-placement');
  assert.doesNotMatch(out.decision.reason, /placement direct/, 'a limited load stays open to the re-placement');
  assert.equal(out.live, 0);
  const second = stdout.split('--- second load')[1].split('\n').filter(line => line.startsWith('[placement] backend'));
  assert.equal(second.length, 1, stdout.slice(-2000));
  assert.match(second[0], new RegExp(`couches ${known}/\\d+ sur la carte · limite mémorisée : ${known} couches ·`));
});

test('a remembered limit is ignored when the free VRAM grew past the threshold: the full fitContext runs again, and its higher success becomes the record', { timeout: 200000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-layer-limit-'));
  removeAtEnd(t, home);
  const { out, stdout } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      ${rememberIn(home)}
      ${failFirstContext(`new n.InsufficientMemoryError('too large for the available VRAM')`)}
      out.first = await m.loadLocalModel(path, 16384);
      await m.disposeEngine();
      out.loads1 = m.nativeLoadCount();
      // A game closed: 2 GiB more free than when the limit was noted (the threshold is max(4 layers, 512 MiB)).
      const read = llama.getVramState.bind(llama);
      llama.getVramState = async () => { const state = await read(); return { ...state, free: state.free + 2 * 1024 ** 3 }; };
      console.log('--- second load');
      out.second = await m.loadLocalModel(path, 16384);
      out.loads2 = m.nativeLoadCount();
      out.secondOutcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.limit = await cache.limit(await key(path, 16384));
    }`);
  if (out.gpu === false) {
    t.skip('no GPU backend here');
    return;
  }
  assert.ok(out.first.gpuLayers < out.refusedAt, 'the first load stepped down');
  assert.equal(out.loads2 - out.loads1, 1, 'one load');
  assert.equal(out.second.gpuLayers, out.refusedAt, 'the full fitContext placement, above the record');
  assert.deepEqual(out.secondOutcome, { kind: 'direct' }, 'no limit applied');
  assert.match(stdout.split('--- second load')[1], new RegExp(`\\[placement\\] limite mémorisée de ${out.first.gpuLayers} couches ignorée : \\d+ Mio de VRAM libres en plus`));
  assert.equal(out.limit.gpuLayers, out.refusedAt, 'the higher success updated the record');
});

test('a remembered limit is used only for its own key: another context size or another file mtime loads with the full fitContext', { timeout: 200000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-layer-limit-'));
  removeAtEnd(t, home);
  const copy = join(home, 'copy.gguf');
  await copyFile(modelPath, copy);
  const { out } = await inChild(t, `
    const path = ${JSON.stringify(copy)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      ${rememberIn(home)}
      ${failFirstContext(`new n.InsufficientMemoryError('too large for the available VRAM')`)}
      out.first = await m.loadLocalModel(path, 16384);
      await m.disposeEngine();
      out.loads1 = m.nativeLoadCount();
      out.otherSize = await m.loadLocalModel(path, 8192);
      out.otherSizeOutcome = m.loadedOutcome(path);
      await m.disposeEngine();
      const { utimes, stat } = await import('node:fs/promises');
      const { mtime } = await stat(path);
      await utimes(path, mtime, new Date(mtime.getTime() + 10000));
      out.otherMtime = await m.loadLocalModel(path, 16384);
      out.otherMtimeOutcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.loads2 = m.nativeLoadCount();
    }`);
  if (out.gpu === false) {
    t.skip('no GPU backend here');
    return;
  }
  assert.ok(out.first.gpuLayers < out.refusedAt, 'the first load stepped down');
  assert.equal(out.loads2 - out.loads1, 2, 'one load each');
  assert.equal(out.otherSize.gpuLayers, out.refusedAt, 'another context size: full fitContext');
  assert.deepEqual(out.otherSizeOutcome, { kind: 'direct' });
  assert.equal(out.otherMtime.gpuLayers, out.refusedAt, 'the file changed: full fitContext');
  assert.deepEqual(out.otherMtimeOutcome, { kind: 'direct' });
});

// Task 8, lever numericLimitLoad: a remembered limit is loaded as a plain number with an explicit useMmap, so
// node-llama-cpp checks that one count instead of searching every count up to the limit with fitContext. What changes is
// the gpuLayers option passed (F8: the load count, the « limite mémorisée » note and the resolved mmap are the same with
// the lever off), so the child records each llama.loadModel's options (a spy on the real call, which still runs).
const numericLimitLoad = { [PERF_LEVERS_ENV]: JSON.stringify({ numericLimitLoad: true }) };
/** In the child: a limit remembered by a first load that stepped down (`known`: its count), then `calls` lists the
 * gpuLayers and useMmap of every llama.loadModel from there on. `refuseNumeric`: the first numeric load throws the
 * resolver's InsufficientMemoryError instead of loading. */
const rememberedThenSpied = (home: string, refuseNumeric: boolean) => `
      ${rememberIn(home)}
      ${failFirstContext(`new n.InsufficientMemoryError('A context size of 16384 is too large for the available VRAM')`)}
      out.first = await m.loadLocalModel(path, 16384);
      await m.disposeEngine();
      out.loads1 = m.nativeLoadCount();
      out.supportsMmap = llama.supportsMmap;
      out.calls = [];
      let refuse = ${refuseNumeric};
      const load = llama.loadModel.bind(llama);
      llama.loadModel = options => {
        out.calls.push({ gpuLayers: options.gpuLayers, useMmap: options.useMmap ?? null });
        if (refuse && typeof options.gpuLayers === 'number') {
          refuse = false;
          return Promise.reject(new n.InsufficientMemoryError('Not enough VRAM to fit the model with the specified settings'));
        }
        return load(options);
      };
      console.log('--- second load');`;

test('numericLimitLoad: the second cold load makes one loadModel with gpuLayers equal to the remembered count and an explicit useMmap', { timeout: 200000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-layer-limit-'));
  removeAtEnd(t, home);
  const { out, stdout } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      ${rememberedThenSpied(home, false)}
      const events = [];
      out.second = await m.loadLocalModel(path, 16384, { onLoad: event => events.push(event.kind === 'retry' ? 'retry:' + event.mode : event.kind) });
      out.events = events.filter(kind => kind !== 'progress');
      out.loads2 = m.nativeLoadCount();
      out.secondOutcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.live = m.liveModelCount();
    }`, numericLimitLoad);
  if (out.gpu === false) {
    t.skip('no GPU backend here: a processor Llama has no layer limit');
    return;
  }
  const known = out.first.gpuLayers;
  assert.ok(known > 0 && known < out.refusedAt, `the first load stepped down: ${out.refusedAt} → ${known}`);
  assert.equal(out.loads2 - out.loads1, 1, 'one load');
  assert.deepEqual(out.calls, [{ gpuLayers: known, useMmap: out.supportsMmap }], 'the remembered count as a number, mmap said explicitly');
  assert.deepEqual(out.events, ['start', 'end'], 'no retry announced');
  assert.equal(out.second.gpuLayers, known);
  assert.deepEqual(out.secondOutcome, { kind: 'direct', limit: known });
  assert.equal(out.live, 0);
  const second = stdout.split('--- second load')[1].split('\n').filter(line => line.startsWith('[placement] backend'));
  assert.equal(second.length, 1, stdout.slice(-2000));
  assert.match(second[0], new RegExp(`couches ${known}/\\d+ sur la carte · limite mémorisée : ${known} couches · mmap ${out.supportsMmap ? 'oui' : 'non'} ·`));
});

test('numericLimitLoad: a numeric load refused by loadModel continues at fitContext ≤ the limit, never the processor', { timeout: 200000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-layer-limit-'));
  removeAtEnd(t, home);
  const { out, stdout, stderr } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      ${rememberedThenSpied(home, true)}
      const events = [];
      out.second = await m.loadLocalModel(path, 16384, { onLoad: event => events.push(event.kind === 'retry' ? 'retry:' + event.mode : event.kind) });
      out.events = events.filter(kind => kind !== 'progress');
      out.loads2 = m.nativeLoadCount();
      out.secondOutcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.live = m.liveModelCount();
    }`, numericLimitLoad);
  if (out.gpu === false) {
    t.skip('no GPU backend here: a processor Llama has no layer limit');
    return;
  }
  const known = out.first.gpuLayers;
  assert.deepEqual(out.calls, [
    { gpuLayers: known, useMmap: out.supportsMmap },
    { gpuLayers: { min: 0, max: known, fitContext: { contextSize: 16384 } }, useMmap: null },
  ], 'the numeric load, then today\'s fitContext search under the limit');
  assert.equal(out.loads2 - out.loads1, 2);
  assert.ok(out.second.gpuLayers > 0 && out.second.gpuLayers <= known, `still on the card, under the limit: ${out.second.gpuLayers}`);
  assert.notEqual(out.second.fit, 'cpu');
  assert.deepEqual(out.secondOutcome, { kind: 'direct', limit: known }, 'not the fallback');
  assert.ok(!out.events.includes('retry:cpu'), `no processor retry: ${out.events}`);
  assert.equal(out.live, 0);
  assert.match(stderr, new RegExp(`\\[placement\\] InsufficientMemoryError \\(loadModel, numérique ${known} couches\\) : Not enough VRAM`), stderr.slice(-2000));
  const second = stdout.split('--- second load')[1].split('\n').filter(line => line.startsWith('[placement] backend'));
  assert.equal(second.length, 1, stdout.slice(-2000));
  assert.doesNotMatch(second[0], /repli/);
});

test('numericLimitLoad: on a full card (setVramCap(1)) node-llama-cpp itself refuses the numeric load; fitContext ≤ the limit is tried before the processor', { timeout: 200000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'openagent-layer-limit-'));
  removeAtEnd(t, home);
  const { out, stderr } = await inChild(t, `
    const path = ${JSON.stringify(modelPath)};
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    if (llama.gpu !== false) {
      ${rememberedThenSpied(home, false)}
      // Not 0: a total of 0 makes the resolver answer 0 layers without an error. Less free VRAM than at the record:
      // the limit still applies.
      await llama.setVramCap(1);
      try { out.second = await m.loadLocalModel(path, 16384); } catch (error) { out.message = error.message; }
      out.loads2 = m.nativeLoadCount();
      out.secondOutcome = m.loadedOutcome(path);
      await m.disposeEngine();
      out.live = m.liveModelCount();
    }`, numericLimitLoad);
  if (out.gpu === false) {
    t.skip('no GPU backend here: a processor Llama has no layer limit');
    return;
  }
  const known = out.first.gpuLayers;
  assert.equal(out.message, undefined, `the load was not refused: ${out.message}`);
  assert.deepEqual(out.calls.map((call: { gpuLayers: unknown }) => call.gpuLayers), [known, { min: 0, max: known, fitContext: { contextSize: 16384 } }, 0], 'numeric, then fitContext ≤ the limit, then the processor');
  assert.equal(out.loads2 - out.loads1, 3);
  assert.equal(out.second.gpuLayers, 0);
  assert.deepEqual(out.secondOutcome, { kind: 'fallback', cause: 'loadModel', refused: [], limit: known });
  assert.match(stderr, new RegExp(`\\[placement\\] InsufficientMemoryError \\(loadModel, numérique ${known} couches\\)`), stderr.slice(-2000));
  assert.match(stderr, new RegExp(`\\[placement\\] InsufficientMemoryError \\(loadModel, fitContext ≤ ${known} couches\\)`), stderr.slice(-2000));
  assert.equal(out.live, 0);
});

test('B: a plain Error from createContext comes out unchanged, with no retry and no fallback',{ timeout: 200000 }, async t => {
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
  // A remembered limit (layer-limits.v1.json) is said first, alone or before what happened under it.
  assert.match(placementLogLine({ ...base, gpuLayers: 19, totalLayers: 66, outcome: { kind: 'direct', limit: 19 } }), /couches 19\/66 sur la carte · limite mémorisée : 19 couches · mmap/);
  assert.equal(outcomeNote({ kind: 'step-down', refused: [19], limit: 19 }), 'limite mémorisée : 19 couches · moins de couches : le contexte ne tenait pas sur la carte avec 19 couches');
});

test('limitStillHolds: a remembered limit applies unless the free VRAM grew by max(REPLACE_MIN_LAYERS layers, 512 MiB) since it was noted', () => {
  const MIB = 1024 ** 2;
  // The 27B: about 189 MiB a layer, so 4 layers (756 MiB) is the threshold.
  const big = { freeAtRecord: 7000 * MIB, bytesPerLayer: 189 * MIB };
  assert.equal(limitStillHolds({ ...big, freeNow: 7000 * MIB }), true, 'same VRAM');
  assert.equal(limitStillHolds({ ...big, freeNow: 7000 * MIB + 755 * MIB }), true, 'less than 4 layers more');
  assert.equal(limitStillHolds({ ...big, freeNow: 7000 * MIB + 756 * MIB }), false, '4 layers more: try the full fitContext');
  assert.equal(limitStillHolds({ ...big, freeNow: 6000 * MIB }), true, 'less VRAM');
  // A tiny model: the 512 MiB floor, above the free-VRAM noise (CUDA's own allocations: tens to a few hundred MiB).
  const tiny = { freeAtRecord: 7000 * MIB, bytesPerLayer: 0.2 * MIB };
  assert.equal(limitStillHolds({ ...tiny, freeNow: 7000 * MIB + 511 * MIB }), true);
  assert.equal(limitStillHolds({ ...tiny, freeNow: 7000 * MIB + 512 * MIB }), false);
  assert.equal(LIMIT_RETRY_MIN_BYTES, 512 * MIB);
  assert.equal(limitStillHolds({ ...big, freeAtRecord: null, freeNow: 9000 * MIB }), true, 'unreadable VRAM: the record holds');
  assert.equal(limitStillHolds({ ...big, freeNow: null }), true);
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
