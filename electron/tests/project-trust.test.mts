import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const { SettingsService } = await import('../core/settings.mts');
  const { ProjectTrustService } = await import('../core/project-trust.mts');
  const settings = new SettingsService(home);
  return { root, home, project, settings, trust: new ProjectTrustService(home, settings), ProjectTrustService };
}
const markerPlugin = (marker: string, name: string) => `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'ran');
export function getTools() { return [{ name: ${JSON.stringify(name)}, description: 'x', properties: {}, execute: async () => 'ok' }]; }
`;
async function addPlugin(project: string, file: string, body: string) {
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(join(project, 'tools', file), body);
}

test('a project bringing nothing sensitive is in state "none"', async t => {
  const { project, trust } = await fixture(t);
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'none');
  assert.equal(result.contentTrusted, false);
  assert.deepEqual(result.inventory, { plugins: [], mcpServers: [], relaxations: {} });
});

test('a project plugin makes the project pending, and evaluating it never runs it', async t => {
  const { root, project, trust } = await fixture(t);
  const marker = join(root, 'ran.txt');
  await addPlugin(project, 'build.mjs', markerPlugin(marker, 'build_tool'));
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.changed, false);
  assert.equal(result.contentTrusted, false);
  assert.deepEqual(result.inventory.plugins, ['tools/build.mjs']);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test('.mcp.json servers are listed as written; an .mcp.json with no valid server is inert', async t => {
  const { project, trust } = await fixture(t);
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { broken: { nothing: true } } }));
  assert.equal((await trust.evaluate(project)).state, 'none');

  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['--token=${SECRET_X}'] } } }));
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.inventory.mcpServers.length, 1);
  assert.deepEqual((result.inventory.mcpServers[0] as any).args, ['--token=${SECRET_X}']);
});

test('trusting with the shown token approves the content; the registry lives in the data home only', async t => {
  const { home, project, trust, settings, ProjectTrustService } = await fixture(t);
  await addPlugin(project, 'build.mjs', 'export {}');
  const shown = await trust.evaluate(project);
  const after = await trust.decide(project, 'trusted', shown.token);
  assert.equal(after.state, 'trusted');
  assert.equal(after.contentTrusted, true);
  assert.equal((await new ProjectTrustService(home, settings).evaluate(project)).state, 'trusted', 'persisted');
  assert.ok((await readdir(home)).includes('trusted-projects.json'));
  await assert.rejects(readFile(join(project, '.openagent', 'trusted-projects.json')), /ENOENT/);
});

test('adding, editing or removing a plugin after approval makes the project pending again', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await addPlugin(project, 'b.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);

  await addPlugin(project, 'a.mjs', 'export const edited = 1;');
  let result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.changed, true);
  assert.equal(result.contentTrusted, false);

  await trust.decide(project, 'trusted', result.token);
  await addPlugin(project, 'c.mjs', 'export {}');
  assert.equal((await trust.evaluate(project)).state, 'pending', 'added');

  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  await rm(join(project, 'tools', 'c.mjs'));
  assert.equal((await trust.evaluate(project)).state, 'pending', 'removed');
});

test('a decision with a stale token is refused', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  const shown = await trust.evaluate(project);
  await addPlugin(project, 'a.mjs', 'export const swapped = 1;');
  await assert.rejects(trust.decide(project, 'trusted', shown.token), /a changé depuis l’affichage/);
  assert.equal((await trust.evaluate(project)).contentTrusted, false);
});

test('"ignored" is remembered for this fingerprint and never trusts the content', async t => {
  const { home, project, trust, settings, ProjectTrustService } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  const after = await trust.decide(project, 'ignored', (await trust.evaluate(project)).token);
  assert.equal(after.state, 'ignored');
  assert.equal(after.contentTrusted, false);
  assert.equal((await new ProjectTrustService(home, settings).evaluate(project)).state, 'ignored');
});

test('a relaxation-only project: pending, then ignored stays ignored, trusted approves the values', async t => {
  const { project, trust, settings } = await fixture(t);
  await settings.saveProject(project, { override_permissions: true, shell_ask: false });
  const shown = await trust.evaluate(project);
  assert.equal(shown.state, 'pending');
  assert.deepEqual(shown.inventory.relaxations, { shell_ask: { project: false, global: true } });

  const ignored = await trust.decide(project, 'ignored', shown.token);
  assert.equal(ignored.state, 'ignored', 'not pending forever');
  assert.deepEqual(ignored.approvedRelaxations, {});

  const trusted = await trust.decide(project, 'trusted', ignored.token);
  assert.equal(trusted.state, 'trusted');
  assert.deepEqual(trusted.approvedRelaxations, { shell_ask: false });
});

test('approveRelaxations approves only the fields given, never what the repository already shipped', async t => {
  const { project, trust, settings } = await fixture(t);
  await settings.saveGlobal({ files_ask: true });
  await settings.saveProject(project, { override_permissions: true, shell_ask: false, files_ask: false });
  await trust.approveRelaxations(project, { files_ask: false, custom_prompt: 'ignored: not relaxable' });
  const result = await trust.evaluate(project);
  assert.deepEqual(result.approvedRelaxations, { files_ask: false });
  assert.equal(result.state, 'pending', 'shell_ask is still waiting for a decision');
});

test('"Ignorer" refuses only what is pending: approved content and relaxations stay approved', async t => {
  const { project, trust, settings } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await settings.saveGlobal({ files_ask: true });
  await settings.saveProject(project, { override_permissions: true, files_ask: false });
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);

  await settings.saveProject(project, { shell_ask: false });
  const pending = await trust.evaluate(project);
  assert.equal(pending.state, 'pending');
  const after = await trust.decide(project, 'ignored', pending.token);
  assert.equal(after.state, 'ignored');
  assert.equal(after.contentTrusted, true, 'the already-trusted plugins stay trusted');
  assert.deepEqual(after.approvedRelaxations, { files_ask: false }, 'the approved relaxation stays approved');
});

test('revoke forgets everything about the project', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  const after = await trust.revoke(project);
  assert.equal(after.state, 'pending');
  assert.equal(after.contentTrusted, false);
});

test('a corrupt registry approves nothing; the next decision keeps it aside and writes a fresh one', async t => {
  const { home, project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await writeFile(join(home, 'trusted-projects.json'), '{ not json');
  const shown = await trust.evaluate(project);
  assert.equal(shown.state, 'pending');
  const after = await trust.decide(project, 'trusted', shown.token);
  assert.equal(after.state, 'trusted');
  const kept = (await readdir(home)).filter(name => name.startsWith('trusted-projects.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(join(home, kept[0]), 'utf8'), '{ not json');
});

test('the registry is keyed by the real path: the same project reached through a junction is the same project', async t => {
  const { root, project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  const link = join(root, 'link');
  await symlink(project, link, 'junction');
  assert.equal((await trust.evaluate(link)).state, 'trusted');
});

test('an .mcp.json that changes or appears after approval makes the project pending again', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['one'] } } }));
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  assert.equal((await trust.evaluate(project)).state, 'trusted');

  await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['two'] } } }));
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.changed, true);
  assert.equal(result.contentTrusted, false);
});

test('an unreadable .mcp.json is never read as absent: the project stays pending, never trusted', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  assert.equal((await trust.evaluate(project)).contentTrusted, true);

  await mkdir(join(project, '.mcp.json')); // readFile -> EISDIR
  const result = await trust.evaluate(project);
  assert.equal(result.contentTrusted, false);
  assert.equal(result.state, 'pending');
  assert.equal(result.unreadable, true, 'the UI can say plainly that the content could not be read');
  assert.equal(result.contentStatus, 'pending');
});

test('a project with .openagent/tools reached through a junction lists the same relative paths and stays trusted', async t => {
  const { root, project, trust } = await fixture(t);
  await mkdir(join(project, '.openagent', 'tools'), { recursive: true });
  await writeFile(join(project, '.openagent', 'tools', 'b.mjs'), 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  const link = join(root, 'link');
  await symlink(project, link, 'junction');
  const result = await trust.evaluate(link);
  assert.equal(result.state, 'trusted');
  assert.deepEqual(result.inventory.plugins, ['.openagent/tools/b.mjs']);
});

test('mixed state A: trusted plugins + a new repo relaxation — each part reports its own truth, before and after "Ignorer"', async t => {
  const { project, trust, settings } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  await settings.saveProject(project, { override_permissions: true, shell_ask: false });

  const pending = await trust.evaluate(project);
  assert.equal(pending.state, 'pending', 'aggregate: something waits for a decision');
  assert.equal(pending.contentStatus, 'trusted', 'the plugins ARE loaded');
  assert.equal(pending.contentTrusted, true);
  assert.deepEqual(pending.relaxationStatus, { shell_ask: 'pending' });
  assert.equal(pending.unreadable, false);
  assert.equal(pending.changed, false, 'the content did not change');

  const ignored = await trust.decide(project, 'ignored', pending.token);
  assert.equal(ignored.state, 'ignored');
  assert.equal(ignored.contentStatus, 'trusted', 'Ignorer never flips trusted content');
  assert.deepEqual(ignored.relaxationStatus, { shell_ask: 'ignored' });
  assert.deepEqual(ignored.approvedRelaxations, {});
});

test('mixed state B: ignored plugins + a "Toujours"-approved relaxation — the relaxation is reported approved and really applies', async t => {
  const { project, trust, settings } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'ignored', (await trust.evaluate(project)).token);
  await settings.saveGlobal({ files_ask: true });
  await settings.saveProject(project, { override_permissions: true, files_ask: false });
  await trust.approveRelaxations(project, { files_ask: false });

  const result = await trust.evaluate(project);
  assert.equal(result.state, 'ignored');
  assert.equal(result.contentStatus, 'ignored');
  assert.equal(result.contentTrusted, false);
  assert.deepEqual(result.relaxationStatus, { files_ask: 'approved' });
  assert.equal((await settings.effective(project, { approvedRelaxations: result.approvedRelaxations })).files_ask, false, 'it IS applied');
});

test('"changed" means "changed since YOUR approval": not after an Ignorer, yes after a trust', async t => {
  const { project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'ignored', (await trust.evaluate(project)).token);
  await addPlugin(project, 'a.mjs', 'export const edited = 1;');
  const afterIgnore = await trust.evaluate(project);
  assert.equal(afterIgnore.contentStatus, 'pending');
  assert.equal(afterIgnore.changed, false, 'nothing was approved, so nothing "changed since the approval"');

  await trust.decide(project, 'trusted', afterIgnore.token);
  await addPlugin(project, 'a.mjs', 'export const edited = 2;');
  const afterTrust = await trust.evaluate(project);
  assert.equal(afterTrust.contentStatus, 'pending');
  assert.equal(afterTrust.changed, true);
});

test('a project with no content and no relaxation reports content "none", no relaxation, readable', async t => {
  const { project, trust } = await fixture(t);
  const result = await trust.evaluate(project);
  assert.equal(result.contentStatus, 'none');
  assert.deepEqual(result.relaxationStatus, {});
  assert.equal(result.unreadable, false);
});

test('two folders with identical content get different tokens', async t => {
  const { root, project, trust } = await fixture(t);
  const twin = join(root, 'twin');
  await mkdir(twin);
  await addPlugin(project, 'a.mjs', 'export {}');
  await addPlugin(twin, 'a.mjs', 'export {}');
  const [a, b] = await Promise.all([trust.evaluate(project), trust.evaluate(twin)]);
  assert.deepEqual(a.inventory, b.inventory, 'same content');
  assert.notEqual(a.token, b.token);
  await assert.rejects(trust.decide(twin, 'trusted', a.token), /a changé depuis l’affichage/, 'a token shown for one folder never decides another');
});

test('a registry entry with an invalid decision approves nothing', async t => {
  const { home, project, trust } = await fixture(t);
  await addPlugin(project, 'a.mjs', 'export {}');
  await trust.decide(project, 'trusted', (await trust.evaluate(project)).token);
  const path = join(home, 'trusted-projects.json');
  const registry = JSON.parse(await readFile(path, 'utf8'));
  const key = await realpath(project);
  registry[key].content.decision = 'x';
  await writeFile(path, JSON.stringify(registry));
  const result = await trust.evaluate(project);
  assert.equal(result.state, 'pending');
  assert.equal(result.contentTrusted, false);
});

test('the trust banner and the Outils tab name what files_ask covers since 2026-10-03: files, git and memory', async () => {
  const { FIELD_LABELS } = await import('../renderer-src/src/components/trust-labels.ts');
  assert.equal(FIELD_LABELS.files_ask, 'confirmation des écritures : fichiers, git, mémoire');
});
