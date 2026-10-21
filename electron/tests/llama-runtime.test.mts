// The runtime Llama's VRAM padding and its placement log (I-1, final review of « Matériel et débordement »).
// On Windows, ggml-vulkan reads free VRAM from VK_EXT_memory_budget (the WDDM per-process budget), which a probe found
// about 1 GiB above nvidia-smi (7188 vs 6193 MiB, 2026-10-21): node-llama-cpp's default padding (8 %, at most
// 1.6 GiB) was swallowed by that gap and the 27B spilled 3.8 GiB into shared system memory. So Vulkan on Windows gets
// a larger padding; CUDA and the processor keep the defaults. Real node-llama-cpp in child processes (one backend
// per process), stories260K only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LlamaLogLevel } from 'node-llama-cpp';
import { llamaLogger, vramPaddingFor } from '../core/llama-runtime.mts';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const modelPath = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

test('vramPaddingFor: Vulkan on Windows only, 20 % of the total VRAM capped at 2.5 GiB', () => {
  const padding = vramPaddingFor('vulkan', 'win32');
  assert.ok(padding, 'Vulkan on Windows has its own padding');
  assert.equal(padding(8 * GIB), Math.floor(8 * GIB * 0.2), '8 GiB card: 20 % (1.6 GiB)');
  assert.equal(padding(24 * GIB), 2.5 * GIB, '24 GiB card: capped at 2.5 GiB');
  for (const [backend, platform] of [['cuda', 'win32'], ['cpu', 'win32'], ['metal', 'darwin'], ['vulkan', 'linux'], ['vulkan', 'darwin']] as const) {
    assert.equal(vramPaddingFor(backend, platform), undefined, `${backend} on ${platform}: node-llama-cpp's default`);
  }
});

test('llamaLogger keeps warnings as before, passes llama.cpp buffer-size lines and drops the rest of its info', t => {
  const infos: string[] = [];
  const warns: string[] = [];
  t.mock.method(console, 'info', (message: string) => { infos.push(message); });
  t.mock.method(console, 'warn', (message: string) => { warns.push(message); });
  llamaLogger(LlamaLogLevel.info, 'load_tensors:      Vulkan0 model buffer size =  2283.00 MiB\n');
  llamaLogger(LlamaLogLevel.info, 'load_tensors:  CPU_Mapped model buffer size =  9000.12 MiB\n');
  llamaLogger(LlamaLogLevel.info, 'llama_model_loader: - kv   0:                       general.architecture str              = llama\n');
  llamaLogger(LlamaLogLevel.debug, 'anything at debug\n');
  llamaLogger(LlamaLogLevel.warn, 'a warning\n');
  assert.deepEqual(infos, [
    '[llama.cpp] load_tensors:      Vulkan0 model buffer size =  2283.00 MiB',
    '[llama.cpp] load_tensors:  CPU_Mapped model buffer size =  9000.12 MiB',
  ]);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /a warning/);
});

/** Runs `body` in a Node process of its own (`m` core/local-engine.mts, `r` core/llama-runtime.mts); returns its
 * result and everything it printed. */
async function inChild(body: string, env: NodeJS.ProcessEnv = {}): Promise<{ out: any; stdout: string; stderr: string }> {
  const source = `
    const m = await import(${JSON.stringify(new URL('../core/local-engine.mts', import.meta.url).href)});
    const r = await import(${JSON.stringify(new URL('../core/llama-runtime.mts', import.meta.url).href)});
    const out = {};
    ${body}
    await r.disposeLlama();
    process.stdout.write('RESULT ' + JSON.stringify(out) + '\\n');`;
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 100000,
  });
  const line = stdout.split('\n').find(text => text.startsWith('RESULT '));
  assert.ok(line, `the child printed its result: ${stdout.slice(-500)} ${stderr.slice(-500)}`);
  return { out: JSON.parse(line.slice('RESULT '.length)), stdout, stderr };
}

test('the runtime Llama carries the padding of its backend: Vulkan on Windows gets vramPaddingFor, the processor none', { timeout: 120000 }, async t => {
  const vulkan = await inChild(`
    r.setRuntimeStart({ choice: 'vulkan', packDir: null });
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    out.padding = llama.vramPaddingSize;
    out.total = (await llama.getVramState()).total;`);
  if (vulkan.out.gpu !== 'vulkan') {
    t.diagnostic(`no Vulkan here (${vulkan.out.gpu}): the Vulkan padding could not be observed`);
  } else {
    const expected = vramPaddingFor('vulkan', process.platform);
    assert.equal(vulkan.out.padding, expected ? expected(vulkan.out.total) : Math.floor(Math.min(vulkan.out.total * 0.08, 1.6 * GIB)));
  }
  const cpu = await inChild(`
    r.setRuntimeStart({ choice: 'cpu', packDir: null });
    const llama = await r.runtimeLlama();
    out.gpu = llama.gpu;
    out.padding = llama.vramPaddingSize;`);
  assert.deepEqual(cpu.out, { gpu: false, padding: 0 });
});

test('a load logs one [placement] line (layers, mmap, VRAM before, padding, context) and llama.cpp buffer sizes, without its info flood', { timeout: 120000 }, async () => {
  const { stdout } = await inChild(`
    out.placement = await m.loadLocalModel(${JSON.stringify(modelPath)}, 2048);`, { NODE_LLAMA_CPP_GPU: 'false' });
  const placement = stdout.split('\n').filter(line => line.startsWith('[placement]'));
  assert.equal(placement.length, 1, stdout.slice(-2000));
  assert.match(placement[0], /backend cpu/);
  assert.match(placement[0], /couches \d+\/\d+/);
  assert.match(placement[0], /mmap (oui|non)/);
  assert.match(placement[0], /contexte 2048/);
  assert.match(placement[0], /marge VRAM 0 Mio/);
  assert.match(placement[0], /VRAM avant chargement/);
  assert.match(stdout, /\[llama\.cpp\] .*model buffer size/, 'the model buffer size line reaches the log');
  assert.doesNotMatch(stdout, /llama_model_loader: - kv/, 'the metadata dump is filtered out');
});
