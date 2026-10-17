import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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

async function fixture(t: any, ignoredPatterns = '', options?: { onListed?: () => Promise<void> }) {
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
  const tools = await gitTools(repo, ignoredPatterns, options);
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
  const tools = await gitTools(plain, '');
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
  await refuses(invoke('git_log', { n: 0 }), /n doit être un entier entre 1 et/);
  await refuses(invoke('git_log', { n: 201 }), /n doit être un entier entre 1 et/);
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
  await refuses(invoke('git_blame', { file: 'f.txt', start: 0 }), /start doit être un entier entre/);
});

// ── secret, ignored and protected files in diff and blame (2026-10-17) ───────────────────────────
const MASKED = 'Fichiers masqués (secrets ou exclus), contenu non affiché : ';

/** Windows' 8.3 short name of an existing path (cmd's %~sI, as in workspace.test.mts), or null when the volume gives it none. */
function shortName(path: string): string | null {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const name = result.status === 0 ? basename(result.stdout.trim()) : '';
  return name && name !== basename(path) ? name : null;
}

/** A repository whose project ignores private/**, with a normal file, two key-material files and an ignored file, all
 * committed (the project's ignored_patterns are the app's, not a .gitignore: git tracks them). */
async function secretsFixture(t: any) {
  const fx = await fixture(t, 'private/**');
  await mkdir(join(fx.repo, 'private'));
  const files: Record<string, string> = { 'app.ts': 'APP-OLD\n', 'secrets.json': 'SECRET-JSON-OLD\n', 'key.pem': 'SECRET-PEM-OLD\n', 'private/notes.md': 'SECRET-PRIVATE-OLD\n' };
  for (const [name, content] of Object.entries(files)) await writeFile(join(fx.repo, name), content);
  await sh(['add', '--', ...Object.keys(files)], fx.repo);
  await sh(['commit', '-m', 'files'], fx.repo);
  const modify = async () => {
    await writeFile(join(fx.repo, 'app.ts'), 'APP-NEW\n');
    await writeFile(join(fx.repo, 'secrets.json'), 'SECRET-JSON-NEW\n');
    await writeFile(join(fx.repo, 'key.pem'), 'SECRET-PEM-NEW\n');
    await writeFile(join(fx.repo, 'private', 'notes.md'), 'SECRET-PRIVATE-NEW\n');
  };
  return { ...fx, modify };
}

const lastLine = (out: string) => out.split('\n').at(-1);
const refusedWithoutContent = (pattern: RegExp) => (error: Error) => {
  assert.match(error.message, pattern);
  assert.equal(error.message.includes('SECRET-'), false);
  return true;
};

test('git_diff shows the normal changes and names, without content, the secret and ignored files that changed', async t => {
  const { invoke, modify } = await secretsFixture(t);
  await modify();
  const out = await invoke('git_diff');
  assert.match(out, /\+APP-NEW/);
  assert.equal(out.includes('SECRET-'), false, out);
  assert.equal(lastLine(out), MASKED + 'key.pem, private/notes.md, secrets.json');
  assert.equal(out.split('\n').filter(line => line.startsWith('Fichiers masqués')).length, 1, 'exactly one masked line');
});

test('git_diff_staged shows the normal staged changes and names, without content, the secret and ignored files staged', async t => {
  const { repo, invoke, modify } = await secretsFixture(t);
  await modify();
  await sh(['add', '--', 'app.ts', 'secrets.json', 'key.pem', 'private/notes.md'], repo);
  const out = await invoke('git_diff_staged');
  assert.match(out, /\+APP-NEW/);
  assert.equal(out.includes('SECRET-'), false, out);
  assert.equal(lastLine(out), MASKED + 'key.pem, private/notes.md, secrets.json');
  assert.equal(await invoke('git_diff'), 'No changes.', 'nothing left unstaged, nothing masked');
});

test('when only hidden files changed, the diffs give the empty-diff text and the masked line', async t => {
  const { repo, invoke } = await secretsFixture(t);
  await writeFile(join(repo, 'secrets.json'), 'SECRET-JSON-ONLY\n');
  assert.equal(await invoke('git_diff'), 'No changes.\n' + MASKED + 'secrets.json');
  await sh(['add', 'secrets.json'], repo);
  assert.equal(await invoke('git_diff_staged'), 'No changes (staged).\n' + MASKED + 'secrets.json');
});

test('a rename to or from a secret file is hidden, both names given, no content', async t => {
  const { repo, invoke } = await secretsFixture(t);
  const body = (name: string) => Array.from({ length: 20 }, (_, i) => `${name} line ${i}`).join('\n');
  await writeFile(join(repo, 'app.ts'), body('app') + '\n');
  await writeFile(join(repo, 'secrets.json'), body('secret') + '\nSECRET-ORIGINAL\n');
  await sh(['add', 'app.ts', 'secrets.json'], repo);
  await sh(['commit', '-m', 'bodies'], repo);
  // Normal → secret: what app.ts held now lives in credentials.json, with one secret line added.
  await sh(['mv', 'app.ts', 'credentials.json'], repo);
  await writeFile(join(repo, 'credentials.json'), body('app') + '\nSECRET-RENAMED-IN\n');
  await sh(['add', 'credentials.json'], repo);
  // Secret → normal: secrets.json becomes a plain file; a plain diff would show its old secret line as removed.
  await sh(['mv', 'secrets.json', 'public.txt'], repo);
  await writeFile(join(repo, 'public.txt'), body('secret') + '\nPUBLIC-NOW\n');
  await sh(['add', 'public.txt'], repo);
  const status = await sh(['diff', '--staged', '--name-status'], repo);
  assert.match(status, /^R\d+\s+app\.ts\s+credentials\.json$/m, 'sanity: git sees a rename');
  assert.match(status, /^R\d+\s+secrets\.json\s+public\.txt$/m, 'sanity: git sees a rename');
  const out = await invoke('git_diff_staged');
  assert.equal(/SECRET-|PUBLIC-NOW|line 3/.test(out), false, out);
  const masked = lastLine(out)!;
  assert.ok(masked.startsWith(MASKED), out);
  for (const name of ['app.ts', 'credentials.json', 'secrets.json', 'public.txt']) assert.ok(masked.includes(name), `${name} in ${masked}`);
  assert.equal(out, 'No changes (staged).\n' + masked);
});

test('git_blame and git_diff refuse a secret, ignored or protected file by name, with no content', async t => {
  const { repo, invoke, modify } = await secretsFixture(t);
  await modify();
  await assert.rejects(invoke('git_blame', { file: 'secrets.json' }), refusedWithoutContent(/^Fichier secret : blame refusé/));
  await assert.rejects(invoke('git_blame', { file: 'key.pem' }), refusedWithoutContent(/^Fichier secret : blame refusé/));
  await assert.rejects(invoke('git_blame', { file: 'private/notes.md' }), refusedWithoutContent(/^Fichier ignoré ou protégé : blame refusé/));
  await assert.rejects(invoke('git_diff', { file: 'secrets.json' }), refusedWithoutContent(/^Fichier secret : diff refusé/));
  await assert.rejects(invoke('git_diff', { file: 'private/notes.md' }), refusedWithoutContent(/^Fichier ignoré ou protégé : diff refusé/));
  await assert.rejects(invoke('git_diff', { file: '.git/config' }), refusedWithoutContent(/^Fichier ignoré ou protégé : diff refusé/));
  await assert.rejects(invoke('git_diff', { file: '../outside' }), refusedWithoutContent(/^Chemin hors projet ou racine protégée : diff refusé/));
  // .git is matched whatever its case, by name.
  await assert.rejects(invoke('git_diff', { file: '.GIT' }), refusedWithoutContent(/^Fichier ignoré ou protégé : diff refusé/));
  // PRIVATE/ is another spelling of private/ only where names ignore case (Windows, macOS by default).
  await t.test('through another case of the ignored folder', async st => {
    if (!existsSync(join(repo, 'PRIVATE'))) { st.skip('case-sensitive file system: PRIVATE/ is another folder'); return; }
    await assert.rejects(invoke('git_blame', { file: 'PRIVATE/notes.md' }), refusedWithoutContent(/^Fichier ignoré ou protégé : blame refusé/));
    await assert.rejects(invoke('git_diff', { file: 'PRIVATE/notes.md' }), refusedWithoutContent(/^Fichier ignoré ou protégé : diff refusé/));
    // private/** matches what is under private/, not the folder itself (the file tools' rule): the folder is diffed, and
    // every file in it is masked by name, under its name on disk.
    assert.equal(await invoke('git_diff', { file: 'PRIVATE' }), 'No changes.\n' + MASKED + 'private/notes.md');
  });
});

test('git_blame and git_diff check the name on disk: an 8.3 short name never reaches a secret file or .git', async t => {
  const { repo, invoke, modify } = await secretsFixture(t);
  await modify();
  const [secret, gitDir] = [shortName(join(repo, 'secrets.json')), shortName(join(repo, '.git'))];
  if (!secret || !gitDir) { t.skip('no 8.3 short names on this volume'); return; }
  await assert.rejects(invoke('git_blame', { file: secret }), refusedWithoutContent(/^Fichier secret : blame refusé/), secret);
  await assert.rejects(invoke('git_diff', { file: secret }), refusedWithoutContent(/^Fichier secret : diff refusé/), secret);
  await assert.rejects(invoke('git_diff', { file: gitDir }), refusedWithoutContent(/^Fichier ignoré ou protégé : diff refusé/), gitDir);
  await assert.rejects(invoke('git_blame', { file: `${gitDir}/config` }), refusedWithoutContent(/^Fichier ignoré ou protégé : blame refusé/), gitDir);
});

test('git_blame and git_diff still work on a normal file, also through another case of its folder, and use the name on disk', async t => {
  const { repo, invoke } = await fixture(t, 'private/**');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'app.ts'), 'NORMAL-OLD\n');
  await writeFile(join(repo, 'src', 'key.pem'), 'SECRET-IN-SRC-OLD\n');
  await sh(['add', 'src'], repo);
  await sh(['commit', '-m', 'src'], repo);
  await writeFile(join(repo, 'src', 'app.ts'), 'NORMAL-NEW\n');
  await writeFile(join(repo, 'src', 'key.pem'), 'SECRET-IN-SRC-NEW\n');
  const checkFile = async (file: string) => {
    assert.match(await invoke('git_blame', { file }), /Not Committed Yet.*NORMAL-NEW/, file);
    const diff = await invoke('git_diff', { file });
    assert.match(diff, /^diff --git a\/src\/app\.ts b\/src\/app\.ts$/m, file);
    assert.match(diff, /\+NORMAL-NEW/, file);
    assert.equal(diff.includes('Fichiers masqués'), false, file);
  };
  // A folder is allowed when the folder itself is: the files inside are filtered one by one.
  const checkFolder = async (file: string) => {
    const folder = await invoke('git_diff', { file });
    assert.match(folder, /\+NORMAL-NEW/, file);
    assert.equal(folder.includes('SECRET-'), false, folder);
    assert.equal(lastLine(folder), MASKED + 'src/key.pem', file);
  };
  for (const file of ['src/app.ts', 'src\\app.ts']) await checkFile(file);
  await checkFolder('src');
  await t.test('through another case of the folder', async st => {
    if (!existsSync(join(repo, 'SRC'))) { st.skip('case-sensitive file system: SRC/ is another folder'); return; }
    await checkFile('SRC/app.ts');
    await checkFolder('SRC');
  });
});

test('too many hidden files for one command line: the visible ones are still diffed, nothing hidden is shown', async t => {
  const { repo, invoke } = await fixture(t, 'private/**');
  await mkdir(join(repo, 'private'));
  // 700 exclusions of ~60 characters: far past what one Windows command line can safely carry next to git's own arguments.
  const names = Array.from({ length: 700 }, (_, i) => `private/a-rather-long-file-name-to-fill-the-line-${String(i).padStart(4, '0')}.md`);
  for (const name of names) await writeFile(join(repo, name), 'SECRET-MANY-OLD\n');
  await writeFile(join(repo, 'app.ts'), 'APP-OLD\n');
  await sh(['add', '--', 'private', 'app.ts'], repo);
  await sh(['commit', '-q', '-m', 'many'], repo);
  for (const name of names) await writeFile(join(repo, name), 'SECRET-MANY-NEW\n');
  await writeFile(join(repo, 'app.ts'), 'APP-NEW\n');
  const out = await invoke('git_diff');
  assert.match(out, /\+APP-NEW/);
  assert.equal(out.includes('SECRET-'), false);
  assert.equal(lastLine(out), MASKED + names.slice(0, 200).join(', ') + ', … (+500)');
});

test('a project inside a larger repository: its ignored patterns apply under its folder, paths are named from the top', async t => {
  const { repo } = await fixture(t);
  const project = join(repo, 'sub');
  await mkdir(join(project, 'private'), { recursive: true });
  await writeFile(join(project, 'app.ts'), 'APP-OLD\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-NESTED-OLD\n');
  await sh(['add', 'sub'], repo);
  await sh(['commit', '-m', 'sub'], repo);
  await writeFile(join(project, 'app.ts'), 'APP-NEW\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-NESTED-NEW\n');
  const { gitTools } = await import('../core/git-tools.mts');
  const tools = await gitTools(project, 'private/**');
  const diff = await tools.find(tool => tool.name === 'git_diff')!.execute({}, new AbortController().signal);
  assert.match(diff, /\+APP-NEW/);
  assert.equal(diff.includes('SECRET-'), false, diff);
  assert.equal(lastLine(diff), MASKED + 'sub/private/notes.md');
});

test('a file that changes between the listing and the diff is never shown: only the listed visible paths are diffed', async t => {
  let between: (() => Promise<void>) | null = null;
  let ran = 0;
  const { repo, invoke } = await fixture(t, '', { onListed: async () => { ran++; await between?.(); } });
  await writeFile(join(repo, 'app.ts'), 'APP-OLD\n');
  await writeFile(join(repo, 'secrets.json'), 'SECRET-RACE-OLD\n');
  await sh(['add', 'app.ts', 'secrets.json'], repo);
  await sh(['commit', '-m', 'files'], repo);

  // Nothing changed at listing time, a secret changes right after it.
  between = () => writeFile(join(repo, 'secrets.json'), 'SECRET-RACE-ONLY\n');
  assert.equal(await invoke('git_diff'), 'No changes.');
  assert.match(await sh(['diff'], repo), /SECRET-RACE-ONLY/, 'sanity: the secret did change before the diff could run');

  // A visible change is listed, the secret changes right after: only the visible one is diffed.
  await sh(['checkout', '--', 'secrets.json'], repo);
  await writeFile(join(repo, 'app.ts'), 'APP-NEW\n');
  between = () => writeFile(join(repo, 'secrets.json'), 'SECRET-RACE-NEW\n');
  const unstaged = await invoke('git_diff');
  assert.match(unstaged, /\+APP-NEW/);
  assert.equal(/SECRET-RACE|secrets\.json/.test(unstaged), false, unstaged);

  // Same for the index: the secret is staged right after the listing.
  await sh(['checkout', '--', 'secrets.json'], repo);
  await sh(['add', 'app.ts'], repo);
  between = async () => { await writeFile(join(repo, 'secrets.json'), 'SECRET-RACE-STAGED\n'); await sh(['add', 'secrets.json'], repo); };
  const staged = await invoke('git_diff_staged');
  assert.match(staged, /\+APP-NEW/);
  assert.equal(/SECRET-RACE|secrets\.json/.test(staged), false, staged);
  assert.equal(ran, 3, 'the hook ran between the listing and the diff of each call');
});

test('a visible path replaced, between the listing and the diff, by a folder of secrets: nothing of them shown, their names masked', async t => {
  let between: (() => Promise<void>) | null = null;
  const { repo, invoke } = await fixture(t, '', { onListed: async () => { await between?.(); } });
  await writeFile(join(repo, 'conf'), 'CONF-OLD\n');
  await writeFile(join(repo, 'app.ts'), 'APP-OLD\n');
  await sh(['add', 'conf', 'app.ts'], repo);
  await sh(['commit', '-m', 'files'], repo);
  await writeFile(join(repo, 'conf'), 'CONF-NEW\n');
  await writeFile(join(repo, 'app.ts'), 'APP-NEW\n');
  await sh(['add', 'conf', 'app.ts'], repo);
  between = async () => {
    await sh(['rm', '-q', '--cached', 'conf'], repo);
    await rm(join(repo, 'conf'));
    await mkdir(join(repo, 'conf'));
    await writeFile(join(repo, 'conf', 'id_rsa'), 'SECRET-WINDOW\n');
    await writeFile(join(repo, 'conf', 'x.pem'), 'SECRET-PEM\n');
    await sh(['add', 'conf'], repo);
  };
  const out = await invoke('git_diff_staged');
  assert.equal(out.includes('SECRET-'), false, out);
  assert.match(out, /\+APP-NEW/);
  assert.equal(lastLine(out), MASKED + 'conf/id_rsa, conf/x.pem');
});

test('names git quotes in a header are matched as git quotes them: visible ones shown, unlisted ones masked by name', async t => {
  let between: (() => Promise<void>) | null = null;
  const { repo, invoke } = await fixture(t, '', { onListed: async () => { await between?.(); } });
  // Staged straight into the index: '"', '\' and a tab cannot be in a Windows file name, a clone made elsewhere has them.
  const stage = (content: string, name: string) => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).trim();
    execFileSync('git', ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},${name}`], { cwd: repo });
  };
  const visible = ['q"uote.txt', 'back\\slash.txt', 'tab\there.txt', 'sp ace.txt', 'é.txt', 'dir/sp ace "q".txt'];
  for (const name of visible) stage('VISIBLE-Q\n', name);
  const out = await invoke('git_diff_staged');
  assert.equal(out.split('\n').filter(line => line === '+VISIBLE-Q').length, visible.length, out);
  assert.equal(out.includes('Fichiers masqués'), false, out);

  // A visible path becomes a folder of unlisted files with such names: dropped, and named.
  await sh(['commit', '-q', '-m', 'quoted'], repo);
  await writeFile(join(repo, 'conf'), 'CONF-OLD\n');
  await sh(['add', 'conf'], repo);
  await sh(['commit', '-q', '-m', 'conf'], repo);
  await writeFile(join(repo, 'conf'), 'CONF-NEW\n');
  await sh(['add', 'conf'], repo);
  between = async () => {
    await sh(['rm', '-q', '--cached', 'conf'], repo);
    stage('SECRET-Q1\n', 'conf/sp ace.txt');
    stage('SECRET-Q2\n', 'conf/q"x\ty.txt');
  };
  const raced = await invoke('git_diff_staged');
  assert.equal(raced.includes('SECRET-'), false, raced);
  assert.equal(lastLine(raced), MASKED + '"conf/q\\"x\\ty.txt", conf/sp ace.txt');
});

test("a repository's diff config never changes what is shown: noprefix, mnemonicPrefix, color, relative", async t => {
  const { repo, invoke } = await fixture(t, 'private/**');
  await writeFile(join(repo, 'app.ts'), 'APP-OLD\n');
  await sh(['add', 'app.ts'], repo);
  await sh(['commit', '-m', 'app'], repo);
  await writeFile(join(repo, 'app.ts'), 'APP-NEW\n');
  for (const [key, value] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['color.ui', 'always'], ['color.diff', 'always'], ['diff.relative', 'true']]) {
    await sh(['config', key, value], repo);
    const out = await invoke('git_diff');
    assert.match(out, /^diff --git a\/app\.ts b\/app\.ts$/m, `${key}=${value}: ${out}`);
    assert.match(out, /^\+APP-NEW$/m, `${key}=${value}`);
  }
});

test('a project inside a larger repository with diff.relative set still shows its changes and masks its ignored files', async t => {
  const { repo } = await fixture(t);
  const project = join(repo, 'sub');
  await mkdir(join(project, 'private'), { recursive: true });
  await writeFile(join(project, 'app.ts'), 'APP-OLD\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-REL-OLD\n');
  await sh(['add', 'sub'], repo);
  await sh(['commit', '-m', 'sub'], repo);
  await sh(['config', 'diff.relative', 'true'], repo);
  await writeFile(join(project, 'app.ts'), 'APP-NEW\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-REL-NEW\n');
  const { gitTools } = await import('../core/git-tools.mts');
  const tools = await gitTools(project, 'private/**');
  const diff = await tools.find(tool => tool.name === 'git_diff')!.execute({}, new AbortController().signal);
  assert.match(diff, /\+APP-NEW/);
  assert.equal(diff.includes('SECRET-'), false, diff);
  assert.equal(lastLine(diff), MASKED + 'sub/private/notes.md');
});

test('a rename between two visible names is still shown as a rename', async t => {
  const { repo, invoke } = await fixture(t);
  const body = Array.from({ length: 20 }, (_, i) => `old line ${i}`).join('\n');
  await writeFile(join(repo, 'old.ts'), body + '\n');
  await sh(['add', 'old.ts'], repo);
  await sh(['commit', '-m', 'old'], repo);
  await sh(['mv', 'old.ts', 'new.ts'], repo);
  await writeFile(join(repo, 'new.ts'), body + '\nRENAMED-LINE\n');
  await sh(['add', 'new.ts'], repo);
  const out = await invoke('git_diff_staged');
  assert.match(out, /^rename from old\.ts$/m);
  assert.match(out, /^rename to new\.ts$/m);
  assert.match(out, /\+RENAMED-LINE/);
});

test('a project inside a folder its own ignored patterns name (repo/dist/site with dist ignored) still shows its files', async t => {
  const { repo } = await fixture(t);
  const project = join(repo, 'dist', 'site');
  await mkdir(join(project, 'private'), { recursive: true });
  await writeFile(join(project, 'app.ts'), 'APP-OLD\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-DIST-OLD\n');
  await sh(['add', 'dist'], repo);
  await sh(['commit', '-m', 'dist'], repo);
  await writeFile(join(project, 'app.ts'), 'APP-NEW\n');
  await writeFile(join(project, 'private', 'notes.md'), 'SECRET-DIST-NEW\n');
  const { gitTools } = await import('../core/git-tools.mts');
  const tools = await gitTools(project, 'dist,private/**');
  const diff = await tools.find(tool => tool.name === 'git_diff')!.execute({}, new AbortController().signal);
  assert.match(diff, /\+APP-NEW/);
  assert.equal(diff.includes('SECRET-'), false, diff);
  assert.equal(lastLine(diff), MASKED + 'dist/site/private/notes.md');
});

test('a hidden name with a control character stays on the one masked line, quoted', async t => {
  const { repo, invoke } = await fixture(t, 'private/**');
  // Staged straight into the index (no file on disk), so the name exists on every platform, Windows included, where a
  // file name cannot hold a newline. A repository cloned from elsewhere can carry such a name.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'SECRET-NL\n', encoding: 'utf8' }).trim();
  // core.protectNTFS (on by default in Git for Windows) refuses the name; a clone made elsewhere has it anyway.
  execFileSync('git', ['-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},private/a\nb.md`], { cwd: repo });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},private/plain.md`], { cwd: repo });
  const out = await invoke('git_diff_staged');
  assert.equal(out, 'No changes (staged).\n' + MASKED + '"private/a\\nb.md", private/plain.md');
});

test('git_branch_list shows the branches', async t => {
  const { invoke } = await fixture(t);
  assert.match(await invoke('git_branch_list'), /main/);
});

// ── read tools never run commands declared in the repository's own config ─────────────
const exists = (path: string) => stat(path).then(() => true, () => false);
let tick = 0;
/** Gives a tracked file a new mtime, so git must re-read it (and run its clean filter) to know it is unchanged. */
const restat = (file: string) => utimes(file, new Date(2001, 0, 1, 0, 0, ++tick), new Date(2001, 0, 1, 0, 0, tick));
const markingFilter = (marker: string) => `sh -c 'echo ran > "${marker}"; cat'`;
const READ_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['git_status', {}], ['git_diff', {}], ['git_diff_staged', {}], ['git_log', {}], ['git_log', { oneline: false }], ['git_blame', { file: 'a.txt' }], ['git_branch_list', {}],
];

async function filteredFixture(t: any, name: string) {
  const base = await fixture(t);
  const marker = join(base.root, 'filter-ran').replace(/\\/g, '/');
  await writeFile(join(base.repo, '.gitattributes'), `*.txt filter=${name}\n`);
  await writeFile(join(base.repo, 'a.txt'), 'hi\n');
  await sh(['add', '.gitattributes', 'a.txt'], base.repo);
  await sh(['commit', '-m', 'filtered'], base.repo);
  await sh(['config', `filter.${name}.clean`, markingFilter(marker)], base.repo);
  await sh(['config', `filter.${name}.smudge`, 'cat'], base.repo);
  return { ...base, marker, file: join(base.repo, 'a.txt') };
}

test('read tools never run a clean filter the repository\'s own .git/config declares', async t => {
  const { repo, marker, file, invoke } = await filteredFixture(t, 'ev.il');
  await restat(file);
  await sh(['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', 'status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: the previous guard alone still runs the filter');
  await rm(marker);
  for (const [name, args] of READ_TOOLS) {
    await restat(file);
    await invoke(name, args);
    assert.equal(await exists(marker), false, `${name} ran the repository’s clean filter`);
  }
  assert.equal(await invoke('git_status'), 'Working tree clean.');
  assert.equal(await invoke('git_diff'), 'No changes.');
  assert.match(await invoke('git_blame', { file: 'a.txt' }), /hi/);
});

test('git_blame never runs a textconv the repository\'s own .git/config declares', async t => {
  const { repo, root, invoke } = await fixture(t);
  const marker = join(root, 'textconv-ran').replace(/\\/g, '/');
  await writeFile(join(repo, '.gitattributes'), '*.txt diff=conv\n');
  await writeFile(join(repo, 'a.txt'), 'hi\n');
  await sh(['add', '.gitattributes', 'a.txt'], repo);
  await sh(['commit', '-m', 'conv'], repo);
  await sh(['config', 'diff.conv.textconv', `sh -c 'echo ran > "${marker}"; cat "$1"' -`], repo);
  await sh(['blame', '--', 'a.txt'], repo);
  assert.equal(await exists(marker), true, 'control: plain git blame runs textconv by default');
  await rm(marker);
  assert.match(await invoke('git_blame', { file: 'a.txt' }), /hi/);
  assert.equal(await exists(marker), false, 'git_blame ran the repository’s textconv');
});

test('git_log never runs the repository\'s gpg.program, even with log.showSignature and a signed commit', async t => {
  const { repo, root, invoke } = await fixture(t);
  const marker = join(root, 'gpg-ran').replace(/\\/g, '/');
  const gpg = join(root, 'fake-gpg.sh').replace(/\\/g, '/');
  await writeFile(gpg, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`, { mode: 0o755 });
  // Re-create HEAD as a commit object carrying a gpgsig header (continuation lines start with a space).
  const raw = await sh(['cat-file', 'commit', 'HEAD'], repo);
  const signed = raw.replace(/^(committer .*)$/m, '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----') + '\n';
  const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: signed }).toString().trim();
  await sh(['update-ref', 'HEAD', sha], repo);
  await sh(['config', 'log.showSignature', 'true'], repo);
  await sh(['config', 'gpg.program', gpg], repo);
  await sh(['log', '-n', '1', '--oneline'], repo).catch(() => '');
  assert.equal(await exists(marker), true, 'control: plain git log verifies the signature with gpg.program');
  await rm(marker);
  assert.match(await invoke('git_log'), /initial/);
  assert.match(await invoke('git_log', { oneline: false }), /initial/);
  assert.equal(await exists(marker), false, 'git_log ran the repository’s gpg.program');
});

test('read tools never run a hook from the repository\'s own .git/hooks when git refreshes the index', async t => {
  const { repo, root, invoke } = await fixture(t);
  const marker = join(root, 'hook-ran').replace(/\\/g, '/');
  const file = join(repo, 'README.md');
  await writeFile(join(repo, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  await restat(file);
  await sh(['-c', 'core.fsmonitor=false', 'diff'], repo);
  assert.equal(await exists(marker), true, 'control: plain git diff runs post-index-change');
  await rm(marker);
  for (const name of ['git_status', 'git_diff']) {
    await restat(file);
    await invoke(name);
    assert.equal(await exists(marker), false, `${name} ran the repository’s post-index-change hook`);
  }
});

test('read tools never run a filter declared only in a submodule\'s own config', async t => {
  const { root, repo } = await fixture(t);
  const sub = join(root, 'sub');
  const marker = join(root, 'submodule-filter-ran').replace(/\\/g, '/');
  await mkdir(sub);
  await sh(['init', '-b', 'main'], sub);
  await sh(['config', 'user.name', 'Test'], sub);
  await sh(['config', 'user.email', 'test@example.com'], sub);
  await sh(['config', 'commit.gpgsign', 'false'], sub);
  await writeFile(join(sub, '.gitattributes'), '*.txt filter=subonly\n');
  await writeFile(join(sub, 's.txt'), 'inside\n');
  await sh(['add', '.'], sub);
  await sh(['commit', '-m', 'sub'], sub);
  await sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '../sub', 'sub'], repo);
  await sh(['commit', '-m', 'add submodule'], repo);
  await sh(['config', 'filter.subonly.clean', markingFilter(marker)], join(repo, 'sub'));
  const file = join(repo, 'sub', 's.txt');
  await restat(file);
  await sh(['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', 'status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: plain git status recurses into the submodule and runs its filter');
  await rm(marker);
  const { gitTools } = await import('../core/git-tools.mts');
  const tools = await gitTools(repo, '');
  for (const name of ['git_status', 'git_diff']) {
    await restat(file);
    await tools.find(entry => entry.name === name)!.execute({}, new AbortController().signal);
    assert.equal(await exists(marker), false, `${name} ran the submodule’s clean filter`);
  }
});

test('read tools fail closed: nothing runs when the repository config cannot be neutralised or read', async t => {
  // A filter name containing "=" cannot be overridden with -c (git would read "filter.a" = "b.clean=").
  const { repo, marker, file, invoke } = await filteredFixture(t, 'a=b');
  await restat(file);
  await sh(['status', '--porcelain'], repo);
  assert.equal(await exists(marker), true, 'control: plain git status runs the "a=b" filter');
  await rm(marker);
  for (const [name, args] of READ_TOOLS) {
    await restat(file);
    await refuses(invoke(name, args), /configuration git du dépôt.*non lancée/);
    assert.equal(await exists(marker), false, `${name} ran something after the guard refused`);
  }
  await writeFile(join(repo, '.git', 'config'), '[core\nbroken', { flag: 'a' });
  await refuses(invoke('git_status'), /configuration git du dépôt.*non lancée/);
});

test('read tools fail closed on a filter whose name is not valid UTF-8', async t => {
  const { repo, root, invoke } = await fixture(t);
  const marker = join(root, 'bad-utf8-filter-ran').replace(/\\/g, '/');
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
  for (const [tool, args] of READ_TOOLS) {
    await restat(join(repo, 'a.txt'));
    await refuses(invoke(tool, args), /configuration git du dépôt.*non lancée/);
    assert.equal(await exists(marker), false, `${tool} ran the non-UTF-8-named filter`);
  }
});

test('git_blame never runs the repository\'s upload-pack command through a partial clone\'s lazy fetch', async t => {
  const { root } = await fixture(t);
  const server = join(root, 'server');
  const repo = join(root, 'partial');
  const marker = join(root, 'lazy-fetch-ran').replace(/\\/g, '/');
  await mkdir(server);
  await sh(['init', '-b', 'main'], server);
  for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true']]) {
    await sh(['config', key, value], server);
  }
  for (const content of ['one\n', 'one\ntwo\n']) {
    await writeFile(join(server, 'a.txt'), content);
    await sh(['add', 'a.txt'], server);
    await sh(['commit', '-m', content.trim().split('\n').pop()!], server);
  }
  // The checkout fetches only the tip's blob: blaming a.txt needs the older one.
  await sh(['clone', '--filter=blob:none', `file://${server.replace(/\\/g, '/')}`, repo], root);
  await sh(['config', 'remote.origin.uploadpack', `sh -c 'echo ran > "${marker}"' x`], repo);
  await sh(['blame', '--no-textconv', '--', 'a.txt'], repo).catch(() => '');
  assert.equal(await exists(marker), true, 'control: plain git blame lazily fetches through the repository\'s upload-pack');
  await rm(marker);
  const { gitTools } = await import('../core/git-tools.mts');
  const tools = await gitTools(repo, '');
  await tools.find(entry => entry.name === 'git_blame')!.execute({ file: 'a.txt' }, new AbortController().signal).catch(() => '');
  assert.equal(await exists(marker), false, 'git_blame ran the repository’s upload-pack command');
});

test('diff tools never run a diff driver declared in a submodule\'s own config (diff.submodule=diff)', async t => {
  const { root, repo } = await fixture(t);
  const sub = join(root, 'sub');
  const marker = join(root, 'submodule-diff-ran').replace(/\\/g, '/');
  await mkdir(sub);
  await sh(['init', '-b', 'main'], sub);
  await sh(['config', 'user.name', 'Test'], sub);
  await sh(['config', 'user.email', 'test@example.com'], sub);
  await sh(['config', 'commit.gpgsign', 'false'], sub);
  await writeFile(join(sub, '.gitattributes'), '*.txt diff=conv\n');
  await writeFile(join(sub, 's.txt'), 'inside\n');
  await sh(['add', '.'], sub);
  await sh(['commit', '-m', 'sub'], sub);
  await sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', '../sub', 'sub'], repo);
  await sh(['commit', '-m', 'add submodule'], repo);
  const inner = join(repo, 'sub');
  await sh(['config', 'user.name', 'Test'], inner);
  await sh(['config', 'user.email', 'test@example.com'], inner);
  await sh(['config', 'commit.gpgsign', 'false'], inner);
  await writeFile(join(inner, 's.txt'), 'inside\nmoved\n');
  await sh(['commit', '-am', 'moved'], inner);
  // Superproject asks for inline submodule diffs; the submodule's own config names the driver.
  await sh(['config', 'diff.submodule', 'diff'], repo);
  await sh(['config', 'diff.conv.command', `sh -c 'echo ran > "${marker}"' x`], inner);
  const previousGuard = ['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];
  const { gitTools } = await import('../core/git-tools.mts');
  const tools = await gitTools(repo, '');
  const invoke = (name: string) => tools.find(entry => entry.name === name)!.execute({}, new AbortController().signal);
  await sh(previousGuard, repo);
  assert.equal(await exists(marker), true, 'control: the previous guard still runs the submodule’s driver (unstaged)');
  await rm(marker);
  assert.match(await invoke('git_diff'), /sub/);
  assert.equal(await exists(marker), false, 'git_diff ran the submodule’s diff driver');
  await sh(['add', 'sub'], repo);
  await sh([...previousGuard, '--staged'], repo);
  assert.equal(await exists(marker), true, 'control: the previous guard still runs the submodule’s driver (staged)');
  await rm(marker);
  assert.match(await invoke('git_diff_staged'), /sub/);
  assert.equal(await exists(marker), false, 'git_diff_staged ran the submodule’s diff driver');
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
