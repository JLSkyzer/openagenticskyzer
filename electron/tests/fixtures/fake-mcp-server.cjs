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
      ],
    });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'echo') reply(id, { content: [{ type: 'text', text: String(args.text ?? '') }] });
    else if (name === 'boom') replyError(id, -32000, 'Outil boom : échec volontaire');
    else replyError(id, -32601, `Outil inconnu : ${name}`);
  } else {
    replyError(id, -32601, `Méthode inconnue : ${method}`);
  }
}
