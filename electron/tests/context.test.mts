import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const { ChatProvider } = await import('../core/provider.mts');
  const { runAgent } = await import('../core/agent.mts');
  const { workspaceTools } = await import('../core/workspace.mts');
  const context = await buildInstructions({ folder, home, base: 'Base agent' });
  const payloads: any[] = [];
  const provider = new ChatProvider(async (_url: any, options: any) => {
    payloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: payloads.length === 1 ? {
      content: '', tool_calls: [{ id: 'create', type: 'function', function: { name: 'create_file', arguments: '{"path":"hello.txt","content":"created by Node"}' } }],
    } : { content: 'Créé' }, finish_reason: payloads.length === 1 ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } });
  });
  await runAgent({ provider, instructions: context.instructions, connection: { provider: 'openrouter', api_key: 'fake', base_url: 'https://openrouter.ai/api/v1', model: 'fake' },
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
