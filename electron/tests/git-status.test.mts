import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
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

// ── commands declared in the repository's own config (filters, hooks, submodules) ──────────────
const exists = (path: string) => stat(path).then(() => true, () => false);
let tick = 0;
/** Gives a tracked file a new mtime, so git must re-read it (and run its clean filter) to know it is unchanged. */
const restat = (file: string) => utimes(file, new Date(2001, 0, 1, 0, 0, ++tick), new Date(2001, 0, 1, 0, 0, tick));
/** A shell command (git runs filters through its own sh, Git for Windows included) that leaves a marker and passes content through. */
const markingFilter = (marker: string) => `sh -c 'echo ran > "${marker}"; cat'`;

/** Repo whose committed a.txt goes through filter `name`, declared afterwards in the repo's own .git/config. */
async function filteredRepo(t: any, name: string) {
  const repo = await repoFixture(t);
  const marker = join(repo, '..', 'filter-ran').replace(/\\/g, '/');
  await writeFile(join(repo, '.gitattributes'), `*.txt filter=${name}\n`);
  await writeFile(join(repo, 'a.txt'), 'hi\n');
  await sh(['add', '.gitattributes', 'a.txt'], repo);
  await sh(['commit', '-m', 'filtered'], repo);
  await sh(['config', `filter.${name}.clean`, markingFilter(marker)], repo);
  await sh(['config', `filter.${name}.smudge`, 'cat'], repo);
  return { repo, marker, file: join(repo, 'a.txt') };
}

test('opening a repository never runs a clean filter its own .git/config declares, and the status stays right', async t => {
  const { repo, marker, file } = await filteredRepo(t, 'ev.il');
  await restat(file);
  await sh(['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', 'status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: the previous guard alone still runs the filter');
  await rm(marker);
  await restat(file);
  const { gitStatus } = await import('../core/git-status.mts');
  assert.deepEqual(await gitStatus(repo), { branch: 'main', dirty: false });
  assert.equal(await exists(marker), false, 'gitStatus ran the repository’s clean filter');
});

test('a filter declared in the user\'s GLOBAL config still runs: only the repository\'s own config is neutralised', async t => {
  const repo = await repoFixture(t);
  const marker = join(repo, '..', 'global-filter-ran').replace(/\\/g, '/');
  const globalConfig = join(repo, '..', 'global.gitconfig');
  await writeFile(join(repo, '.gitattributes'), '*.txt filter=userwide\n');
  await writeFile(join(repo, 'a.txt'), 'hi\n');
  await sh(['add', '.gitattributes', 'a.txt'], repo);
  await sh(['commit', '-m', 'filtered'], repo);
  // Written by git itself: in a hand-written config file ";" would start a comment and cut the command.
  await sh(['config', '--file', globalConfig, 'filter.userwide.clean', markingFilter(marker)], repo);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  await restat(join(repo, 'a.txt'));
  const { gitStatus } = await import('../core/git-status.mts');
  assert.deepEqual(await gitStatus(repo), { branch: 'main', dirty: false });
  assert.equal(await exists(marker), true, 'a filter the user installed globally (git-lfs…) must keep working');
});

test('opening a repository never runs a hook from its own .git/hooks when git refreshes the index', async t => {
  const repo = await repoFixture(t);
  const marker = join(repo, '..', 'hook-ran').replace(/\\/g, '/');
  const file = join(repo, 'README.md');
  await writeFile(join(repo, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  await restat(file);
  await sh(['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', 'status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: plain git status runs post-index-change');
  await rm(marker);
  await restat(file);
  const { gitStatus } = await import('../core/git-status.mts');
  assert.deepEqual(await gitStatus(repo), { branch: 'main', dirty: false });
  assert.equal(await exists(marker), false, 'gitStatus ran the repository’s post-index-change hook');
});

/** Superproject with a submodule whose OWN config (.git/modules/sub/config) declares a marking clean filter. */
async function submoduleRepo(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-git-submodule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sub = join(root, 'sub');
  const repo = join(root, 'repo');
  const marker = join(root, 'submodule-filter-ran').replace(/\\/g, '/');
  for (const dir of [sub, repo]) {
    await mkdir(dir);
    await sh(['init', '-b', 'main'], dir);
    await sh(['config', 'user.name', 'Test'], dir);
    await sh(['config', 'user.email', 'test@example.com'], dir);
    await sh(['config', 'commit.gpgsign', 'false'], dir);
  }
  await writeFile(join(sub, '.gitattributes'), '*.txt filter=subonly\n');
  await writeFile(join(sub, 's.txt'), 'inside\n');
  await sh(['add', '.'], sub);
  await sh(['commit', '-m', 'sub'], sub);
  await writeFile(join(repo, 'README.md'), '# Super\n');
  await sh(['add', 'README.md'], repo);
  await sh(['commit', '-m', 'initial'], repo);
  await sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '../sub', 'sub'], repo);
  await sh(['commit', '-m', 'add submodule'], repo);
  // Declared in the submodule's own config only: the superproject's config never names it.
  await sh(['config', 'filter.subonly.clean', markingFilter(marker)], join(repo, 'sub'));
  return { repo, marker, file: join(repo, 'sub', 's.txt') };
}

test('opening a superproject never runs a filter declared only in a submodule\'s own config', async t => {
  const { repo, marker, file } = await submoduleRepo(t);
  await restat(file);
  await sh(['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', 'status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: plain git status recurses into the submodule and runs its filter');
  await rm(marker);
  await restat(file);
  const { gitStatus } = await import('../core/git-status.mts');
  assert.deepEqual(await gitStatus(repo), { branch: 'main', dirty: false });
  assert.equal(await exists(marker), false, 'gitStatus ran the submodule’s clean filter');
});

test('gitStatus fails closed: no indicator when the repository config cannot be read safely', async t => {
  const { gitStatus } = await import('../core/git-status.mts');
  // A filter name containing "=" cannot be overridden with -c (git would read "filter.a" = "b.clean="):
  // plain git runs it, so the guard must refuse rather than run status unprotected.
  const { repo, marker, file } = await filteredRepo(t, 'a=b');
  await restat(file);
  await sh(['status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: plain git status runs the "a=b" filter');
  await rm(marker);
  await restat(file);
  assert.equal(await gitStatus(repo), null);
  assert.equal(await exists(marker), false, 'nothing ran after the guard refused');

  const corrupt = await repoFixture(t);
  await writeFile(join(corrupt, '.git', 'config'), '[core\nbroken', { flag: 'a' });
  await assert.doesNotReject(gitStatus(corrupt));
  assert.equal(await gitStatus(corrupt), null);
});

test('a filter whose name is not valid UTF-8 cannot slip past the guard: gitStatus fails closed', async t => {
  const repo = await repoFixture(t);
  const marker = join(repo, '..', 'bad-utf8-filter-ran').replace(/\\/g, '/');
  // Raw bytes: the name "x\xFFy" cannot even be written on a Windows command line, let alone overridden.
  const name = Buffer.from([0x78, 0xff, 0x79]);
  await writeFile(join(repo, '.gitattributes'), Buffer.concat([Buffer.from('*.txt filter='), name, Buffer.from('\n')]));
  await writeFile(join(repo, 'a.txt'), 'hi\n');
  await sh(['add', '.gitattributes', 'a.txt'], repo);
  await sh(['commit', '-m', 'filtered'], repo);
  await writeFile(join(repo, '.git', 'config'), Buffer.concat([
    Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = "sh -c 'echo ran > \\"${marker}\\"; cat'"\n\tsmudge = cat\n`),
  ]), { flag: 'a' });
  await restat(join(repo, 'a.txt'));
  await sh(['-c', 'core.fsmonitor=false', 'status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: plain git status runs the non-UTF-8-named filter');
  await rm(marker);
  await restat(join(repo, 'a.txt'));
  const { gitStatus } = await import('../core/git-status.mts');
  assert.equal(await gitStatus(repo), null);
  assert.equal(await exists(marker), false, 'gitStatus ran the non-UTF-8-named filter');
});

/** Partial clone (blob:none) of a one-file server, whose own config names a marking upload-pack command. */
async function partialClone(t: any, extra: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-git-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, 'server');
  const repo = join(root, 'repo');
  const marker = join(root, 'lazy-fetch-ran').replace(/\\/g, '/');
  await mkdir(server);
  await sh(['init', '-b', 'main'], server);
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) {
    await sh(['config', key, value], server);
  }
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  await writeFile(join(server, 'a.txt'), lines);
  await sh(['add', 'a.txt'], server);
  await sh(['commit', '-m', 'one'], server);
  await sh(['clone', '--filter=blob:none', ...extra, `file://${server.replace(/\\/g, '/')}`, repo], root);
  await sh(['config', 'user.name', 'Test'], repo);
  await sh(['config', 'user.email', 'test@example.com'], repo);
  // The repository's own config: a lazy fetch of a missing blob runs this command.
  await sh(['config', 'remote.origin.uploadpack', `sh -c 'echo ran > "${marker}"' x`], repo);
  return { repo, marker, lines };
}

test('opening a partial clone never runs the repository\'s upload-pack command through a lazy fetch', async t => {
  const { repo, marker, lines } = await partialClone(t, ['--no-checkout']);
  // HEAD's a.txt blob is missing; a similar staged b.txt makes status look for a rename, i.e. read a.txt.
  await writeFile(join(repo, 'b.txt'), lines + 'more\n');
  await sh(['add', 'b.txt'], repo);
  await sh(['-c', 'core.fsmonitor=false', 'status', '--porcelain'], repo).catch(() => '');
  assert.equal(await exists(marker), true, 'control: plain git status lazily fetches through the repository\'s upload-pack');
  await rm(marker);
  const { gitStatus } = await import('../core/git-status.mts');
  // git status cannot complete without the blob: no indicator, rather than a made-up "clean".
  assert.equal(await gitStatus(repo), null);
  assert.equal(await exists(marker), false, 'gitStatus ran the repository’s upload-pack command');
});

test('gitStatus returns null, not "clean", when git status itself fails', async t => {
  const repo = await repoFixture(t);
  await writeFile(join(repo, '.git', 'index'), 'not an index');
  const control = await run('git', ['status', '--porcelain'], { cwd: repo }).then(() => 0, (error: any) => error.code);
  assert.notEqual(control, 0, 'control: git status really fails on this repository');
  assert.equal(await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).then(r => r.stdout.trim()), 'main', 'control: the branch is still readable');
  const { gitStatus } = await import('../core/git-status.mts');
  assert.equal(await gitStatus(repo), null);
});

test('gitStatus returns null for a folder that does not exist on disk, never throws', async t => {
  const { gitStatus } = await import('../core/git-status.mts');
  await assert.doesNotReject(gitStatus('D:/definitely-not-a-real-path-openagent-test'));
  assert.equal(await gitStatus('D:/definitely-not-a-real-path-openagent-test'), null);
});
