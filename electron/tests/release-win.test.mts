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

test('assertReleasable refuses a dirty tree, an existing release and an invalid version', () => {
  const { assertReleasable } = require(SCRIPT);
  assert.doesNotThrow(() => assertReleasable({ version: '0.3.0', dirty: false, exists: false }));
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: true, exists: false }), /non commités/);
  assert.throws(() => assertReleasable({ version: '0.3.0', dirty: false, exists: true }), /existe déjà/);
  assert.throws(() => assertReleasable({ version: 'abc', dirty: false, exists: false }), /Version invalide/);
});

test('isTreeDirty reads the real git state of the given folder', async t => {
  const { isTreeDirty } = require(SCRIPT);
  const root = await cleanRepo(t, '0.0.1');
  assert.equal(isTreeDirty(root), false);
  await writeFile(join(root, 'new.txt'), 'x');
  assert.equal(isTreeDirty(root), true);
});

test('releaseExists asks the real GitHub repository', { skip: ghReady ? false : 'gh CLI not authenticated' }, () => {
  const { releaseExists } = require(SCRIPT);
  assert.equal(releaseExists('0.0.0-never-released', 'JLSkyzer/openagenticskyzer'), false);
});

test('--dry-run checks everything, never prints the token, and refuses a dirty tree', { skip: ghReady ? false : 'gh CLI not authenticated' }, async t => {
  const root = await cleanRepo(t, '0.0.1-dry');
  const token = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' }).stdout.trim();
  const ok = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /dry-run/);
  assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token), 'the token never appears');
  await writeFile(join(root, 'dirty.txt'), 'x');
  const refused = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--root', root], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /non commités/);
});
