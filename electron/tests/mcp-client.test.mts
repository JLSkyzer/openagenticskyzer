import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.cjs', import.meta.url));
const config = (extraEnv: Record<string, string> = {}) => ({
  command: process.execPath,
  args: [FAKE_SERVER],
  env: extraEnv,
});

test('mcpTools discovers real tools from a real stdio child process, as AgentTools', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([config()]);
  assert.deepEqual(errors, []);
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['mcp_boom', 'mcp_echo']);
  const echo = tools.find(t => t.name === 'mcp_echo')!;
  assert.equal(echo.category, 'extension');
  assert.equal(echo.parameters.type, 'object');
  assert.deepEqual((echo.parameters as any).required, ['text']);
});

test('a real tool call round-trips through a real child process and returns the real result', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools } = await mcpTools([config()]);
  const echo = tools.find(t => t.name === 'mcp_echo')!;
  echo.validate({ text: 'bonjour' });
  const result = await echo.execute({ text: 'bonjour' }, new AbortController().signal);
  assert.match(result, /bonjour/);
});

test('a real tool call that the server rejects surfaces the real MCP error message', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools } = await mcpTools([config()]);
  const boom = tools.find(t => t.name === 'mcp_boom')!;
  await assert.rejects(boom.execute({}, new AbortController().signal), /échec volontaire/);
});

test('a server that crashes at startup is isolated: an error is reported, other servers still work', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const crashing = config({ FAKE_MCP_CRASH: '1' });
  const { tools, errors } = await mcpTools([crashing, config()]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(process.execPath.replace(/[\\.]/g, '\\$&')));
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ['mcp_boom', 'mcp_echo'], 'the second, healthy server still contributed its tools');
});

test('a server that hangs on discovery times out instead of blocking the whole turn', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const slow = config({ FAKE_MCP_DELAY_MS: '5000' });
  const { tools, errors } = await mcpTools([slow], { discoveryTimeoutMs: 200 });
  assert.equal(tools.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /délai|timeout/i);
});

test('an empty command is refused with a clear error, no process ever spawned', async () => {
  const { mcpTools } = await import('../core/mcp-client.mts');
  const { tools, errors } = await mcpTools([{ command: '', args: [] }]);
  assert.equal(tools.length, 0);
  assert.match(errors[0], /commande/i);
});
