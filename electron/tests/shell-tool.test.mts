import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { shellTools, scrubbedEnv, isServerCommand, shapeOutput, stopAllServers } = await import('../core/shell-tool.mts');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class MissingTool extends Error {}
async function refuses(promise: Promise<unknown>, expected?: RegExp) {
  await assert.rejects(promise, (error: any) => {
    assert.ok(!(error instanceof MissingTool), error.message);
    return expected ? expected.test(String(error.message)) : true;
  });
}

async function fixture(t: any, env: NodeJS.ProcessEnv = process.env) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openagent-shell-')));
  t.after(async () => { await stopAllServers(); await rm(root, { recursive: true, force: true }); });
  const tools = await shellTools(root, { env });
  async function invoke(args: Record<string, unknown>, signal = new AbortController().signal) {
    const tool = tools.find(entry => entry.name === 'run_command');
    if (!tool) throw new MissingTool('Missing run_command');
    tool.validate(args);
    return tool.execute(args, signal);
  }
  return { root, tools, invoke };
}

// ── pure helpers ──────────────────────────────────────────────────────────────────
test('scrubbedEnv removes secrets by name and keeps what a command needs to run', () => {
  const clean = scrubbedEnv({
    PATH: '/bin', SystemRoot: 'C:\\Windows', HOME: '/home/u', SAFE_VAR: 'ok',
    OPENROUTER_API_KEY: 'fake', TAVILY_API_KEY: 'fake', GITHUB_TOKEN: 'fake', HF_TOKEN: 'fake', MY_SECRET: 'fake',
    DB_PASSWORD: 'fake', AWS_ACCESS_KEY_ID: 'fake', AWS_SECRET_ACCESS_KEY: 'fake', STRIPE_KEY: 'fake',
  });
  for (const secret of ['OPENROUTER_API_KEY', 'TAVILY_API_KEY', 'GITHUB_TOKEN', 'HF_TOKEN', 'MY_SECRET', 'DB_PASSWORD', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'STRIPE_KEY']) {
    assert.equal(secret in clean, false, `${secret} must be removed`);
  }
  for (const kept of ['PATH', 'SystemRoot', 'HOME', 'SAFE_VAR']) assert.ok(kept in clean, `${kept} must be kept`);
});

test('isServerCommand only matches a server launcher that starts a command of the chain', () => {
  for (const yes of ['npm run dev', 'cd app && pnpm dev', 'uvicorn main:app --reload', 'streamlit run app.py', 'yarn start', 'FOO=1 npm start', 'flask run', 'npm test && npm run dev']) {
    assert.equal(isServerCommand(yes), true, yes);
  }
  for (const no of ['echo npm start', 'git commit -m "fix uvicorn"', 'npm run devtools', 'npm install', 'grep -r "pnpm dev" .', 'ls']) {
    assert.equal(isServerCommand(no), false, no);
  }
});

test('shapeOutput: empty output, and progress noise collapsed like the Python tool', () => {
  assert.equal(shapeOutput('  \n '), '(no output)');
  const noisy = ['start', ...Array.from({ length: 5 }, (_, i) => `Progress: resolved ${i}, reused 0`), 'end'].join('\n');
  assert.equal(shapeOutput(noisy), 'start\n  ... (5 lines collapsed: install/listing progress) ...\nend');
  const two = ['a', 'Progress: resolved 1', 'Progress: resolved 2', 'b'].join('\n');
  assert.equal(shapeOutput(two), 'a\nProgress: resolved 2\nb', 'a run of 1-2 noise lines keeps only the last one');
});

test('shapeOutput keeps the head and tail of long output, and hard-caps very long lines', () => {
  // 200 lines of about 30 characters: past the 3000-character threshold, so head/tail applies.
  const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  assert.ok(long.length > 3000);
  const shaped = shapeOutput(long);
  const lines = shaped.split('\n');
  assert.equal(lines.length, 26);
  assert.ok(lines[0].startsWith('line 0 '));
  assert.ok(lines[4].startsWith('line 4 '));
  assert.equal(lines[5], '... (175 lines omitted) ...');
  assert.ok(lines.at(-1)!.startsWith('line 199 '));
  assert.equal(shapeOutput(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')).split('\n').length, 200, 'output under the threshold is left whole');
  const oneLine = shapeOutput('x'.repeat(5000));
  assert.ok(oneLine.startsWith('x'.repeat(3000)));
  assert.match(oneLine, /truncated at 3000 chars/);
  assert.ok(oneLine.length < 3100);
});

test('shapeOutput replaces big HTML or JSON blobs with their first line and a size note', () => {
  const html = '<!DOCTYPE html>\n' + '<p>x</p>\n'.repeat(400);
  assert.match(shapeOutput(html), /^<!DOCTYPE html>\n\.\.\. \(HTML\/JSON response truncated — \d+ chars total\) \.\.\.\nTip: use `curl/);
  const json = '{"a":"' + 'x'.repeat(4000) + '"}';
  assert.match(shapeOutput(json), /HTML\/JSON response truncated/);
  assert.equal(shapeOutput('{"short":true}'), '{"short":true}', 'small JSON is left alone');
});

// ── run_command ───────────────────────────────────────────────────────────────────
test('run_command runs in the real project root', async t => {
  const { root, invoke } = await fixture(t);
  const out = await invoke({ command: 'node -e "console.log(process.cwd())"' });
  assert.equal(out.toLowerCase(), root.toLowerCase());
});

test('run_command returns stdout, a [stderr] section and the exit code', async t => {
  const { invoke } = await fixture(t);
  const out = await invoke({ command: `node -e "console.log('out');console.error('err');process.exit(3)"` });
  assert.equal(out, 'out\n[stderr]\nerr\n[exit code: 3]');
  assert.equal(await invoke({ command: 'node -e "0"' }), '(no output)');
});

test('run_command says when cd was used that the working directory never changes', async t => {
  const { root, invoke } = await fixture(t);
  await mkdir(join(root, 'sub'));
  const out = await invoke({ command: 'cd sub && node -e "console.log(process.cwd().split(/[\\\\/]/).pop())"' });
  assert.equal(out, `sub\n[cwd: ${root}]`);
});

test('run_command decodes non-ASCII output from the Windows shell as UTF-8', { skip: process.platform !== 'win32' }, async t => {
  const { invoke } = await fixture(t);
  assert.equal(await invoke({ command: 'echo é' }), 'é');
});

test('run_command never hands the app secrets to the command it runs', async t => {
  const env = { ...process.env, OPENROUTER_API_KEY: 'fake-key', GITHUB_TOKEN: 'fake-token', MY_SECRET: 'fake-secret', SAFE_VAR: 'visible' };
  const { invoke } = await fixture(t, env);
  const out = await invoke({ command: `node -e "const e = process.env; console.log(JSON.stringify({ k: e.OPENROUTER_API_KEY ?? null, t: e.GITHUB_TOKEN ?? null, s: e.MY_SECRET ?? null, ok: e.SAFE_VAR ?? null, hasPath: !!(e.PATH || e.Path) }))"` });
  assert.deepEqual(JSON.parse(out), { k: null, t: null, s: null, ok: 'visible', hasPath: true });
});

test('run_command validates its arguments', async t => {
  const { invoke } = await fixture(t);
  await refuses(invoke({ command: '   ' }), /vide/i);
  await refuses(invoke({ command: 'node -e "0"', timeout: 0 }), /nombre/i);
  await refuses(invoke({ command: 'node -e "0"', timeout: 601 }), /nombre/i);
  await refuses(invoke({}), /requis/i);
});

const GRANDCHILD = `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(process.env.MARKER, 'alive'), 3500)"], { stdio: 'ignore' });
  setTimeout(() => {}, 60000);
`;

test('a command that exceeds its timeout is killed with everything it started', async t => {
  const marker = join(tmpdir(), `openagent-marker-${Date.now()}-a.txt`);
  const { root, invoke } = await fixture(t, { ...process.env, MARKER: marker });
  t.after(() => rm(marker, { force: true }));
  await writeFile(join(root, 'grand.js'), GRANDCHILD);
  const started = Date.now();
  const out = await invoke({ command: 'node grand.js', timeout: 1 });
  assert.match(out, /^Command timed out after 1s\./);
  assert.ok(Date.now() - started < 6000, 'returned promptly');
  await sleep(4000);
  await assert.rejects(stat(marker), 'the grandchild was killed, so it never wrote its marker');
});

test('Stop (abort) kills the running command and everything it started', async t => {
  const marker = join(tmpdir(), `openagent-marker-${Date.now()}-b.txt`);
  const { root, invoke } = await fixture(t, { ...process.env, MARKER: marker });
  t.after(() => rm(marker, { force: true }));
  await writeFile(join(root, 'grand.js'), GRANDCHILD);
  const controller = new AbortController();
  const running = invoke({ command: 'node grand.js', timeout: 60 }, controller.signal);
  await sleep(600);
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  await sleep(4000);
  await assert.rejects(stat(marker), 'aborting really stopped the process tree');
});

// ── background servers ────────────────────────────────────────────────────────────
async function devProject(root: string, script: string) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: script } }));
  await writeFile(join(root, 'srv.js'), `const fs = require('node:fs'); console.log('listening'); setInterval(() => fs.appendFileSync('beat.txt', 'x'), 150);`);
}

test('a dev server is started in the background, not duplicated, and stopped with its whole tree', async t => {
  const { root, invoke } = await fixture(t);
  await devProject(root, 'node srv.js');
  const first = await invoke({ command: 'npm run dev' });
  const pid = /pid=(\d+)/.exec(first)?.[1];
  assert.match(first, /^Server started in background \(pid=\d+\): `npm run dev`/);
  assert.match(first, /listening/, 'the first seconds of output reach the model');
  assert.equal(await invoke({ command: 'npm run dev' }), `Server is already running (pid=${pid}): \`npm run dev\``);
  await sleep(500);
  const beats = (await readFile(join(root, 'beat.txt'), 'utf8')).length;
  assert.ok(beats > 0, 'the server is really running');
  await stopAllServers();
  await sleep(600);
  const after = (await readFile(join(root, 'beat.txt'), 'utf8')).length;
  await sleep(900);
  assert.equal((await readFile(join(root, 'beat.txt'), 'utf8')).length, after, 'no process of the tree is still writing');
});

test('a server that dies at startup is reported with its output instead of a false success', async t => {
  const { root, invoke } = await fixture(t);
  await devProject(root, `node -e "console.error('boom');process.exit(2)"`);
  const out = await invoke({ command: 'npm run dev' });
  assert.match(out, /Server exited immediately \(exit code 2\)/);
  assert.match(out, /boom/);
});

test('a command that merely mentions a server keyword is run normally and returns its output', async t => {
  const { invoke } = await fixture(t);
  assert.equal(await invoke({ command: `node -e "console.log('npm start')"` }), 'npm start');
});

test('a Next.js dev server is refused while the starter page is untouched', async t => {
  const { root, invoke } = await fixture(t);
  await mkdir(join(root, 'web', 'app'), { recursive: true });
  await writeFile(join(root, 'web', 'app', 'page.tsx'), 'export default () => <div>To get started, edit page.tsx</div>');
  const out = await invoke({ command: 'cd web && npm run dev' });
  assert.match(out, /^BLOCKED: .*page\.tsx still has the default Next\.js starter content/);
  await assert.rejects(stat(join(root, 'web', 'beat.txt')), 'nothing was launched');
});
