import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class MissingTool extends Error {}

// A refusal only counts if the tool exists: a missing tool must never pass as "it refused".
async function refuses(promise: Promise<unknown>, expected?: RegExp | string) {
  await assert.rejects(promise, (error: any) => {
    assert.ok(!(error instanceof MissingTool), error.message);
    return expected instanceof RegExp ? expected.test(String(error.message)) : true;
  });
}

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a');
  const b = join(root, 'b');
  await Promise.all([a, b].map(p => mkdir(p)));
  const { workspaceTools } = await import('../core/workspace.mts');
  const tools = await workspaceTools(a, 'node_modules/, dist/, ignored.txt');
  async function invoke(name: string, args: Record<string, unknown>) {
    const tool = tools.find(entry => entry.name === name)!;
    if (!tool) throw new MissingTool(`Missing ${name}`);
    tool.validate(args);
    return tool.execute(args, new AbortController().signal);
  }
  return { a, b, invoke, tools };
}

// ── grep_file ─────────────────────────────────────────────────────────────────────
test('grep_file lists matching lines literally and case-sensitively', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'f.txt'), 'alpha\nBeta a.b\nbeta axb\nBETA');
  assert.equal(await invoke('grep_file', { path: 'f.txt', pattern: 'beta' }), 'Line 3: beta axb');
  assert.equal(await invoke('grep_file', { path: 'f.txt', pattern: 'a.b' }), 'Line 2: Beta a.b', 'regex characters are literal: a.b does not match axb');
  assert.equal(await invoke('grep_file', { path: 'f.txt', pattern: 'zzz' }), "No matches for 'zzz'.");
});

test('grep_file refuses an empty pattern, secrets, ignored and binary files', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'f.txt'), 'x');
  await writeFile(join(a, '.env'), 'fake-secret');
  await writeFile(join(a, 'ignored.txt'), 'x');
  await writeFile(join(a, 'bin.dat'), Buffer.from([65, 0, 66]));
  await refuses(invoke('grep_file', { path: 'f.txt', pattern: '' }), /vide/i);
  for (const path of ['.env', 'ignored.txt', 'bin.dat', '../b/x', 'missing.txt']) {
    await refuses(invoke('grep_file', { path, pattern: 'x' }), path);
  }
});

test('grep_file caps its output at 200 matches and says so', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'big.txt'), Array.from({ length: 300 }, (_, i) => `hit ${i}`).join('\n'));
  const out = await invoke('grep_file', { path: 'big.txt', pattern: 'hit' });
  assert.equal(out.split('\n').filter(line => line.startsWith('Line ')).length, 200);
  assert.match(out, /capped at 200 matches/);
});

// ── glob_files ────────────────────────────────────────────────────────────────────
async function tree(a: string) {
  for (const dir of ['src/deep', 'node_modules/pkg', 'dist', '.git', '.hidden', 'docs']) await mkdir(join(a, dir), { recursive: true });
  const files: Record<string, string> = {
    'src/main.ts': 'const token = 1;\nexport const TOKEN2 = 2;', 'src/deep/util.ts': 'let Token = 3;', 'src/style.css': 'body{}',
    'docs/readme.md': 'token in docs', 'root.md': 'token root',
    'node_modules/pkg/index.ts': 'token hidden', 'dist/out.ts': 'token dist', '.git/config': 'token git', '.hidden/x.ts': 'token dot',
    '.env': 'token=fake-secret', 'ignored.txt': 'token ignored', 'id_rsa': 'token key', 'credentials.json': '{"token":"x"}', 'cert.pem': 'token pem',
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(a, name), content);
}

test('glob_files matches nested paths, or a bare name at any depth, sorted with a count', async t => {
  const { a, invoke } = await fixture(t);
  await tree(a);
  assert.equal(await invoke('glob_files', { pattern: 'src/**/*.ts' }), 'src/deep/util.ts\nsrc/main.ts\n\n2 file(s) found.');
  assert.equal(await invoke('glob_files', { pattern: '*.md' }), 'docs/readme.md\nroot.md\n\n2 file(s) found.', 'a pattern without / matches the file name at any depth');
  assert.equal(await invoke('glob_files', { pattern: '*.ts', path: 'src' }), 'src/deep/util.ts\nsrc/main.ts\n\n2 file(s) found.', 'path narrows the search');
  assert.equal(await invoke('glob_files', { pattern: '*.nothing' }), '\n\n0 file(s) found.');
});

test('glob_files skips build/vendor/hidden directories, secrets and ignored files', async t => {
  const { a, invoke } = await fixture(t);
  await tree(a);
  const everything = await invoke('glob_files', { pattern: '*' });
  for (const hidden of ['node_modules', 'dist/', '.git', '.hidden', '.env', 'ignored.txt']) {
    assert.equal(everything.includes(hidden), false, `${hidden} must not be listed`);
  }
  assert.match(everything, /src\/main\.ts/);
});

test('glob_files does not follow junctions out of the project', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'outside.ts'), 'x');
  await symlink(b, join(a, 'redirect'), 'junction');
  await writeFile(join(a, 'inside.ts'), 'x');
  const out = await invoke('glob_files', { pattern: '*.ts' });
  assert.match(out, /inside\.ts/);
  assert.equal(out.includes('outside.ts'), false);
});

test('glob_files caps its result and says so', async t => {
  const { a, invoke } = await fixture(t);
  await mkdir(join(a, 'many'));
  await Promise.all(Array.from({ length: 520 }, (_, i) => writeFile(join(a, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x')));
  const out = await invoke('glob_files', { pattern: '*.txt' });
  assert.equal(out.split('\n').filter(line => line.startsWith('many/')).length, 500);
  assert.match(out, /capped at 500/);
});

// ── grep_codebase ─────────────────────────────────────────────────────────────────
test('grep_codebase finds case-insensitive regex matches as file:line: text', async t => {
  const { a, invoke } = await fixture(t);
  await tree(a);
  const out = await invoke('grep_codebase', { pattern: 'token\\d?' });
  assert.deepEqual(out.split('\n').sort(), ['docs/readme.md:1: token in docs', 'root.md:1: token root', 'src/deep/util.ts:1: let Token = 3;', 'src/main.ts:1: const token = 1;', 'src/main.ts:2: export const TOKEN2 = 2;'].sort());
  assert.equal(await invoke('grep_codebase', { pattern: 'token', file_glob: '*.ts' }).then(r => r.split('\n').length), 3, 'file_glob keeps only .ts files');
  assert.equal(await invoke('grep_codebase', { pattern: 'token', path: 'docs' }), 'docs/readme.md:1: token in docs', 'path narrows the search');
  assert.equal(await invoke('grep_codebase', { pattern: 'no-such-thing' }), "No matches for 'no-such-thing'.");
});

test('grep_codebase never reads secrets, ignored, hidden, vendor, key material or binary files', async t => {
  const { a, invoke } = await fixture(t);
  await tree(a);
  await writeFile(join(a, 'bin.dat'), Buffer.concat([Buffer.from('token'), Buffer.from([0]), Buffer.from('x')]));
  const out = await invoke('grep_codebase', { pattern: 'token' });
  for (const leaked of ['fake-secret', '.env', 'node_modules', 'dist/', '.git', '.hidden', 'ignored.txt', 'id_rsa', 'credentials.json', 'cert.pem', 'bin.dat']) {
    assert.equal(out.includes(leaked), false, `${leaked} must not appear in results`);
  }
});

test('grep_codebase reports an invalid regex instead of throwing', async t => {
  const { invoke } = await fixture(t);
  assert.match(await invoke('grep_codebase', { pattern: '(unclosed' }), /regex invalide/i);
  await refuses(invoke('grep_codebase', { pattern: '' }), /vide/i);
});

test('grep_codebase caps its matches at 200 and long lines at 300 characters', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'many.txt'), Array.from({ length: 250 }, () => 'hit').join('\n'));
  await writeFile(join(a, 'long.txt'), 'hit ' + 'x'.repeat(1000));
  const out = await invoke('grep_codebase', { pattern: 'hit' });
  assert.match(out, /capped at 200 matches/);
  const longLine = out.split('\n').find(line => line.startsWith('long.txt:'));
  assert.ok(longLine === undefined || longLine.length <= 'long.txt:1: '.length + 300 + 1, 'a long line is cut');
});

test('grep_codebase survives a catastrophic regex by timing out instead of hanging', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'evil.txt'), 'a'.repeat(60) + 'b');
  const started = Date.now();
  await refuses(invoke('grep_codebase', { pattern: '(a+)+$' }), /coûteux|délai/i);
  assert.ok(Date.now() - started < 15000, 'the search was interrupted, not endured');
});

// ── delete_dir ────────────────────────────────────────────────────────────────────
test('delete_dir moves a directory to the project trash so it can be recovered', async t => {
  const { a, invoke } = await fixture(t);
  await mkdir(join(a, 'old/nested'), { recursive: true });
  await writeFile(join(a, 'old/nested/keep.txt'), 'recoverable');
  const result = JSON.parse(await invoke('delete_dir', { path: 'old' }));
  assert.equal(result.removed, 'old');
  assert.equal(await readFile(join(a, result.recovery_path, 'nested/keep.txt'), 'utf8'), 'recoverable');
  await assert.rejects(stat(join(a, 'old')));
});

test('delete_dir refuses the project root, files, ignored/protected paths and paths outside', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(a, 'file.txt'), 'x');
  await mkdir(join(a, 'node_modules'));
  await mkdir(join(a, '.openagent'), { recursive: true });
  await mkdir(join(b, 'outside'));
  for (const path of ['.', 'file.txt', 'node_modules', '.openagent', '.git', '../b/outside', 'missing']) {
    await refuses(invoke('delete_dir', { path }), path);
  }
  assert.deepEqual((await readdir(b)).sort(), ['outside']);
});

test('delete_dir moves a junction inside the directory without touching its target', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'precious.txt'), 'outside');
  await mkdir(join(a, 'dir'));
  await symlink(b, join(a, 'dir/link'), 'junction');
  await invoke('delete_dir', { path: 'dir' });
  assert.equal(await readFile(join(b, 'precious.txt'), 'utf8'), 'outside', 'the junction target was never followed');
});

test('delete_dir refuses a directory reached through a junction', async t => {
  const { a, b, invoke } = await fixture(t);
  await mkdir(join(b, 'inner'));
  await symlink(b, join(a, 'redirect'), 'junction');
  await refuses(invoke('delete_dir', { path: 'redirect/inner' }));
  await refuses(invoke('delete_dir', { path: 'redirect' }));
  assert.deepEqual(await readdir(b), ['inner']);
});
