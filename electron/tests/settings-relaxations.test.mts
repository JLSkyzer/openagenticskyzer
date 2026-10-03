import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-relaxations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const { SettingsService } = await import('../core/settings.mts');
  return { home, project, settings: new SettingsService(home) };
}

test('relaxationsOf lists only values more permissive than the global ones', async () => {
  const { relaxationsOf, globalDefaults, projectDefaults } = await import('../core/settings.mts');
  const global = { ...globalDefaults, shell_ask: true, files_ask: false, permission_mode: 'demander', agent_mode: 'ask' };
  const project = {
    ...projectDefaults, override_permissions: true,
    shell_ask: false, files_ask: false, search_ask: true, permission_mode: 'auto', agent_mode: 'auto',
  };
  assert.deepEqual(relaxationsOf(global, project), {
    permission_mode: { project: 'auto', global: 'demander' },
    shell_ask: { project: false, global: true },
    agent_mode: { project: 'auto', global: 'ask' },
  });
});

test('relaxationsOf ignores permission fields when override_permissions is off, and stricter values always', async () => {
  const { relaxationsOf, globalDefaults, projectDefaults } = await import('../core/settings.mts');
  const global = { ...globalDefaults, shell_ask: true, permission_mode: 'demander', agent_mode: 'plan' };
  assert.deepEqual(relaxationsOf(global, { ...projectDefaults, shell_ask: false, permission_mode: 'auto' }), {});
  assert.deepEqual(relaxationsOf(global, { ...projectDefaults, override_permissions: true, permission_mode: 'strict' }), {});
  assert.deepEqual(relaxationsOf(global, { ...projectDefaults, agent_mode: 'ask' }), {}, 'ask and plan are both read-only');
});

test('effective() ignores a repo-shipped relaxation unless its exact value was approved', async t => {
  const { project, settings } = await fixture(t);
  await settings.saveProject(project, { override_permissions: true, shell_ask: false, permission_mode: 'auto' });

  const untrusted = await settings.effective(project);
  assert.equal(untrusted.shell_ask, true, 'global default applies');
  assert.equal(untrusted.permission_mode, 'demander', 'global default applies');

  const partly = await settings.effective(project, { approvedRelaxations: { shell_ask: false, permission_mode: 'strict' } });
  assert.equal(partly.shell_ask, false, 'approved at this exact value');
  assert.equal(partly.permission_mode, 'demander', 'approved value differs from the current one');
});

test('effective() always applies a stricter project value, without any approval', async t => {
  const { project, settings } = await fixture(t);
  await settings.saveProject(project, { override_permissions: true, files_ask: true, permission_mode: 'strict' });
  const effective = await settings.effective(project);
  assert.equal(effective.files_ask, true);
  assert.equal(effective.permission_mode, 'strict');
});

test('effective() keeps a read-only global agent_mode against a project "auto" unless approved', async t => {
  const { project, settings } = await fixture(t);
  await settings.saveGlobal({ agent_mode: 'ask' });
  await settings.saveProject(project, { agent_mode: 'auto' });
  assert.equal((await settings.effective(project)).agent_mode, 'ask');
  assert.equal((await settings.effective(project, { approvedRelaxations: { agent_mode: 'auto' } })).agent_mode, 'auto');
});

// A project config.json is repo-shipped, hand-editable content: only the keys a project may set count. Any other
// key (max_tokens, reserved_tokens, an unknown one) is dropped on read, so it can neither override the global
// value in effective() nor make two readers of the settings disagree. The file itself is never rewritten.
test('project() and effective() ignore keys a project may not set: the global values win', async t => {
  const { project, home, settings } = await fixture(t);
  const { writeFile, readFile, mkdir } = await import('node:fs/promises');
  await settings.saveGlobal({ max_tokens: 100000, reserved_tokens: 2048, auto_compact: false });
  await mkdir(join(project, '.openagent'), { recursive: true });
  const file = join(project, '.openagent', 'config.json');
  const raw = JSON.stringify({ max_tokens: 4096, reserved_tokens: 1, auto_compact: true, active_local_model: 'x', inconnue: 7, custom_prompt: 'garde-moi' });
  await writeFile(file, raw);
  const saved = await settings.project(project);
  for (const key of ['max_tokens', 'reserved_tokens', 'auto_compact', 'active_local_model', 'inconnue']) {
    assert.equal(Object.hasOwn(saved, key), false, `project() does not expose ${key}`);
  }
  assert.equal(saved.custom_prompt, 'garde-moi', 'a declared project key is kept');
  const effective = await settings.effective(project);
  assert.equal(effective.max_tokens, 100000);
  assert.equal(effective.reserved_tokens, 2048);
  assert.equal(effective.auto_compact, false);
  assert.equal(Object.hasOwn(effective, 'inconnue'), false);
  assert.equal(await readFile(file, 'utf8'), raw, 'reading never rewrites the file');
  void home;
});
