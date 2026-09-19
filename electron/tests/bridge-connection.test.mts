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

test('project settings go through project-settings / save-project-settings', async () => {
  calls.length = 0;
  await bridge.getProjectSettings('D:\\proj');
  assert.deepEqual(calls[0], { op: 'project-settings', payload: { folder: 'D:\\proj' } });
  await bridge.saveProjectSettings('D:\\proj', { agent_mode: 'plan' });
  assert.deepEqual(calls[1], { op: 'save-project-settings', payload: { folder: 'D:\\proj', patch: { agent_mode: 'plan' } } });
});
