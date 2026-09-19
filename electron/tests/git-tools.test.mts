import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const sh = async (args: string[], cwd: string) => (await run('git', args, { cwd, env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();

class MissingTool extends Error {}

// A refusal only counts if the tool exists: a missing tool must never pass as "it refused".
async function refuses(promise: Promise<unknown>, expected?: RegExp) {
  await assert.rejects(promise, (error: any) => {
    assert.ok(!(error instanceof MissingTool), error.message);
    return expected ? expected.test(String(error.message)) : true;
  });
}

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-git-'));
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
  const { gitTools } = await import('../core/git-tools.mts');
  const tools = await gitTools(repo);
  async function invoke(name: string, args: Record<string, unknown> = {}) {
    const tool = tools.find(entry => entry.name === name);
    if (!tool) throw new MissingTool(`Missing ${name}`);
    tool.validate(args);
    return tool.execute(args, new AbortController().signal);
  }
  return { root, repo, tools, invoke };
}

// ── read tools ────────────────────────────────────────────────────────────────────
test('git_status reports a clean tree, then the branch and the changes', async t => {
  const { repo, invoke } = await fixture(t);
  assert.equal(await invoke('git_status'), 'Working tree clean.');
  await writeFile(join(repo, 'new.txt'), 'x');
  const dirty = await invoke('git_status');
  assert.match(dirty, /## main/);
  assert.match(dirty, /\?\? new\.txt/);
});

test('a folder that is not a repository fails with git\'s own message', async t => {
  const { root } = await fixture(t);
  const { gitTools } = await import('../core/git-tools.mts');
  const plain = join(root, 'plain');
  await mkdir(plain);
  const tools = await gitTools(plain);
  await refuses(tools.find(entry => entry.name === 'git_status')!.execute({}, new AbortController().signal), /not a git repository/i);
});

test('git_diff shows unstaged changes, can be limited to a file, and says when there are none', async t => {
  const { repo, invoke } = await fixture(t);
  assert.equal(await invoke('git_diff'), 'No changes.');
  await writeFile(join(repo, 'README.md'), '# Test\nmodifié\n');
  await writeFile(join(repo, 'other.txt'), 'a');
  await sh(['add', 'other.txt'], repo);
  await sh(['commit', '-m', 'other'], repo);
  await writeFile(join(repo, 'other.txt'), 'b');
  assert.match(await invoke('git_diff'), /\+modifié/);
  const only = await invoke('git_diff', { file: 'other.txt' });
  assert.match(only, /\+b/);
  assert.equal(only.includes('modifié'), false);
});

test('git_diff_staged shows staged changes only', async t => {
  const { repo, invoke } = await fixture(t);
  assert.equal(await invoke('git_diff_staged'), 'No changes (staged).');
  await writeFile(join(repo, 'README.md'), '# Test\nindexé\n');
  await sh(['add', 'README.md'], repo);
  assert.match(await invoke('git_diff_staged'), /\+indexé/);
  assert.equal(await invoke('git_diff'), 'No changes.', 'nothing left unstaged');
});

test('diffs never show a tracked .env, and it cannot be asked for by name', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, '.env'), 'TOKEN=first\n');
  await sh(['add', '-f', '.env'], repo);
  await sh(['commit', '-m', 'oops committed the env'], repo);
  await writeFile(join(repo, '.env'), 'TOKEN=fake-secret-value\n');
  await writeFile(join(repo, 'README.md'), '# Test\nvisible\n');
  await sh(['add', '.env'], repo);
  const unstaged = await invoke('git_diff');
  const staged = await invoke('git_diff_staged');
  assert.match(unstaged, /\+visible/);
  for (const out of [unstaged, staged]) assert.equal(out.includes('fake-secret-value'), false);
  await refuses(invoke('git_diff', { file: '.env' }));
  await refuses(invoke('git_blame', { file: '.env' }));
});

test('an external diff driver configured in the repo is never executed', async t => {
  const { repo, root, invoke } = await fixture(t);
  const marker = join(root, 'ext-ran.txt').replace(/\\/g, '/');
  const script = join(root, 'ext.cjs').replace(/\\/g, '/');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  await sh(['config', 'diff.external', `node ${script}`], repo);
  await writeFile(join(repo, 'README.md'), '# Test\nchangé\n');
  // Sanity: without the protection, plain git really does run the driver.
  await sh(['diff'], repo);
  await stat(marker);
  await rm(marker);
  assert.match(await invoke('git_diff'), /\+changé/);
  await assert.rejects(stat(marker), 'the tool must not run a repo-controlled diff driver');
});

test('git_log lists commits, honours n and oneline, and validates n', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, 'a.txt'), '1');
  await sh(['add', 'a.txt'], repo);
  await sh(['commit', '-m', 'second'], repo);
  const two = await invoke('git_log', { n: 2 });
  assert.equal(two.trim().split('\n').length, 2);
  assert.match(two, /second/);
  assert.equal((await invoke('git_log', { n: 1 })).trim().split('\n').length, 1);
  const detailed = await invoke('git_log', { n: 1, oneline: false });
  assert.match(detailed, /Test/);
  assert.match(detailed, /second/);
  await refuses(invoke('git_log', { n: 0 }), /nombre/i);
  await refuses(invoke('git_log', { n: 201 }), /nombre/i);
  await refuses(invoke('git_log', { oneline: 'yes' }), /booléen/i);
});

test('git_blame names the author, supports a line range, and validates it', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, 'f.txt'), 'l1\nl2\nl3\n');
  await sh(['add', 'f.txt'], repo);
  await sh(['commit', '-m', 'lines'], repo);
  assert.match(await invoke('git_blame', { file: 'f.txt' }), /Test/);
  const ranged = await invoke('git_blame', { file: 'f.txt', start: 2, end: 2 });
  assert.equal(ranged.trim().split('\n').length, 1);
  assert.match(ranged, /l2/);
  await refuses(invoke('git_blame', { file: 'f.txt', start: 3, end: 2 }), /plage/i);
  await refuses(invoke('git_blame', { file: 'f.txt', start: 0 }), /nombre/i);
});

test('git_branch_list shows the branches', async t => {
  const { invoke } = await fixture(t);
  assert.match(await invoke('git_branch_list'), /main/);
});

// ── staging and committing ────────────────────────────────────────────────────────
test('git_add stages files, a directory dot, quoted paths with spaces and backslash paths', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, 'new.txt'), 'x');
  await invoke('git_add', { files: 'new.txt' });
  assert.match(await sh(['status', '--short'], repo), /^A {2}new\.txt/m);

  await writeFile(join(repo, 'with space.txt'), 'x');
  await invoke('git_add', { files: '"with space.txt"' });
  assert.match(await sh(['status', '--short'], repo), /with space\.txt/);

  await mkdir(join(repo, 'sub'));
  await writeFile(join(repo, 'sub', 'file.txt'), 'x');
  await invoke('git_add', { files: 'sub\\file.txt' });
  assert.match(await sh(['ls-files'], repo), /sub\/file\.txt/, 'the backslash path was kept, not mangled into subfile.txt');

  await writeFile(join(repo, 'later.txt'), 'x');
  await invoke('git_add', { files: '.' });
  assert.equal((await sh(['status', '--short'], repo)).includes('??'), false, 'dot stages everything');
});

test('git_add treats a file named like an option as a file, never as a flag', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, '-weird.txt'), 'x');
  await invoke('git_add', { files: '-weird.txt' });
  assert.match(await sh(['status', '--short'], repo), /-weird\.txt/);
  await refuses(invoke('git_add', { files: '   ' }), /fichier/i);
});

test('git_commit commits what is staged, or stages the given files first', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, 'a.txt'), '1');
  await sh(['add', 'a.txt'], repo);
  await invoke('git_commit', { message: 'commit staged' });
  assert.match(await sh(['log', '--oneline', '-1'], repo), /commit staged/);
  assert.equal(await sh(['status', '--short'], repo), '');

  await writeFile(join(repo, 'b b.txt'), '2');
  await invoke('git_commit', { message: 'with files', files: '"b b.txt"' });
  assert.match(await sh(['log', '--oneline', '-1'], repo), /with files/);
  assert.equal(await sh(['status', '--short'], repo), '');
});

test('git_commit needs a message and something to commit', async t => {
  const { invoke } = await fixture(t);
  await refuses(invoke('git_commit', { message: '   ' }), /message/i);
  await refuses(invoke('git_commit', { message: 'nothing to commit' }));
});

// ── branches, checkout, stash ─────────────────────────────────────────────────────
test('git_create_branch creates and switches, also from a start point', async t => {
  const { repo, invoke } = await fixture(t);
  await invoke('git_create_branch', { name: 'feature/x' });
  assert.equal(await sh(['branch', '--show-current'], repo), 'feature/x');
  await invoke('git_checkout', { branch: 'main' });
  await invoke('git_create_branch', { name: 'from-main', from_branch: 'main' });
  assert.equal(await sh(['branch', '--show-current'], repo), 'from-main');
  for (const bad of ['-x', 'has space', 'a:b', '--orphan=y']) await refuses(invoke('git_create_branch', { name: bad }), /invalide/i);
  await refuses(invoke('git_create_branch', { name: 'ok', from_branch: '-f' }), /invalide/i);
});

test('git_checkout switches to an existing branch and refuses option-like or unknown names', async t => {
  const { repo, invoke } = await fixture(t);
  await sh(['branch', 'other'], repo);
  await invoke('git_checkout', { branch: 'other' });
  assert.equal(await sh(['branch', '--show-current'], repo), 'other');
  await refuses(invoke('git_checkout', { branch: '-f' }), /invalide/i);
  await refuses(invoke('git_checkout', { branch: '--detach' }), /invalide/i);
  await refuses(invoke('git_checkout', { branch: 'does-not-exist' }));
});

test('git_checkout cannot be used to discard changes by naming a file', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, 'README.md'), '# Test\nunsaved work\n');
  await refuses(invoke('git_checkout', { branch: 'README.md' }));
  assert.match(await readFile(join(repo, 'README.md'), 'utf8'), /unsaved work/, 'the uncommitted work is still there');
});

test('git_stash cleans the tree and git_stash_pop brings the work back', async t => {
  const { repo, invoke } = await fixture(t);
  await writeFile(join(repo, 'README.md'), '# Test\nchange\n');
  await invoke('git_stash', { message: 'wip' });
  assert.equal(await sh(['status', '--short'], repo), '');
  assert.match(await sh(['stash', 'list'], repo), /wip/);
  await invoke('git_stash_pop');
  assert.match(await readFile(join(repo, 'README.md'), 'utf8'), /change/);
});

// ── remotes: pull and push, and the injection regressions ─────────────────────────
async function withRemote(t: any) {
  const base = await fixture(t);
  const remote = join(base.root, 'remote.git');
  const other = join(base.root, 'other');
  await sh(['init', '--bare', '-b', 'main', remote], base.root);
  await sh(['remote', 'add', 'origin', remote], base.repo);
  await sh(['push', '-u', 'origin', 'main'], base.repo);
  await sh(['clone', remote, other], base.root);
  await sh(['config', 'user.name', 'Other'], other);
  await sh(['config', 'user.email', 'other@example.com'], other);
  await sh(['config', 'commit.gpgsign', 'false'], other);
  return { ...base, remote, other };
}

test('git_pull fast-forwards from the remote', async t => {
  const { repo, other, invoke } = await withRemote(t);
  await writeFile(join(other, 'remote.txt'), 'from remote');
  await sh(['add', 'remote.txt'], other);
  await sh(['commit', '-m', 'remote commit'], other);
  await sh(['push', 'origin', 'main'], other);
  await invoke('git_pull');
  assert.equal(await readFile(join(repo, 'remote.txt'), 'utf8'), 'from remote');
});

test('git_pull refuses a remote that is an option or a transport that runs commands', async t => {
  const { repo, root, invoke } = await withRemote(t);
  const marker = join(root, 'pwned_marker.txt');
  for (const remote of ['--upload-pack=touch pwned_marker.txt', '--upload-pack', '-u', 'ext::sh -c "touch pwned_marker.txt"', 'https://example.invalid/repo.git', 'origin;touch x']) {
    await refuses(invoke('git_pull', { remote }), /invalide/i);
  }
  await assert.rejects(stat(marker), 'no injected command ran');
  await assert.rejects(stat(join(repo, 'pwned_marker.txt')), 'no marker in the repo either');
});

test('git_push sends commits to the remote', async t => {
  const { repo, remote, invoke } = await withRemote(t);
  await writeFile(join(repo, 'pushed.txt'), 'x');
  await sh(['add', 'pushed.txt'], repo);
  await sh(['commit', '-m', 'to push'], repo);
  await invoke('git_push');
  assert.match(await sh(['log', '--oneline', '-1'], remote), /to push/);
});

test('git_push cannot delete or force a remote branch, nor be redirected by an option', async t => {
  const { repo, remote, root, invoke } = await withRemote(t);
  const before = await sh(['rev-parse', 'main'], remote);
  for (const args of [
    { branch: ':main' }, { branch: '+main' }, { branch: 'main:other' }, { branch: '--delete' }, { branch: '--force' },
    { remote: '--receive-pack=touch pwned_marker.txt' }, { remote: 'ext::sh -c "touch pwned_marker.txt"' }, { remote: 'origin', branch: '-f' },
  ]) {
    await refuses(invoke('git_push', args), /invalide/i);
  }
  assert.equal(await sh(['rev-parse', 'main'], remote), before, 'the remote branch is untouched');
  await assert.rejects(stat(join(root, 'pwned_marker.txt')));
  await assert.rejects(stat(join(repo, 'pwned_marker.txt')));
});
