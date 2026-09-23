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
  getConnection: () => Promise<{ provider: string; model: string }>;
  exportConversation: () => Promise<{ filename: string }>;
  openExportedFile: () => Promise<{ opened: boolean }>;
}> = {}) {
  const calls: string[] = [];
  return {
    calls,
    getConnection: overrides.getConnection ?? (async () => { calls.push('getConnection'); return { provider: 'openrouter', model: 'gpt-4o' }; }),
    exportConversation: overrides.exportConversation ?? (async () => { calls.push('exportConversation'); return { filename: 'conversation_20260923_090503.md' }; }),
    openExportedFile: overrides.openExportedFile ?? (async () => { calls.push('openExportedFile'); return { opened: true }; }),
  };
}

test('performExport: writes, opens, and notifies success with the real filename — in that order', async () => {
  const deps = fakeDeps();
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(deps.calls, ['getConnection', 'exportConversation', 'openExportedFile']);
  assert.deepEqual(notices, [['Exporté : conversation_20260923_090503.md', 'positive']]);
});

test('performExport passes the real connection (provider/model) it read, to the export call', async () => {
  const deps = fakeDeps({ getConnection: async () => ({ provider: 'groq', model: 'llama-3.3' }) });
  const captured: unknown[][] = [];
  deps.exportConversation = (async (folder: string, branchId: string, format: string, provider: string, model: string) => {
    captured.push([folder, branchId, format, provider, model]);
    return { filename: 'x.html' };
  }) as any;
  await performExport(deps, 'D:\\proj', 'abc', 'html', () => {});
  assert.deepEqual(captured[0], ['D:\\proj', 'abc', 'html', 'groq', 'llama-3.3']);
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

test('performExport: a connection read failure is reported as an export failure too (the model/provider are required to build the header)', async () => {
  const deps = fakeDeps({ getConnection: async () => { throw new Error('boom'); } });
  const notices: Array<[string, string]> = [];
  await performExport(deps, 'D:\\proj', 'main', 'md', (text, kind) => notices.push([text, kind ?? 'positive']));
  assert.deepEqual(notices, [["Échec de l'export : boom", 'negative']]);
  assert.equal(deps.calls.includes('exportConversation'), false, 'the write is never attempted without a connection');
  assert.equal(deps.calls.includes('openExportedFile'), false);
});
