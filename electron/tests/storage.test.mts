import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regressions guarded here: lost updates, corrupt JSON overwritten, project/branch
// ownership mixed up, traversal through branch identifiers, legacy data destroyed.
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const a = join(root, 'project-a');
  const b = join(root, 'project-b');
  await Promise.all([home, a, b].map(p => mkdir(p)));
  return { root, home, a, b };
}

test('atomic updates preserve every concurrent increment and the original backup', async t => {
  const { home } = await fixture(t);
  const { JsonStore } = await import('../core/json-store.mts');
  const file = join(home, 'counter.json');
  await writeFile(file, '{"count":0}');
  const store = new JsonStore();
  await Promise.all(Array.from({ length: 20 }, () => store.update(file, { count: 0 }, v => ({ count: v.count + 1 }))));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { count: 20 });
  assert.equal(await readFile(file + '.pre-electron.bak', 'utf8'), '{"count":0}');
  assert.deepEqual((await readdir(home)).sort(), ['counter.json', 'counter.json.pre-electron.bak']);
});

test('malformed data refuses updates without altering the damaged original', async t => {
  const { home } = await fixture(t);
  const { JsonStore } = await import('../core/json-store.mts');
  const file = join(home, 'config.json');
  await writeFile(file, '{broken');
  await assert.rejects(new JsonStore().update<Record<string, unknown>>(file, {}, () => ({ value: 1 })), /JSON/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  assert.deepEqual(await readdir(home), ['config.json']);
});

test('global and project settings persist independently without copying inherited values', async t => {
  const { home, a, b } = await fixture(t);
  const { SettingsService } = await import('../core/settings.mts');
  const settings = new SettingsService(home);
  await settings.saveGlobal({ agent_mode: 'plan', theme: 'light', reserved_tokens: 1024 });
  await settings.saveProject(a, { agent_mode: 'ask', custom_prompt: 'Projet A uniquement' });
  const reopened = new SettingsService(home);
  assert.equal((await reopened.effective(a)).agent_mode, 'ask');
  assert.equal((await reopened.effective(b)).agent_mode, 'plan');
  assert.equal((await reopened.effective(a)).theme, 'light');
  assert.equal((await reopened.effective(b)).custom_prompt, '');
  const raw = JSON.parse(await readFile(join(a, '.openagent/config.json'), 'utf8'));
  assert.equal(raw.theme, undefined);
  assert.equal(raw.reserved_tokens, undefined);
  assert.equal((await reopened.global()).custom_prompt, undefined);
  assert.equal(await readFile(join(home, 'config.json'), 'utf8').then(s => s.includes('Projet A')), false);
});

test('legacy unknown settings are preserved, invalid patches and malformed shapes are rejected', async t => {
  const { home, a } = await fixture(t);
  const { SettingsService } = await import('../core/settings.mts');
  await writeFile(join(home, 'config.json'), '{"future_option":7,"agent_mode":"auto"}');
  const settings = new SettingsService(home);
  await settings.saveGlobal({ theme: 'light' });
  assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).future_option, 7);
  const before = await readFile(join(home, 'config.json'), 'utf8');
  for (const patch of [{ theme: 'bad' }, { reserved_tokens: -1 }, { shell_ask: 'false' }, { accent_color: 'url(evil)' }, { mystery: 1 }]) {
    await assert.rejects(settings.saveGlobal(patch as any));
  }
  await assert.rejects(settings.saveProject(a, { theme: 'dark' } as any));
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), before);
  await writeFile(join(home, 'config.json'), '[]');
  await assert.rejects(settings.saveGlobal({ theme: 'dark' }), /objet/);
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), '[]');
});

test('legacy history survives fork edits, reopening and other projects', async t => {
  const { a, b } = await fixture(t);
  const { Conversations } = await import('../core/conversations.mts');
  const legacy = [{ role: 'user', content: 'original' }, { role: 'ai', content: 'réponse', tool_diff: 'diff' }];
  await mkdir(join(a, '.openagent'));
  await writeFile(join(a, '.openagent/chat_history.json'), JSON.stringify(legacy));
  const conversations = new Conversations();
  const branch = await conversations.fork(a, 'main', 1, 'Variante');
  await conversations.save(a, branch.id, [{ role: 'user', content: 'modifié' }]);
  await conversations.save(b, 'main', [{ role: 'user', content: 'projet B' }]);
  const reopened = new Conversations();
  assert.deepEqual(await reopened.messages(a, 'main'), legacy);
  assert.deepEqual(await reopened.messages(a, branch.id), [{ role: 'user', content: 'modifié' }]);
  assert.deepEqual(await reopened.messages(b, 'main'), [{ role: 'user', content: 'projet B' }]);
  assert.equal((await reopened.list(a)).find(v => v.id === branch.id)?.label, 'Variante');
  assert.equal(await readFile(join(a, '.openagent/chat_history.json'), 'utf8'), JSON.stringify(legacy));
});

test('branch IDs cannot escape storage and invalid histories do not replace conversations', async t => {
  const { a, root } = await fixture(t);
  const { Conversations } = await import('../core/conversations.mts');
  const c = new Conversations();
  for (const id of ['../../outside', '..\\outside', '', 'C:\\outside', 'main/other']) {
    await assert.rejects(c.save(a, id, []));
  }
  await c.save(a, 'main', [{ role: 'user', content: 'keep' }]);
  await assert.rejects(c.save(a, 'main', [{ role: 'untrusted-role', content: 'bad' }] as any));
  await assert.rejects(c.fork(a, 'main', 100, 'invalid'));
  assert.deepEqual(await c.messages(a, 'main'), [{ role: 'user', content: 'keep' }]);
  assert.equal((await readdir(root)).includes('outside'), false);
});

test('a JSON null conversation cannot silently discard existing migrated data', async t => {
  const { a } = await fixture(t);
  const { Conversations } = await import('../core/conversations.mts');
  await mkdir(join(a, '.openagent'));
  const file = join(a, '.openagent/conversations.json');
  await writeFile(file, 'null');
  await assert.rejects(new Conversations().save(a, 'main', []));
  assert.equal(await readFile(file, 'utf8'), 'null');
});

test('public settings omit legacy secrets and project-only fields', async t => {
  const { home } = await fixture(t);
  const { SettingsService } = await import('../core/settings.mts');
  await writeFile(join(home, 'config.json'), JSON.stringify({ hf_token: 'fake-private', extra_secret: 'fake-other', theme: 'light' }));
  const snapshot = await new SettingsService(home).publicGlobal();
  assert.equal(snapshot.theme, 'light');
  assert.equal(JSON.stringify(snapshot).includes('fake-'), false);
  assert.equal(snapshot.hf_token_configured, true);
});

test('settings reject malformed legacy permission values instead of letting them reach the agent', async t => {
  const { home, a } = await fixture(t);
  const { SettingsService } = await import('../core/settings.mts');
  await writeFile(join(home, 'config.json'), '{"permission_mode":true}');
  await assert.rejects(new SettingsService(home).effective(a), /permission_mode/);
});
