// The turn log (core/turn-log.mts): the day file, the three levels, redaction before truncation, sensitive files,
// retention, never throwing, the suspension after a migration, the MCP secrets, and the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, link, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeAtEnd } from './teardown.mts';
import {
  TurnLog, turnLogDir, turnLogFile, pruneTurnLogs, mcpSecretValues, MASK, SENSITIVE_FILE_MASK, TURN_LOG_LEVELS,
  type TurnLogEvent, type TurnLogLevel,
} from '../core/turn-log.mts';
import { isSensitiveFile, protectedPathMatcher } from '../core/file-filter.mts';
import { SettingsService } from '../core/settings.mts';
import type { McpServerConfig } from '../core/mcp-config.mts';

async function home(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'openagent-turn-log-'));
  removeAtEnd(t, dir);
  return dir;
}

const NOW = new Date(2026, 9, 21, 23, 59);
const begin = (log: TurnLog, level: TurnLogLevel, extra: { secrets?: string[]; isProtected?: (p: string) => boolean } = {}) =>
  log.begin({ runId: 'r1', folder: 'C:/p', level, secrets: extra.secrets ?? [], isProtected: extra.isProtected ?? (() => false) });

async function lines(dataHome: string): Promise<any[]> {
  const raw = await readFile(turnLogFile(dataHome, NOW), 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const timing = { totalMs: 12 };

test('1. one JSON line per event in logs/turns/<local day>.jsonl, with at, runId and folder', async t => {
  const dataHome = await home(t);
  const log = new TurnLog(dataHome, () => NOW);
  assert.equal(turnLogFile(dataHome, NOW), join(dataHome, 'logs', 'turns', '2026-10-21.jsonl'));
  const logger = begin(log, 'full');
  logger.write({ event: 'turn-start', model: 'm', text: 'bonjour', attachments: 0 });
  logger.write({ event: 'end', kind: 'done', timing });
  await logger.flush();
  const raw = await readFile(join(dataHome, 'logs', 'turns', '2026-10-21.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'));
  const parsed = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { at: NOW.toISOString(), runId: 'r1', folder: 'C:/p', event: 'turn-start', model: 'm', text: 'bonjour', attachments: 0 });
  assert.equal(parsed[1].event, 'end');
  assert.deepEqual(parsed[1].timing, timing);
});

test('2. metadata drops text, reasoning, arguments and result; off writes nothing at all', async t => {
  const dataHome = await home(t);
  const logger = begin(new TurnLog(dataHome, () => NOW), 'metadata');
  logger.write({ event: 'reply', step: 0, reasoning: 'je pense', text: 'réponse', toolCalls: 1 });
  logger.write({ event: 'tool', tool: 'read_file', arguments: { path: 'a.txt' }, durationMs: 7, ok: true, result: 'contenu' });
  await logger.flush();
  const [reply, tool] = await lines(dataHome);
  assert.equal(Object.hasOwn(reply, 'text'), false);
  assert.equal(Object.hasOwn(reply, 'reasoning'), false);
  assert.equal(reply.toolCalls, 1);
  assert.equal(Object.hasOwn(tool, 'arguments'), false);
  assert.equal(Object.hasOwn(tool, 'result'), false);
  assert.equal(tool.durationMs, 7);
  assert.equal(tool.tool, 'read_file');

  const offHome = await home(t);
  const off = begin(new TurnLog(offHome, () => NOW), 'off');
  off.write({ event: 'turn-start', model: null, text: 'x', attachments: 0 });
  off.write({ event: 'end', kind: 'done', timing });
  await off.flush();
  assert.equal(existsSync(turnLogDir(offHome)), false);
  assert.equal(existsSync(join(offHome, 'logs')), false);
});

test('3. full truncates every string field at 20 000 characters, and a token across the cut is masked first', async t => {
  const dataHome = await home(t);
  const logger = begin(new TurnLog(dataHome, () => NOW), 'full');
  // The token straddles the cut (it starts at 19 990). A token class eats letters and digits, so the tail that keeps
  // the masked text over the limit starts with a space.
  const text = 'a'.repeat(19_990) + 'ghp_' + 'x'.repeat(36) + ' ' + 'b'.repeat(100);
  logger.write({ event: 'reply', step: 0, text, toolCalls: 0 });
  logger.write({ event: 'tool', tool: 'read_file', arguments: { path: 'big.txt' }, ok: true, result: 'r'.repeat(25_000) });
  await logger.flush();
  const [reply, tool] = await lines(dataHome);
  assert.ok(reply.text.startsWith('a'.repeat(19_990) + MASK), reply.text.slice(19_980, 20_010));
  assert.ok(reply.text.endsWith('caractères de plus]'), reply.text.slice(-60));
  assert.ok(!reply.text.includes('ghp_'));
  assert.ok(!reply.text.includes('xxxxxxxxxx'));
  assert.equal(tool.result, 'r'.repeat(20_000) + '…[tronqué : 5000 caractères de plus]');
});

test('4. no injected token survives, at any level, anywhere in the event', async t => {
  const fakes = [
    'hf_' + 'A1'.repeat(17), 'ghp_' + 'b2'.repeat(18), 'github_pat_' + 'C3_'.repeat(10), 'sk-proj-' + 'd4'.repeat(12),
    'xoxb-' + '1234567890-abc', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'Bearer ' + 'e5'.repeat(15), 'monSecretHF-777', 'valeur-env-mcp-42',
  ];
  const secrets = ['monSecretHF-777', 'valeur-env-mcp-42'];
  for (const level of ['full', 'metadata'] as const) {
    const dataHome = await home(t);
    const logger = begin(new TurnLog(dataHome, () => NOW), level, { secrets });
    for (const fake of fakes) {
      const inText = `voici ${fake} fin`;
      logger.write({ event: 'turn-start', model: 'm', text: inText, attachments: 0 });
      logger.write({ event: 'reply', step: 0, reasoning: inText, text: fake, toolCalls: 0 });
      logger.write({ event: 'tool', tool: 'run_command', arguments: { command: 'echo', nested: { list: [inText], value: fake } }, durationMs: 1, ok: true, result: inText });
      logger.write({ event: 'end', kind: 'error', timing, message: `Erreur : ${inText}` });
    }
    await logger.flush();
    const raw = await readFile(turnLogFile(dataHome, NOW), 'utf8');
    for (const fake of fakes) assert.ok(!raw.includes(fake), `${level}: ${fake} reached the log`);
    // The bare credentials too, not only their prefixed form.
    for (const part of ['A1'.repeat(17), 'b2'.repeat(18), 'd4'.repeat(12), 'e5'.repeat(15)]) assert.ok(!raw.includes(part), `${level}: ${part}`);
    assert.ok(raw.includes(MASK), level);
  }
});

test('5. a file tool on a sensitive or protected path keeps the path and masks the arguments and the result', async t => {
  const dataHome = await home(t);
  const isProtected = (p: string) => isSensitiveFile(p) || protectedPathMatcher('private/**')(p);
  const logger = begin(new TurnLog(dataHome, () => NOW), 'full', { isProtected });
  const paths = ['secrets.json', 'cle.pem', '.env.local', 'private/notes.md', 'src/app.ts'];
  for (const path of paths) {
    logger.write({ event: 'tool', tool: 'edit_file', arguments: { path, old: 'a', new: 'contenu secret' }, durationMs: 2, ok: true, result: `contenu de ${path}` });
  }
  await logger.flush();
  const tools = await lines(dataHome);
  for (const [i, path] of paths.slice(0, 4).entries()) {
    assert.equal(tools[i].result, SENSITIVE_FILE_MASK, path);
    assert.deepEqual(tools[i].arguments, { path }, path);
  }
  assert.equal(tools[4].result, 'contenu de src/app.ts');
  assert.deepEqual(tools[4].arguments, { path: 'src/app.ts', old: 'a', new: 'contenu secret' });
});

test('5b. the git tools name files with file and files: a protected one is masked the same way', async t => {
  const dataHome = await home(t);
  const isProtected = (p: string) => isSensitiveFile(p) || protectedPathMatcher('')(p);
  const logger = begin(new TurnLog(dataHome, () => NOW), 'full', { isProtected });
  logger.write({ event: 'tool', tool: 'git_blame', arguments: { file: '.env' }, ok: true, result: 'TOKEN=abc' });
  logger.write({ event: 'tool', tool: 'git_add', arguments: { files: 'src/a.ts "cle privee.pem"' }, ok: true, result: 'diff de la clé' });
  logger.write({ event: 'tool', tool: 'git_diff', arguments: { file: 'src/a.ts' }, ok: true, result: 'diff ordinaire' });
  await logger.flush();
  const [blame, add, diff] = await lines(dataHome);
  assert.deepEqual([blame.arguments, blame.result], [{ file: '.env' }, SENSITIVE_FILE_MASK]);
  assert.deepEqual([add.arguments, add.result], [{ files: 'src/a.ts "cle privee.pem"' }, SENSITIVE_FILE_MASK]);
  assert.equal(diff.result, 'diff ordinaire');
});

test('6. pruneTurnLogs removes day files older than 14 days and nothing else', async t => {
  const dataHome = await home(t);
  assert.deepEqual(await pruneTurnLogs(dataHome, NOW), [], 'a missing logs/turns removes nothing');
  const dir = turnLogDir(dataHome);
  await mkdir(dir, { recursive: true });
  const names = ['2026-10-06.jsonl', '2026-10-07.jsonl', '2026-10-21.jsonl', 'notes.txt', '2026-10-01.json'];
  for (const name of names) await writeFile(join(dir, name), '{}\n');
  await mkdir(join(dir, '2026-01-01.jsonl'));
  const removed = await pruneTurnLogs(dataHome, NOW);
  assert.deepEqual(removed, ['2026-10-06.jsonl']);
  assert.deepEqual((await readdir(dir)).sort(), ['2026-01-01.jsonl', '2026-10-01.json', '2026-10-07.jsonl', '2026-10-21.jsonl', 'notes.txt']);
});

test('7. a write never throws; after suspend() nothing is written', async t => {
  const dataHome = await home(t);
  await mkdir(join(dataHome, 'logs'));
  await writeFile(turnLogDir(dataHome), 'pas un dossier');
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const logger = begin(new TurnLog(dataHome, () => NOW), 'full');
    logger.write({ event: 'turn-start', model: null, text: 'x', attachments: 0 });
    logger.write({ event: 'end', kind: 'done', timing });
    await logger.flush();
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(String(errors[0]), /^\[turn-log\] /);

  const fresh = await home(t);
  const log = new TurnLog(fresh, () => NOW);
  const existing = begin(log, 'full');
  log.suspend();
  existing.write({ event: 'turn-start', model: null, text: 'x', attachments: 0 });
  const created = begin(log, 'full');
  created.write({ event: 'end', kind: 'done', timing });
  await Promise.all([existing.flush(), created.flush()]);
  assert.deepEqual(await readdir(fresh), []);
});

test('8. mcpSecretValues: env and headers values, raw and expanded, at least 6 characters', () => {
  const servers: McpServerConfig[] = [
    { id: 'a', scope: 'project', command: 'x', args: ['--key=${OA_TEST_ARG}'], env: { K: 'secret-env-1', S: '${OA_TEST_TOKEN}', T: 'short' } },
    { id: 'b', scope: 'global', type: 'http', url: 'http://127.0.0.1:1', headers: { Authorization: 'Bearer abcdefghij' } },
  ];
  const values = mcpSecretValues(servers, { OA_TEST_TOKEN: 'expanded-777', OA_TEST_ARG: 'arg-secret-55' });
  for (const expected of ['secret-env-1', '${OA_TEST_TOKEN}', 'expanded-777', 'Bearer abcdefghij', 'abcdefghij', 'arg-secret-55']) {
    assert.ok(values.includes(expected), `${expected} missing from ${JSON.stringify(values)}`);
  }
  assert.ok(!values.includes('short'));
  assert.ok(!values.includes('http://127.0.0.1:1'), 'a url without placeholder is not a secret');
  assert.equal(new Set(values).size, values.length);
});

test('9. turn_log setting: full by default, the three values accepted, anything else refused', async t => {
  const dataHome = await home(t);
  const settings = new SettingsService(dataHome);
  assert.equal((await settings.publicGlobal()).turn_log, 'full');
  for (const level of TURN_LOG_LEVELS) {
    await settings.saveGlobal({ turn_log: level });
    assert.equal((await settings.publicGlobal()).turn_log, level);
  }
  for (const bad of ['FULL', 'none', null]) {
    await assert.rejects(settings.saveGlobal({ turn_log: bad }), { message: 'Paramètre invalide : turn_log' });
  }
});

test('10. a token or an exact secret in an object KEY is masked too, at full and at metadata', async t => {
  const ghp = 'ghp_' + 'k'.repeat(36);
  const exact = 'cle-exacte-9090';
  for (const level of ['full', 'metadata'] as const) {
    const dataHome = await home(t);
    const logger = begin(new TurnLog(dataHome, () => NOW), level, { secrets: [exact] });
    logger.write({ event: 'tool', tool: 'run_command', arguments: { [ghp]: 1, nested: { [`x ${exact} y`]: 'v' } }, ok: true, result: 'r' });
    logger.write({ event: 'model-ready', backend: 'cpu', contextSize: 16384, wrapper: 'w', segments: { [ghp]: { [exact]: 'p' } } });
    await logger.flush();
    const raw = await readFile(turnLogFile(dataHome, NOW), 'utf8');
    assert.ok(!raw.includes(ghp) && !raw.includes('k'.repeat(36)), `${level}: the token key reached the log`);
    assert.ok(!raw.includes(exact), `${level}: the exact-secret key reached the log`);
    const [, ready] = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(ready.segments, { [MASK]: { [MASK]: 'p' } }, level);
  }
});

test('5c. other path keys, array values and array-shaped arguments are checked too', async t => {
  const dataHome = await home(t);
  const isProtected = (p: string) => isSensitiveFile(p) || protectedPathMatcher('')(p);
  const logger = begin(new TurnLog(dataHome, () => NOW), 'full', { isProtected });
  const cases: unknown[] = [
    { file_path: '.env', content: 'A=1' },
    { filePath: 'cle.pem' },
    { paths: ['src/a.ts', 'secrets.json'] },
    { path: ['.env'] },
    ['.env.local'],
    [{ path: 'id_rsa' }],
  ];
  for (const args of cases) logger.write({ event: 'tool', tool: 'read_file', arguments: args, ok: true, result: 'CONTENU-SECRET' });
  logger.write({ event: 'tool', tool: 'read_file', arguments: { paths: ['src/a.ts'] }, ok: true, result: 'ordinaire' });
  await logger.flush();
  const tools = await lines(dataHome);
  for (const [i, args] of cases.entries()) assert.equal(tools[i].result, SENSITIVE_FILE_MASK, JSON.stringify(args));
  assert.deepEqual(tools[0].arguments, { file_path: '.env' });
  assert.deepEqual(tools[2].arguments, { paths: ['src/a.ts', 'secrets.json'] });
  assert.deepEqual(tools[4].arguments, ['.env.local']);
  assert.deepEqual(tools[5].arguments, [{ path: 'id_rsa' }]);
  assert.ok(!(await readFile(turnLogFile(dataHome, NOW), 'utf8')).includes('CONTENU-SECRET'));
  assert.equal(tools[6].result, 'ordinaire');
});

test('13. a secret equal to or inside a content field name never keeps that content at metadata', async t => {
  for (const secret of ['result', 'tex', 'reasoning', 'arguments']) {
    const dataHome = await home(t);
    const logger = begin(new TurnLog(dataHome, () => NOW), 'metadata', { secrets: [secret] });
    logger.write({ event: 'reply', step: 0, reasoning: 'PENSEE-PRIVEE', text: 'TEXTE-PRIVE', toolCalls: 0 });
    logger.write({ event: 'tool', tool: 'run_command', arguments: { command: 'ARGUMENT-PRIVE' }, durationMs: 1, ok: true, result: 'RESULTAT-PRIVE' });
    await logger.flush();
    const raw = await readFile(turnLogFile(dataHome, NOW), 'utf8');
    for (const content of ['PENSEE-PRIVEE', 'TEXTE-PRIVE', 'ARGUMENT-PRIVE', 'RESULTAT-PRIVE']) {
      assert.ok(!raw.includes(content), `secret « ${secret} »: ${content} survived at metadata`);
    }
    const [reply, tool] = raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(reply.event, 'reply', 'the schema keys stay as written');
    assert.equal(tool.tool, 'run_command');
    assert.equal(tool.durationMs, 1);
  }
});

/** Runs `fn` with console.error captured; returns what it printed. */
async function capturingErrors(fn: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try { await fn(); } finally { console.error = original; }
  return errors;
}

test('11. a day file planted as a hard link or a symbolic link is not followed: nothing written, one report', async t => {
  const dataHome = await home(t);
  const outside = await home(t);
  const target = join(outside, 'cible.txt');
  await writeFile(target, 'avant\n');
  await mkdir(turnLogDir(dataHome), { recursive: true });
  await link(target, turnLogFile(dataHome, NOW));
  const errors = await capturingErrors(async () => {
    const logger = begin(new TurnLog(dataHome, () => NOW), 'full');
    logger.write({ event: 'turn-start', model: null, text: 'contenu du tour', attachments: 0 });
    logger.write({ event: 'end', kind: 'done', timing });
    await logger.flush();
  });
  assert.equal(await readFile(target, 'utf8'), 'avant\n', 'the hard link target is untouched');
  assert.equal(errors.length, 1, JSON.stringify(errors));

  const symHome = await home(t);
  await mkdir(turnLogDir(symHome), { recursive: true });
  try { await symlink(target, turnLogFile(symHome, NOW), 'file'); }
  catch (error: any) { if (error?.code === 'EPERM') { t.diagnostic('file symlinks need a privilege here: symlink case skipped'); return; } throw error; }
  const symErrors = await capturingErrors(async () => {
    const logger = begin(new TurnLog(symHome, () => NOW), 'full');
    logger.write({ event: 'turn-start', model: null, text: 'contenu du tour', attachments: 0 });
    await logger.flush();
  });
  assert.equal(await readFile(target, 'utf8'), 'avant\n', 'the symlink target is untouched');
  assert.equal(symErrors.length, 1, JSON.stringify(symErrors));
});

test('12. logs or logs/turns as a junction: the prune deletes nothing behind it and the writer writes nothing there', async t => {
  for (const linked of ['logs', 'turns'] as const) {
    const dataHome = await home(t);
    const outside = await home(t);
    // The junction's target holds an expired day file, a sentinel that must survive.
    const targetTurns = linked === 'logs' ? join(outside, 'turns') : outside;
    await mkdir(targetTurns, { recursive: true });
    const sentinel = join(targetTurns, '2000-01-01.jsonl');
    await writeFile(sentinel, 'sentinelle\n');
    if (linked === 'logs') await symlink(outside, join(dataHome, 'logs'), 'junction');
    else { await mkdir(join(dataHome, 'logs')); await symlink(outside, turnLogDir(dataHome), 'junction'); }
    await assert.rejects(pruneTurnLogs(dataHome, NOW), /pas un vrai dossier/, linked);
    assert.equal(await readFile(sentinel, 'utf8'), 'sentinelle\n', `${linked}: the sentinel survives`);
    const errors = await capturingErrors(async () => {
      const logger = begin(new TurnLog(dataHome, () => NOW), 'full');
      logger.write({ event: 'turn-start', model: null, text: 'contenu du tour', attachments: 0 });
      await logger.flush();
    });
    assert.deepEqual(await readdir(targetTurns), ['2000-01-01.jsonl'], `${linked}: nothing written behind the junction`);
    assert.equal(errors.length, 1, JSON.stringify(errors));
  }
});

// The type is used so an event shape change breaks this file at tsc time.
const _shape: TurnLogEvent = { event: 'phase', phase: 'reading', previous: null, previousMs: null };
void _shape;
