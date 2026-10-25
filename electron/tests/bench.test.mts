import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, copyFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeAtEnd } from './teardown.mts';
import { toolDefinitionTokens } from '../bench/tool-tokens.mts';
import { builtInTools } from '../core/builtin-tools.mts';
import { toolSchemas } from '../core/agent.mts';
import { SHIPPED_LEVERS } from '../core/perf-levers.mts';

const run = promisify(execFile);

/** No folder anywhere in a results file: raw, JSON-escaped (a Windows path's backslashes are doubled in JSON), or in
 * any parsed string value. */
function assertNoPath(text: string, folders: readonly string[]): void {
  const lower = text.toLowerCase();
  for (const folder of folders) {
    for (const form of [folder, JSON.stringify(folder).slice(1, -1), folder.replaceAll('\\', '/')]) {
      assert.equal(lower.includes(form.toLowerCase()), false, `a folder in the results: ${form}`);
    }
  }
  const walk = (value: unknown): void => {
    if (typeof value === 'string') for (const folder of folders) assert.equal(value.toLowerCase().includes(folder.toLowerCase()), false, `a folder in ${value}`);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(JSON.parse(text));
}
const electron = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

test('the bench plays A, B and C on stories260K and writes one dated results file, with no path in it', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-bench-'));
  removeAtEnd(t, root);
  const model = join(root, 'stories260K.gguf');
  await copyFile(fixture, model);
  await run(process.execPath, ['--experimental-strip-types', 'bench/run.mts', '--model', model, '--label', 'test', '--out', root, '--lever', 'outputCap=32', '--cuda-pack', 'none'], { cwd: electron, timeout: 280000 });
  const files = (await readdir(root)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}-\d{6}-test\.json$/);
  const text = await readFile(join(root, files[0]), 'utf8');
  assertNoPath(text, [root, homedir(), tmpdir()]);
  const result = JSON.parse(text);
  assert.deepEqual(result.failures, []);
  assert.ok(result.turns.every((turn: any) => turn.status === 'done'));
  assert.ok(['cuda', 'vulkan', 'metal', 'cpu'].includes(result.backend), result.backend);
  assert.match(result.nodeLlamaCpp, /^\d+\.\d+\.\d+/);
  assert.deepEqual(result.levers, { ...SHIPPED_LEVERS, outputCap: 32 }, 'the levers the worker applied');
  assert.deepEqual(result.turns.map((t: any) => `${t.scenario}·${t.message}`), ['A·1', 'A·2', 'A·3', 'A·4', 'B·1', 'C-froid·1', 'C-chaud·1']);
  for (const turn of result.turns) {
    assert.ok(turn.generations.length >= 1 && turn.generations[0].outputTokens <= 32);
    assert.ok(turn.memory.rssBytes > 0);
  }
  assert.ok(result.turns[1].generations[0].reuse.reused > 0, 'A·2 reuses the prompt of A·1 (attention model)');
  assert.ok(result.turns[5].loadStages.some((s: any) => s.stage === 'engine'));
  assert.equal(result.model.file, 'stories260K.gguf');
  assert.ok(result.toolDefinitions.chars > 0);
});

test('toolDefinitionTokens on stories260K: the tools rendered by the model\'s own template cost tokens', { timeout: 60000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'openagent-tooltokens-'));
  removeAtEnd(t, folder);
  const tools = toolSchemas(await builtInTools(folder, folder, ''), { mode: 'auto', permission_mode: 'demander', shell_ask: true, files_ask: true, search_ask: false });
  const count = await toolDefinitionTokens(fixture, tools);
  assert.equal(count.chars, JSON.stringify(tools).length);
  assert.ok(count.tokens > 0);
  assert.equal(count.perTool.length, tools.length);
});

test('a turn past --turn-timeout is stopped through the worker, recorded as stopped and failed; the file is still written', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-bench-timeout-'));
  removeAtEnd(t, root);
  // The toy model never ends by itself: 4000 tokens take seconds, the timeout is 1.2 s.
  const failed = await run(process.execPath, ['--experimental-strip-types', 'bench/run.mts', '--model', fixture, '--label', 'delai', '--out', root, '--scenarios', 'C',
    '--turn-timeout', '0.02', '--lever', 'outputCap=4000', '--cuda-pack', 'none'], { cwd: electron, timeout: 280000 }).then(() => null, (error: { code?: number }) => error);
  assert.equal(failed?.code, 4, 'a scenario failed');
  const [file] = (await readdir(root)).filter(name => name.endsWith('.json'));
  const text = await readFile(join(root, file), 'utf8');
  assertNoPath(text, [root, homedir(), tmpdir(), fixture]);
  const result = JSON.parse(text);
  assert.deepEqual(result.turns.map((turn: any) => `${turn.scenario}·${turn.status}`), ['C-froid·stopped', 'C-chaud·stopped']);
  assert.equal(result.failures.length, 2, JSON.stringify(result.failures));
  assert.ok(result.failures.every((failure: string) => /délai/.test(failure)), JSON.stringify(result.failures));
});
