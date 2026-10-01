#!/usr/bin/env node
// A tiny, real MCP-like stdio JSON-RPC 2.0 server for tests. Not a mock: it is a real child
// process, reading real newline-delimited JSON-RPC from stdin and writing real responses to
// stdout, exactly the transport core/mcp-client.mts speaks. Exposes one tool, "echo", and a
// second, "boom", that always errors — enough to exercise success and failure paths for real.
if (process.env.FAKE_MCP_CRASH === '1') process.exit(1);

let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  const delay = Number(process.env.FAKE_MCP_DELAY_MS || 0);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));

  if (method === 'initialize') {
    reply(id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1.0' } });
  } else if (method === 'tools/list') {
    reply(id, {
      tools: [
        { name: 'echo', description: 'Echoes the input text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
        // Opt-in third tool with an arbitrary (possibly invalid) name, for tests only.
        ...(process.env.FAKE_MCP_EXTRA_TOOL_NAME ? [{ name: process.env.FAKE_MCP_EXTRA_TOOL_NAME, inputSchema: { type: 'object', properties: {} } }] : []),
      ],
    });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    // An optional first CLI argument tags the echo, so a test can run two instances of this same
    // fixture (different args = different server identity) and tell which one actually answered.
    // Without that argument the output is unchanged.
    const tag = process.argv[2];
    const text = String(args.text ?? '');
    if (name === 'echo') reply(id, { content: [{ type: 'text', text: tag ? `[${tag}] ${text}` : text }] });
    else if (name === 'boom') replyError(id, -32000, 'Outil boom : échec volontaire');
    else replyError(id, -32601, `Outil inconnu : ${name}`);
  } else {
    replyError(id, -32601, `Méthode inconnue : ${method}`);
  }
}
