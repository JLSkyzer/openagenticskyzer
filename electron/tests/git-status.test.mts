import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
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

test('opening a repository never runs the command its own core.fsmonitor names, and the status stays right', async t => {
  const repo = await repoFixture(t);
  // Hook and marker live OUTSIDE the work tree, so the tree stays clean and the result can be checked exactly.
  const outside = join(repo, '..');
  const marker = join(outside, 'fsmonitor-ran').replace(/\\/g, '/');
  const hook = join(outside, 'fsmonitor-hook.sh').replace(/\\/g, '/');
  // git runs the hook through its own sh (Git for Windows ships one), so a #!/bin/sh script works on Windows too.
  await writeFile(hook, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  await sh(['config', 'core.fsmonitor', hook], repo);
  // Control: plain git really does run it — otherwise the assertion below would prove nothing.
  await sh(['status', '--porcelain'], repo);
  assert.equal(await stat(marker).then(() => true, () => false), true, 'control: the hook must run under plain git status');
  await rm(marker);
  const { gitStatus } = await import('../core/git-status.mts');
  assert.deepEqual(await gitStatus(repo), { branch: 'main', dirty: false });
  assert.equal(await stat(marker).then(() => true, () => false), false, 'gitStatus ran the repository’s core.fsmonitor command');
});

test('gitStatus returns null for a folder that does not exist on disk, never throws', async t => {
  const { gitStatus } = await import('../core/git-status.mts');
  await assert.doesNotReject(gitStatus('D:/definitely-not-a-real-path-openagent-test'));
  assert.equal(await gitStatus('D:/definitely-not-a-real-path-openagent-test'), null);
});
