import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createTestProvider } from './support/test-model-provider.mts';

test('legacy instructions, custom prompt, memory and confirmed learnings reach the actual provider request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const folder = join(root, 'project');
  await mkdir(home); await mkdir(join(folder, '.openagent'), { recursive: true });
  await writeFile(join(folder, 'OPENAGENT.md'), 'OPENAGENT sentinelle');
  await writeFile(join(folder, 'CLAUDE.md'), 'CLAUDE non prioritaire');
  await writeFile(join(folder, '.openagent/config.json'), '{"custom_prompt":"Instructions personnalisées"}');
  await writeFile(join(home, 'memory.md'), 'Mémoire globale');
  await writeFile(join(folder, '.openagent/memory.md'), 'Mémoire projet');
  await writeFile(join(folder, '.openagent/learnings.jsonl'), JSON.stringify({ id: 'same', confirmed: false, mistake: 'NON CONFIRMÉ', correction: 'Non retenu' }) + '\n');
  await writeFile(join(home, 'learnings.jsonl'), JSON.stringify({ id: 'same', confirmed: true, mistake: 'Erreur connue', correction: 'Correction confirmée', tags: [] }) + '\n');
  const { buildInstructions } = await import('../core/context.mts');
  const { runAgent } = await import('../core/agent.mts');
  const { workspaceTools } = await import('../core/workspace.mts');
  const context = await buildInstructions({ folder, home, base: 'Base agent' });
  // A real model server on 127.0.0.1, reached through the test seam's client: what it receives is the actual request.
  const payloads: any[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      payloads.push(JSON.parse(raw));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: payloads.length === 1 ? {
        content: '', tool_calls: [{ id: 'create', type: 'function', function: { name: 'create_file', arguments: '{"path":"hello.txt","content":"created by Node"}' } }],
      } : { content: 'Créé' }, finish_reason: payloads.length === 1 ? 'tool_calls' : 'stop' }] }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const provider = createTestProvider({ base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
  await runAgent({ provider, instructions: context.instructions,
    messages: [{ role: 'user', content: 'create hello' }], tools: await workspaceTools(folder, ''), settings: { mode: 'auto', permission_mode: 'demander', files_ask: true }, confirm: async () => true,
  });
  const system = payloads[0].messages[0].content;
  for (const expected of ['OPENAGENT sentinelle', 'Instructions personnalisées', 'Mémoire globale', 'Mémoire projet', 'Correction confirmée', 'Base agent']) assert.equal(system.includes(expected), true, expected);
  assert.equal(system.includes('CLAUDE non prioritaire'), false);
  assert.equal(system.includes('NON CONFIRMÉ'), false);
  assert.equal(await readFile(join(folder, 'hello.txt'), 'utf8'), 'created by Node');
  assert.match(payloads[1].messages.at(-1).content, /Créé/);
});

test('optional corrupt learnings report a warning without corrupting or suppressing project instructions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.openagent'));
  await writeFile(join(root, 'CLAUDE.md'), 'Instructions de secours');
  await writeFile(join(root, '.openagent/learnings.jsonl'), '{broken');
  const { buildInstructions } = await import('../core/context.mts');
  const result = await buildInstructions({ folder: root, home: join(root, 'empty-home'), base: 'Base' });
  assert.match(result.instructions, /Instructions de secours/);
  assert.ok(result.warnings.some(w => w.includes('learnings')));
  assert.equal(await readFile(join(root, '.openagent/learnings.jsonl'), 'utf8'), '{broken');
});

test('buildInstructions returns base and projectContext apart, and instructions is still their join', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const folder = join(root, 'project');
  await mkdir(home); await mkdir(join(folder, '.openagent'), { recursive: true });
  const { buildInstructions } = await import('../core/context.mts');
  const bare = await buildInstructions({ folder, home, base: 'Base seule' });
  assert.deepEqual({ ...bare, warnings: undefined }, { instructions: 'Base seule', base: 'Base seule', projectContext: '', warnings: undefined });
  await writeFile(join(folder, 'OPENAGENT.md'), 'OPENAGENT sentinelle');
  await writeFile(join(folder, '.openagent/memory.md'), 'Mémoire projet');
  const full = await buildInstructions({ folder, home, base: 'Base agent' });
  assert.equal(full.base, 'Base agent');
  assert.match(full.projectContext, /^\[INSTRUCTIONS PROJET — OPENAGENT\.md\]\nOPENAGENT sentinelle\n[\s\S]*\[MÉMOIRE PROJET\]\nMémoire projet\n\[FIN MÉMOIRE\]$/);
  assert.equal(full.projectContext.includes('Base agent'), false);
  assert.equal(full.instructions, `${full.projectContext}\n\nBase agent`);
});
