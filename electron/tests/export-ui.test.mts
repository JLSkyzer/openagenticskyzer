import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentBranchLabel } from '../renderer-src/src/state/branches.ts';
import { performExport } from '../renderer-src/src/state/export.ts';

const MAIN = { id: 'main', label: 'Principale', created_at: '2026-09-23T10:00:00.000Z', message_count: 4 };
const fork = (id: string, label: string) => ({ id, label, created_at: '2026-09-23T10:05:00.000Z', message_count: 1 });

test('currentBranchLabel: "🌿 Main" for main, the fork\'s own label otherwise', () => {
  assert.equal(currentBranchLabel([MAIN], 'main'), '🌿 Main');
  assert.equal(currentBranchLabel([MAIN, fork('a', 'Branche 1')], 'a'), 'Branche 1');
});

test('currentBranchLabel falls back to "🌿 Main" for an id it cannot find (defensive, never throws)', () => {
  assert.equal(currentBranchLabel([MAIN], 'inconnu'), '🌿 Main');
  assert.equal(currentBranchLabel([], 'main'), '🌿 Main');
});

function fakeDeps(overrides: Partial<{
  exportConversation: () => Promise<{ filename: string }>;
  openExportedFile: () => Promise<{ opened: boolean }>;
}> = {}) {
  const calls: string[] = [];
  return {
    calls,
    exportConversation: overrides.exportConversation ?? (async () => { calls.push('exportConversation'); return { filename: 'conversation_20260923_090503.md' }; }),
    openExportedFile: overrides.openExportedFile ?? (async () => { calls.push('openExportedFile'); return { opened: true }; }),
  };
}

test('performExport: writes, opens, and notifies success with the real filename — in that order', async () => {
  const deps = fakeDeps();
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(deps.calls, ['exportConversation', 'openExportedFile']);
  assert.deepEqual(notices, [['Exporté : conversation_20260923_090503.md', 'positive']]);
});

test('performExport calls exportConversation with exactly (folder, branchId, format): the worker names the model itself', async () => {
  const deps = fakeDeps();
  const captured: unknown[][] = [];
  deps.exportConversation = (async (...args: unknown[]) => {
    captured.push(args);
    return { filename: 'x.html' };
  }) as any;
  await performExport(deps, 'D:\\proj', 'abc', 'html', () => {});
  assert.deepEqual(captured, [['D:\\proj', 'abc', 'html']]);
});

test('performExport: a write failure notifies "Échec de l\'export : <erreur>" and never tries to open anything', async () => {
  const deps = fakeDeps({ exportConversation: async () => { throw new Error('Dossier introuvable'); } });
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(notices, [["Échec de l'export : Dossier introuvable", 'negative']]);
  assert.equal(deps.calls.includes('openExportedFile'), false);
});

test('performExport: the file was written, so a failure to OPEN it still counts as a success (unlike os.startfile in the original, a deliberate improvement)', async () => {
  const deps = fakeDeps({ openExportedFile: async () => { throw new Error('Aucune association'); } });
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(notices, [['Exporté : conversation_20260923_090503.md', 'positive']], 'the export is still reported as a success');
});

test('performExport needs no connection: its deps are the export and the opening only', async () => {
  const deps = fakeDeps();
  assert.deepEqual(Object.keys(deps).filter(key => key !== 'calls').sort(), ['exportConversation', 'openExportedFile']);
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(notices, [['Exporté : conversation_20260923_090503.md', 'positive']], 'no connection is read, and the export succeeds');
  assert.deepEqual(deps.calls, ['exportConversation', 'openExportedFile']);
});

test("performExport: a refusal relayed by Electron shows the worker's own message, without the IPC wrapper", async () => {
  const deps = fakeDeps({ exportConversation: async () => { throw new Error("Error invoking remote method 'backend-request': Error: Dossier introuvable"); } });
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(notices, [["Échec de l'export : Dossier introuvable", 'negative']]);
});
