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

const run = promisify(execFile);
const electron = fileURLToPath(new URL('..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/stories260K.gguf', import.meta.url));

test('the bench plays A, B and C on stories260K and writes one dated results file, with no path in it', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-bench-'));
  removeAtEnd(t, root);
  const model = join(root, 'stories260K.gguf');
  await copyFile(fixture, model);
  await run(process.execPath, ['--experimental-strip-types', 'bench/run.mts', '--model', model, '--label', 'test', '--out', root, '--lever', 'outputCap=32'], { cwd: electron, timeout: 280000 });
  const files = (await readdir(root)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}-\d{6}-test\.json$/);
  const text = await readFile(join(root, files[0]), 'utf8');
  assert.equal(text.includes(root) || text.includes(homedir()), false, 'no folder in the results');
  const result = JSON.parse(text);
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
