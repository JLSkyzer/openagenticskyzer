import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'); const b = join(root, 'b');
  await Promise.all([a, b].map(p => mkdir(p)));
  const { workspaceTools } = await import('../core/workspace.mts');
  const tools = await workspaceTools(a, 'node_modules/, dist/, ignored.txt');
  async function invoke(name: string, args: Record<string, unknown>) {
    const tool = tools.find(t => t.name === name)!;
    assert.ok(tool, `Missing ${name}`);
    tool.validate(args);
    return tool.execute(args, new AbortController().signal);
  }
  return { root, a, b, invoke };
}

test('workspace file tools use their captured project and preserve existing files on create/edit errors', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'file.txt'), 'other-project');
  await invoke('create_file', { path: 'file.txt', content: 'one\ntwo\nthree' });
  assert.match(await invoke('read_file', { path: 'file.txt', offset: 2, limit: 1 }), /2.*two/);
  await assert.rejects(invoke('create_file', { path: 'file.txt', content: 'overwrite' }));
  await assert.rejects(invoke('edit_file', { path: 'file.txt', old_string: 'absent', new_string: 'bad' }));
  await invoke('edit_file', { path: 'file.txt', old_string: 'two', new_string: 'TWO' });
  assert.equal(await readFile(join(a, 'file.txt'), 'utf8'), 'one\nTWO\nthree');
  assert.equal(await readFile(join(b, 'file.txt'), 'utf8'), 'other-project');
});

test('workspace rejects traversal, ignored files, secret files, metadata and Windows alternate streams', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'private.txt'), 'external');
  await writeFile(join(a, '.env'), 'fake-private');
  await writeFile(join(a, 'ignored.txt'), 'ignored');
  for (const path of ['../b/private.txt', '..\\b\\private.txt', '.env', '.env.local', '.git/config', '.openagent/config.json', 'ignored.txt', 'file.txt:stream', 'dist/output.txt']) {
    await assert.rejects(invoke('read_file', { path }), path);
    await assert.rejects(invoke('create_file', { path, content: 'no' }), path);
  }
  assert.equal(await readFile(join(b, 'private.txt'), 'utf8'), 'external');
  assert.equal(await readFile(join(a, '.env'), 'utf8'), 'fake-private');
});

test('directory junctions cannot bypass workspace confinement', async t => {
  const { a, b, invoke } = await fixture(t);
  await writeFile(join(b, 'private.txt'), 'outside');
  await symlink(b, join(a, 'redirect'), 'junction');
  await assert.rejects(invoke('read_file', { path: 'redirect/private.txt' }));
  await assert.rejects(invoke('create_file', { path: 'redirect/new.txt', content: 'bad' }));
  assert.deepEqual(await readdir(b), ['private.txt']);
});

test('file deletion is recoverable and directory listing excludes secrets and metadata', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'remove.txt'), 'recoverable');
  await writeFile(join(a, '.env'), 'fake-key');
  const result = JSON.parse(await invoke('delete_file', { path: 'remove.txt' }));
  assert.equal(await readFile(join(a, result.recovery_path), 'utf8'), 'recoverable');
  await assert.rejects(readFile(join(a, 'remove.txt')));
  const listing = await invoke('list_dir', {});
  assert.equal(listing.includes('.env'), false);
  assert.equal(listing.includes('.openagent'), false);
});

test('create_file creates missing parent folders, under the same guards as the file itself', async t => {
  const { a, b, invoke } = await fixture(t);
  assert.equal(await invoke('create_file', { path: 'src/components/Header.tsx', content: 'export {}' }), `Créé : ${join('src', 'components', 'Header.tsx')}`);
  assert.equal(await readFile(join(a, 'src', 'components', 'Header.tsx'), 'utf8'), 'export {}');
  await symlink(b, join(a, 'redirect'), 'junction');
  await assert.rejects(invoke('create_file', { path: 'redirect/deep/new.txt', content: 'bad' }), /Lien ou jonction refusé/);
  assert.deepEqual(await readdir(b), [], 'nothing created through the junction');
  await assert.rejects(invoke('create_file', { path: 'node_modules/pkg/index.js', content: 'bad' }), /ignoré ou protégé/);
  await assert.rejects(invoke('create_file', { path: 'dist/sub/out.js', content: 'bad' }), /ignoré ou protégé/);
  assert.deepEqual((await readdir(a)).sort(), ['redirect', 'src'], 'no ignored folder was created');
});

test('create_dir is recursive and accepts a folder that already exists', async t => {
  const { a, invoke } = await fixture(t);
  assert.equal(await invoke('create_dir', { path: 'x/y/z' }), `Créé : ${join('x', 'y', 'z')}`);
  assert.ok((await stat(join(a, 'x', 'y', 'z'))).isDirectory());
  assert.equal(await invoke('create_dir', { path: 'x/y' }), `Existe déjà : ${join('x', 'y')}`);
  await writeFile(join(a, 'plain.txt'), 'f');
  await assert.rejects(invoke('create_dir', { path: 'plain.txt/sub' }), /fichier, un lien ou une jonction/);
});

test('create_file never overwrites, and says what to do instead', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'api.ts'), 'old');
  await assert.rejects(invoke('create_file', { path: 'api.ts', content: 'new' }), { message: 'le fichier existe : utilise edit_file, ou delete_file puis create_file' });
  assert.equal(await readFile(join(a, 'api.ts'), 'utf8'), 'old');
});

test('read_file says which lines it shows and where to resume when it does not show the whole file', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'long.txt'), Array.from({ length: 2500 }, (_, i) => `ligne ${i + 1}`).join('\n'));
  const first = (await invoke('read_file', { path: 'long.txt' })).split('\n');
  assert.equal(first[0], '[Lignes 1–1000 sur 2500]');
  assert.equal(first[1], '1|ligne 1');
  assert.equal(first.at(-2), '1000|ligne 1000');
  assert.equal(first.at(-1), '[Tronqué : relis avec offset=1001]');
  const end = (await invoke('read_file', { path: 'long.txt', offset: 2001 })).split('\n');
  assert.equal(end[0], '[Lignes 2001–2500 sur 2500]');
  assert.equal(end.at(-1), '2500|ligne 2500', 'nothing left after it: no resume marker');
  assert.equal(await invoke('read_file', { path: 'long.txt', offset: 3000 }), '[Le fichier a 2500 lignes : rien à partir de la ligne 3000]');
  await writeFile(join(a, 'wide.txt'), Array.from({ length: 1000 }, () => 'x'.repeat(99)).join('\n'));
  const wide = await invoke('read_file', { path: 'wide.txt' });
  assert.ok(wide.length <= 50000, `header and marker fit in the 50 000 characters (${wide.length})`);
  const shown = /^\[Lignes 1–(\d+) sur 1000\]/.exec(wide);
  assert.ok(shown, wide.slice(0, 60));
  assert.ok(wide.endsWith(`[Tronqué : relis avec offset=${Number(shown[1]) + 1}]`), 'the character limit is reported too');
  await writeFile(join(a, 'short.txt'), 'un\ndeux\ntrois');
  assert.equal(await invoke('read_file', { path: 'short.txt' }), '1|un\n2|deux\n3|trois', 'a file shown whole is unchanged');
});

test('read_file never points back at the line it cut: the resume offset always moves forward, and a cut line is announced', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'over.txt'), ['court', 'y'.repeat(60000), 'fin'].join('\n'));
  const second = await invoke('read_file', { path: 'over.txt', offset: 2 });
  assert.ok(second.length <= 50000, `the over-long line is shown cut, inside the limit (${second.length})`);
  assert.ok(second.startsWith('[Lignes 2–2 sur 3]\n2|yyyy'), second.slice(0, 40));
  const rows = second.split('\n');
  const shownChars = rows[1].length - '2|'.length;
  assert.ok(shownChars > 0 && shownChars < 60000, String(shownChars));
  assert.equal(rows.at(-2), `[Ligne 2 coupée : ${shownChars} caractères affichés sur 60000 ; la suite de cette ligne n'est pas lisible avec read_file]`, 'the note comes just before the marker');
  assert.equal(rows.at(-1), '[Tronqué : relis avec offset=3]', 'moves past the cut line instead of looping on it');
  assert.equal(second.includes('grep_file'), false);
  const whole = await invoke('read_file', { path: 'over.txt' });
  assert.ok(whole.startsWith('[Lignes 1–1 sur 3]\n1|court\n[Tronqué'), whole.slice(0, 60));
  assert.ok(whole.endsWith('[Tronqué : relis avec offset=2]'), 'the line that did not fit at all is the next one to read');
  assert.equal(whole.includes('coupée'), false, 'a line that is not shown at all is not announced as cut');
  assert.ok(whole.length < 200, 'the over-long line is not shown when it is not the first');
  for (const [out, requested] of [[second, 2], [whole, 1]] as const) {
    assert.ok(Number(/offset=(\d+)\]$/.exec(out)![1]) > requested, 'the marker always moves forward');
  }
});

test('read_file: an over-long last line gets the note and no marker, since nothing follows it', async t => {
  const { a, invoke } = await fixture(t);
  await writeFile(join(a, 'tail.txt'), ['court', 'z'.repeat(60000)].join('\n'));
  const out = await invoke('read_file', { path: 'tail.txt', offset: 2 });
  const rows = out.split('\n');
  assert.equal(rows[0], '[Lignes 2–2 sur 2]');
  assert.match(rows.at(-1)!, /^\[Ligne 2 coupée : \d+ caractères affichés sur 60000 ; la suite de cette ligne n'est pas lisible avec read_file\]$/);
  assert.equal(out.includes('Tronqué'), false, 'no line after it: no resume marker');
  assert.ok(out.length <= 50000, String(out.length));
});

test('a final newline does not make a phantom last line, in read_file and view_file', async t => {
  const { a, invoke } = await fixture(t);
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n') + '\n';
  await writeFile(join(a, 'k1000.txt'), rows(1000));
  const whole = await invoke('read_file', { path: 'k1000.txt' });
  assert.ok(whole.startsWith('1|l1\n') && whole.endsWith('\n1000|l1000'), 'read whole: no header, no marker');
  assert.equal(whole.includes('Tronqué') || whole.includes('[Lignes'), false);
  await writeFile(join(a, 'k1001.txt'), rows(1001));
  const part = (await invoke('read_file', { path: 'k1001.txt' })).split('\n');
  assert.equal(part[0], '[Lignes 1–1000 sur 1001]');
  assert.equal(part.at(-1), '[Tronqué : relis avec offset=1001]');
  assert.equal(JSON.parse(await invoke('view_file', { path: 'k1000.txt' })).lines, 1000);
  await writeFile(join(a, 'one.txt'), 'seul');
  assert.equal(JSON.parse(await invoke('view_file', { path: 'one.txt' })).lines, 1);
  await writeFile(join(a, 'empty.txt'), '');
  assert.equal(await invoke('read_file', { path: 'empty.txt' }), '1|', 'an empty file keeps its single empty line, as before');
});

test('read_file, view_file, grep_file and edit_file refuse key material by name (core/file-filter.mts), content never returned nor changed; list_dir still names it', async t => {
  const { a, invoke } = await fixture(t);
  await mkdir(join(a, 'conf'));
  const secrets: Record<string, string> = {
    'secrets.json': '{"api_key": "SECRET-WS-1"}', 'conf/credentials.json': '{"token": "SECRET-WS-2"}',
    'id_rsa': 'SECRET-WS-3', 'cert.PEM': 'SECRET-WS-4', 'conf/server.key': 'SECRET-WS-5',
  };
  for (const [path, content] of Object.entries(secrets)) await writeFile(join(a, path), content);
  for (const [path, content] of Object.entries(secrets)) {
    for (const [name, args] of [['read_file', { path }], ['view_file', { path }], ['grep_file', { path, pattern: 'SECRET' }],
      ['edit_file', { path, old_string: 'SECRET', new_string: 'LEAKED' }]] as const) {
      await assert.rejects(invoke(name, args), (error: Error) => {
        assert.match(error.message, /^Fichier secret/, `${name} ${path}`);
        assert.equal(error.message.includes('SECRET-WS'), false, `${name} ${path}`);
        return true;
      });
    }
    assert.equal(await readFile(join(a, path), 'utf8'), content, `${path} is unchanged`);
  }
  // Only key material by name: a source file whose name merely resembles one is read as before.
  await writeFile(join(a, 'secrets.ts'), 'export const x = 1;');
  assert.equal(await invoke('read_file', { path: 'secrets.ts' }), '1|export const x = 1;');
  assert.match(await invoke('list_dir', {}), /^secrets\.json$/m, 'list_dir is unchanged: the name stays listed');
});

/** Windows' 8.3 short name of an existing file (cmd's %~sI), or null when the volume gives it none. */
function shortName(path: string): string | null {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const name = result.status === 0 ? basename(result.stdout.trim()) : '';
  return name && name !== basename(path) ? name : null;
}

test('the content tools check the name on disk, not only the typed one: an 8.3 short name never reaches a secret or protected file', async t => {
  const { a, invoke } = await fixture(t);
  const files: Record<string, string> = { 'secrets.json': '{"api_key": "SECRET-SHORT-1"}', '.env': 'TOKEN=SECRET-SHORT-2' };
  for (const [name, content] of Object.entries(files)) await writeFile(join(a, name), content);
  const aliases = Object.keys(files).map(name => [name, shortName(join(a, name))] as const);
  if (aliases.some(([, alias]) => !alias)) { t.skip('no 8.3 short names on this volume'); return; }
  for (const [name, alias] of aliases) {
    for (const [tool, args] of [['read_file', { path: alias! }], ['view_file', { path: alias! }], ['grep_file', { path: alias!, pattern: 'SECRET' }],
      ['edit_file', { path: alias!, old_string: 'SECRET', new_string: 'LEAKED' }]] as const) {
      await assert.rejects(invoke(tool, args), (error: Error) => {
        assert.match(error.message, /^(Fichier secret|Fichier ignoré ou protégé)/, `${tool} ${alias} (${name})`);
        assert.equal(error.message.includes('SECRET-SHORT'), false, `${tool} ${alias}`);
        return true;
      });
    }
    assert.equal(await readFile(join(a, name), 'utf8'), files[name], `${name} is unchanged`);
  }
});

test("the content tools match the project's ignored patterns against the on-disk case: PRIVATE/notes.md is private/notes.md", async t => {
  const { a } = await fixture(t);
  await mkdir(join(a, 'private'));
  await writeFile(join(a, 'private', 'notes.md'), 'SECRET-CASE');
  const { workspaceTools } = await import('../core/workspace.mts');
  const tools = await workspaceTools(a, 'private/**');
  const read = tools.find(tool => tool.name === 'read_file')!;
  await assert.rejects(read.execute({ path: 'private/notes.md' }, new AbortController().signal), /Fichier ignoré ou protégé/);
  await assert.rejects(read.execute({ path: 'PRIVATE/notes.md' }, new AbortController().signal), (error: Error) => {
    assert.match(error.message, /^Fichier ignoré ou protégé/);
    return true;
  });
});
