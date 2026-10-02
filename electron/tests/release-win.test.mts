import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL('../scripts/release-win.cjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const ghReady = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status === 0;

async function cleanRepo(t: any, version: string) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version }));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

/** A clean repo whose current branch tracks a local bare remote, in sync. */
async function pushedRepo(t: any, version: string) {
  const root = await cleanRepo(t, version);
  const remote = await mkdtemp(join(tmpdir(), 'openagent-release-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(remote, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  const pushed = git(root, 'push', '-q', '-u', 'origin', 'HEAD');
  assert.equal(pushed.status, 0, pushed.stderr);
  return root;
}

function withoutPath(fn: () => void) {
  const saved = process.env.PATH;
  process.env.PATH = join(tmpdir(), 'openagent-release-no-such-dir');
  try { fn(); } finally { process.env.PATH = saved; }
}

test('assertReleasable refuses a dirty tree, unpushed commits, an existing release and an invalid version', () => {
  const { assertReleasable } = require(SCRIPT);
  assert.doesNotThrow(() => assertReleasable({ version: '0.3.0', dirty: false, ahead: 0, exists: false }));
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: true, ahead: 0, exists: false }), /non commités/);
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: false, ahead: 2, exists: false }), /pousse tes commits avant de publier/);
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: false, ahead: 0, exists: true }), /existe déjà/);
  assert.throws(() => assertReleasable({ version: 'abc', dirty: false, ahead: 0, exists: false }), /Version invalide/);
});

test('isTreeDirty reads the real git state of the given folder', async t => {
  const { isTreeDirty } = require(SCRIPT);
  const root = await cleanRepo(t, '0.0.1');
  assert.equal(isTreeDirty(root), false);
  await writeFile(join(root, 'new.txt'), 'x');
  assert.equal(isTreeDirty(root), true);
});

test('unpushedCommits counts local commits ahead of the upstream and refuses a branch without one', async t => {
  const { unpushedCommits } = require(SCRIPT);
  const synced = await pushedRepo(t, '0.0.1');
  assert.equal(unpushedCommits(synced), 0);
  await writeFile(join(synced, 'later.txt'), 'x');
  git(synced, 'add', '.');
  git(synced, 'commit', '-qm', 'not pushed');
  assert.equal(unpushedCommits(synced), 1);
  const lonely = await cleanRepo(t, '0.0.1');
  assert.throws(() => unpushedCommits(lonely), /branche amont/);
});

test('a missing git or gh is reported clearly, not as a crash', () => {
  const { isTreeDirty, releaseExists } = require(SCRIPT);
  withoutPath(() => {
    assert.throws(() => isTreeDirty(tmpdir()), /git introuvable/);
    assert.throws(() => releaseExists('0.0.1', 'JLSkyzer/openagenticskyzer'), /gh introuvable : installe GitHub CLI/);
  });
});

test('--root is a test seam: refused without --dry-run, before anything else runs', async t => {
  // Invalid version on purpose: even a script that ignored the rule would stop before any build or network call.
  const root = await cleanRepo(t, 'abc');
  const refused = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--root/);
  assert.doesNotMatch(refused.stderr, /Version invalide/);
});

test('releaseExists asks the real GitHub repository', { skip: ghReady ? false : 'gh CLI not authenticated' }, () => {
  const { releaseExists } = require(SCRIPT);
  assert.equal(releaseExists('0.0.0-never-released', 'JLSkyzer/openagenticskyzer'), false);
});

test('releaseExists refuses to read "not found" for a repository it cannot see', { skip: ghReady ? false : 'gh CLI not authenticated' }, () => {
  const { releaseExists } = require(SCRIPT);
  assert.throws(() => releaseExists('0.0.1', 'JLSkyzer/this-repository-does-not-exist-7f3a'), /inaccessible/);
});

test('--dry-run checks everything, never prints the token, and refuses a dirty tree or unpushed commits', { skip: ghReady ? false : 'gh CLI not authenticated' }, async t => {
  const root = await pushedRepo(t, '0.0.1-dry');
  const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
  const ok = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /dry-run/);
  assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token), 'the token never appears');

  await writeFile(join(root, 'later.txt'), 'x');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'not pushed');
  const ahead = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(ahead.status, 0);
  assert.match(ahead.stderr, /pousse tes commits avant de publier/);

  await writeFile(join(root, 'dirty.txt'), 'x');
  const refused = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /non commités/);
});
