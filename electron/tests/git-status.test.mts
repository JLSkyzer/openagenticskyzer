import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const sh = async (args: string[], cwd: string) => (await run('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();

async function repoFixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-git-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await sh(['init', '-b', 'main'], repo);
  await sh(['config', 'user.name', 'Test'], repo);
  await sh(['config', 'user.email', 'test@example.com'], repo);
  await sh(['config', 'commit.gpgsign', 'false'], repo);
  await writeFile(join(repo, 'README.md'), '# Test\n');
  await sh(['add', 'README.md'], repo);
  await sh(['commit', '-m', 'initial'], repo);
  return repo;
}

test('gitStatus reports the branch and a clean tree right after a commit', async t => {
  const repo = await repoFixture(t);
  const { gitStatus } = await import('../core/git-status.mts');
  const status = await gitStatus(repo);
  assert.deepEqual(status, { branch: 'main', dirty: false });
});

test('gitStatus reports dirty once a tracked file is modified', async t => {
  const repo = await repoFixture(t);
  await writeFile(join(repo, 'README.md'), '# Test\n\nchangé\n');
  const { gitStatus } = await import('../core/git-status.mts');
  const status = await gitStatus(repo);
  assert.deepEqual(status, { branch: 'main', dirty: true });
});

test('gitStatus returns null for a folder that is not a git repository at all', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-git-status-none-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { gitStatus } = await import('../core/git-status.mts');
  assert.equal(await gitStatus(root), null);
});

test('gitStatus returns null for a folder that does not exist on disk, never throws', async t => {
  const { gitStatus } = await import('../core/git-status.mts');
  await assert.doesNotReject(gitStatus('D:/definitely-not-a-real-path-openagent-test'));
  assert.equal(await gitStatus('D:/definitely-not-a-real-path-openagent-test'), null);
});
