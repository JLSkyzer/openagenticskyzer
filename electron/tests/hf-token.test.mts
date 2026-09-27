import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

async function fakeHf(t: any, handler: (request: any, response: any) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/api/whoami-v2`;
}

test('testHfToken resolves with the account name on a real 200 response', async t => {
  let receivedAuth = '';
  const baseUrl = await fakeHf(t, (request, response) => {
    receivedAuth = request.headers.authorization || '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'killian-dev' }));
  });
  const { testHfToken } = await import('../core/hf-token.mts');
  const result = await testHfToken('hf_secret123', { baseUrl });
  assert.deepEqual(result, { name: 'killian-dev' });
  assert.equal(receivedAuth, 'Bearer hf_secret123');
});

test('testHfToken rejects on a 401 (invalid token), with the status in the message', async t => {
  const baseUrl = await fakeHf(t, (_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Invalid credentials' }));
  });
  const { testHfToken } = await import('../core/hf-token.mts');
  await assert.rejects(testHfToken('hf_bad', { baseUrl }), /401/);
});

test('testHfToken rejects immediately on an empty/blank token, no request sent', async t => {
  let called = false;
  const baseUrl = await fakeHf(t, (_request, response) => { called = true; response.end('{}'); });
  const { testHfToken } = await import('../core/hf-token.mts');
  await assert.rejects(testHfToken('   ', { baseUrl }), /vide/i);
  assert.equal(called, false);
});

test('testHfToken rejects on a malformed response body', async t => {
  const baseUrl = await fakeHf(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('not json');
  });
  const { testHfToken } = await import('../core/hf-token.mts');
  await assert.rejects(testHfToken('hf_ok', { baseUrl }));
});

test('testHfToken rejects on a real timeout, using a real slow server (short timeoutMs)', async t => {
  const baseUrl = await fakeHf(t, () => { /* never respond */ });
  const { testHfToken } = await import('../core/hf-token.mts');
  await assert.rejects(testHfToken('hf_slow', { baseUrl, timeoutMs: 100 }), /délai/i);
});
