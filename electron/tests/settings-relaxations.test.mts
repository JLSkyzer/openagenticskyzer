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
