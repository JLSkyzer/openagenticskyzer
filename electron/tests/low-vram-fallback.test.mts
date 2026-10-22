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
import { cpuFallback, placementLogLine } from '../core/local-engine.mts';
import { runtimeLlama, envGpuChoice, vramPaddingFor } from '../core/llama-runtime.mts';
import { removeAtEnd } from './teardown.mts';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const modelPath = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

/** Runs `body` in a Node process of its own, from a script FILE: node-llama-cpp tests a GPU binary in a fork() that
 * inherits execArgv, so an `-e` child can never resolve a card. `m` core/local-engine.mts, `r` core/llama-runtime.mts,
 * `e` core/offload-estimate.mts. NODE_LLAMA_CPP_GPU is removed: the runtime Llama resolves « auto » as the app does. */
async function inChild(t: { after(fn: () => unknown): void }, body: string): Promise<{ out: any; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openagent-low-vram-'));
  removeAtEnd(t, root);
  const script = join(root, 'child.mjs');
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  await writeFile(script, `
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

test('the [placement] line says when the load fell back to the processor', () => {
  const base = { backend: 'vulkan', gpuLayers: 0, totalLayers: 6, useMmap: true, vramBefore: null, padding: 0, contextSize: 16384 };
  assert.doesNotMatch(placementLogLine(base), /repli/);
  assert.match(placementLogLine({ ...base, fallback: true }), /repli processeur/);
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
