import { test } from 'node:test';
import assert from 'node:assert/strict';

// The renderer-side bridge is a thin typed layer over window.openagent.request — these
// tests pin the exact op names/payload shapes main.cjs and worker.mjs expect, without a
// real Electron window.
const calls: Array<{ op: string; payload?: Record<string, unknown> }> = [];
(globalThis as any).window = {
  openagent: {
    request: async (request: { op: string; payload?: Record<string, unknown> }) => {
      calls.push(request);
      return { echoed: request.op };
    },
  },
};
const bridge = await import('../renderer-src/src/ipc/bridge.ts');

test('getConnection asks connection-snapshot for the given scope', async () => {
  calls.length = 0;
  await bridge.getConnection('D:\\proj');
  assert.deepEqual(calls[0], { op: 'connection-snapshot', payload: { folder: 'D:\\proj' } });
  await bridge.getConnection(null);
  assert.deepEqual(calls[1], { op: 'connection-snapshot', payload: { folder: null } });
});

test('saveConnection forwards the patch and only sets confirmEndpoint when asked', async () => {
  calls.length = 0;
  const patch = { provider: 'openrouter' as const, model: 'm', api_key: 'sk-fake' };
  await bridge.saveConnection('D:\\proj', patch);
  assert.deepEqual(calls[0], {
    op: 'save-connection',
    payload: { folder: 'D:\\proj', patch, authorization: { confirmEndpoint: false } },
  });
  await bridge.saveConnection(null, { provider: 'ollama', base_url: 'http://localhost:11434/v1' }, true);
  assert.deepEqual(calls[1].payload?.authorization, { confirmEndpoint: true });
});

test('danger zone bridges call their dedicated ops with the folder', async () => {
  calls.length = 0;
  await bridge.clearHistory('D:\\proj');
  assert.deepEqual(calls[0], { op: 'clear-history', payload: { folder: 'D:\\proj' } });
  await bridge.removeFolder('D:\\proj');
  assert.deepEqual(calls[1], { op: 'remove-folder', payload: { folder: 'D:\\proj' } });
  await bridge.resetGlobalSettings();
  assert.equal(calls[2].op, 'reset-global-settings');
});

test('branch bridges call list-branches and fork with the exact payloads the worker expects', async () => {
  calls.length = 0;
  await bridge.listBranches('D:\\proj');
  assert.deepEqual(calls[0], { op: 'list-branches', payload: { folder: 'D:\\proj' } });
  await bridge.forkBranch('D:\\proj', 'main', 3, 'Branche 1');
  assert.deepEqual(calls[1], { op: 'fork', payload: { folder: 'D:\\proj', source: 'main', count: 3, label: 'Branche 1' } });
});

test('compactConversation asks the worker to compact the given branch of the given folder', async () => {
  calls.length = 0;
  await bridge.compactConversation('D:\\proj', 'abc');
  assert.deepEqual(calls[0], { op: 'compact', payload: { folder: 'D:\\proj', branchId: 'abc' } });
});

test('onSettingsChanged fires after a successful save of settings or connection, never after a failure', async () => {
  let fired = 0;
  const stop = bridge.onSettingsChanged(() => { fired++; });
  await bridge.saveGlobalSettings({ show_context_bar: false });
  await bridge.saveProjectSettings('D:\\proj', { agent_mode: 'plan' });
  await bridge.saveConnection(null, { provider: 'groq' });
  await bridge.resetGlobalSettings();
  assert.equal(fired, 4, 'each successful save announces itself once');

  const original = (globalThis as any).window.openagent.request;
  (globalThis as any).window.openagent.request = async () => { throw new Error('refusé'); };
  await assert.rejects(bridge.saveGlobalSettings({ show_context_bar: true }), /refusé/);
  (globalThis as any).window.openagent.request = original;
  assert.equal(fired, 4, 'a refused save changed nothing, so nothing is announced');

  stop();
  await bridge.saveGlobalSettings({ show_context_bar: true });
  assert.equal(fired, 4, 'unsubscribing stops the notifications');
});

test('listPrompts asks the worker for the prompt library, with no payload', async () => {
  calls.length = 0;
  await bridge.listPrompts();
  assert.deepEqual(calls[0], { op: 'list-prompts', payload: undefined });
});

test('readProjectMemory asks the worker for the memory of the given folder', async () => {
  calls.length = 0;
  await bridge.readProjectMemory('D:\\proj');
  assert.deepEqual(calls[0], { op: 'read-project-memory', payload: { folder: 'D:\\proj' } });
});

test('project settings go through project-settings / save-project-settings', async () => {
  calls.length = 0;
  await bridge.getProjectSettings('D:\\proj');
  assert.deepEqual(calls[0], { op: 'project-settings', payload: { folder: 'D:\\proj' } });
  await bridge.saveProjectSettings('D:\\proj', { agent_mode: 'plan' });
  assert.deepEqual(calls[1], { op: 'save-project-settings', payload: { folder: 'D:\\proj', patch: { agent_mode: 'plan' } } });
});
