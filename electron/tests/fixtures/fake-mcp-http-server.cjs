// A tiny, real MCP "Streamable HTTP" server for tests — a real node:http server (not a mock),
// speaking the transport core/mcp-client.mts's remote branch speaks: JSON-RPC over HTTP POST,
// replying either as a single application/json object or as a text/event-stream SSE stream (the
// response mode is configurable per instance, so both of the client's parsing branches get real
// coverage from the same fixture). Exposes the same two tools as fixtures/fake-mcp-server.cjs
// (echo, boom) for parity with the stdio fixture — kept in a SEPARATE file since the stdio fixture
// is shared by tests asserting its exact tool list and must not change.
//
// mode: 'hang' sends a 200 + headers promptly (so fetch() resolves) but never writes or ends the
// response body — it simulates a server that stalls mid-response, to exercise the client's
// timeout covering body consumption, not just the time to first byte.
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');

function startFakeMcpHttpServer({ mode = 'json', sessionId = randomUUID() } = {}) {
  const receivedRequests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let message;
      try { message = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      receivedRequests.push({ headers: req.headers, message });
      const { id, method, params } = message;

      if (mode === 'hang') {
        // Headers arrive right away; the body never does — never call res.write()/res.end().
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        return;
      }

      let result;
      let error;
      if (method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-mcp-http', version: '1.0' } };
      } else if (method === 'tools/list') {
        result = {
          tools: [
            { name: 'echo', description: 'Echoes the input text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
          ],
        };
      } else if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name === 'echo') result = { content: [{ type: 'text', text: String(args.text ?? '') }] };
        else if (name === 'boom') error = { code: -32000, message: 'Outil boom : échec volontaire' };
        else error = { code: -32601, message: `Outil inconnu : ${name}` };
      } else {
        error = { code: -32601, message: `Méthode inconnue : ${method}` };
      }
      const payload = JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
      const extraHeaders = method === 'initialize' ? { 'mcp-session-id': sessionId } : {};
      if (mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...extraHeaders });
        res.write(`data: ${payload}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...extraHeaders });
        res.end(payload);
      }
    });
  });
  // Tracked so `close()` can forcibly tear down a connection left open by `mode: 'hang'` — the
  // client's own abort destroys its end on a real timeout, but close() must not depend on timing
  // against that to actually finish.
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/mcp`,
        sessionId,
        receivedRequests,
        close: () => new Promise(r => {
          server.close(() => r(undefined));
          for (const socket of sockets) socket.destroy();
        }),
      });
    });
  });
}
module.exports = { startFakeMcpHttpServer };
