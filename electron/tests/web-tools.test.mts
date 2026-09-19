import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

const { webTools } = await import('../core/web-tools.mts');

class MissingTool extends Error {}
async function refuses(promise: Promise<unknown>, expected?: RegExp) {
  await assert.rejects(promise, (error: any) => {
    assert.ok(!(error instanceof MissingTool), error.message);
    return expected ? expected.test(String(error.message)) : true;
  });
}

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;
async function serve(t: any, handler: Handler) {
  const requests: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { requests.push({ method: request.method, url: request.url, headers: request.headers, body }); handler(request, response, body); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as any).port as number;
  return { port, url: `http://127.0.0.1:${port}`, requests };
}

// Loopback is where the fake servers live: the test build of the tools lets loopback through
// (and only loopback) so behavior can be tested; the DEFAULT build refuses it, tested below.
async function tools(options: Record<string, unknown> = {}) {
  const list = await webTools({ unsafeAllowLoopbackForTests: true, retryDelaysMs: [0, 0], ...options } as any);
  const call = async (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => {
    const tool = list.find(entry => entry.name === name);
    if (!tool) throw new MissingTool(`Missing ${name}`);
    tool.validate(args);
    return tool.execute(args, signal);
  };
  return { list, fetchUrl: (args: Record<string, unknown>, signal?: AbortSignal) => call('fetch_url', args, signal), search: (args: Record<string, unknown>) => call('internet_search', args) };
}
const strict = async (options: Record<string, unknown> = {}) => {
  const list = await webTools(options as any);
  const tool = list.find(entry => entry.name === 'fetch_url');
  if (!tool) throw new MissingTool('Missing fetch_url');
  return (args: Record<string, unknown>) => { tool.validate(args); return tool.execute(args, new AbortController().signal); };
};
const json = (text: string) => JSON.parse(text);

// ── URL and address policy (default build) ────────────────────────────────────────
test('only http and https URLs are fetched, and never with embedded credentials', async () => {
  const fetchUrl = await strict();
  for (const url of ['file:///etc/passwd', 'file:///C:/Windows/win.ini', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://example.com/']) {
    await refuses(fetchUrl({ url }), /protocole/i);
  }
  await refuses(fetchUrl({ url: 'https://user:pass@example.com/' }), /identifiants/i);
  await refuses(fetchUrl({ url: 'pas une url' }), /url/i);
});

test('loopback, private, link-local and metadata addresses are refused in every spelling', async () => {
  const fetchUrl = await strict();
  for (const url of [
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://localhost/', 'http://[::1]/',
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://224.0.0.1/', 'http://255.255.255.255/',
  ]) {
    await refuses(fetchUrl({ url }), /interne|privée/i);
  }
});

test('a public-looking hostname that resolves to a private address is refused, mixed answers included', async () => {
  const toLoopback = await strict({ resolve: async () => ['127.0.0.1'] });
  await refuses(toLoopback({ url: 'http://looks-public.test/' }), /interne|privée/i);
  const mixed = await strict({ resolve: async () => ['93.184.216.34', '10.0.0.5'] });
  await refuses(mixed({ url: 'http://mixed.test/' }), /interne|privée/i);
  const none = await strict({ resolve: async () => [] });
  await refuses(none({ url: 'http://nothing.test/' }));
});

test('a server on loopback is never contacted by the default build', async t => {
  const server = await serve(t, (_req, res) => res.end('secret internal page'));
  const fetchUrl = await strict();
  await refuses(fetchUrl({ url: `${server.url}/` }), /interne|privée/i);
  await refuses(fetchUrl({ url: `http://localhost:${server.port}/` }), /interne|privée/i);
  assert.equal(server.requests.length, 0, 'not a single request reached the internal server');
});

// ── redirects ─────────────────────────────────────────────────────────────────────
test('redirects are followed manually, relative ones included, and the final URL is reported', async t => {
  const server = await serve(t, (req, res) => {
    if (req.url === '/a') { res.writeHead(302, { location: '/b' }); res.end(); }
    else if (req.url === '/b') { res.writeHead(301, { location: `http://127.0.0.1:${(res.socket as any).localPort}/c` }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('arrivé'); }
  });
  const { fetchUrl } = await tools();
  const out = json(await fetchUrl({ url: `${server.url}/a` }));
  assert.equal(out.content, 'arrivé');
  assert.equal(out.url, `${server.url}/c`);
});

test('a redirect to a private address, a file URL, or in a loop is refused', async t => {
  const server = await serve(t, (req, res) => {
    const targets: Record<string, string> = { '/to-metadata': 'http://169.254.169.254/latest/meta-data/', '/to-file': 'file:///etc/passwd', '/to-private': 'http://10.0.0.1/', '/loop': '/loop' };
    if (targets[req.url!]) { res.writeHead(302, { location: targets[req.url!] }); res.end(); } else res.end('ok');
  });
  const { fetchUrl } = await tools();
  await refuses(fetchUrl({ url: `${server.url}/to-metadata` }), /interne|privée/i);
  await refuses(fetchUrl({ url: `${server.url}/to-private` }), /interne|privée/i);
  await refuses(fetchUrl({ url: `${server.url}/to-file` }), /protocole/i);
  await refuses(fetchUrl({ url: `${server.url}/loop` }), /redirections/i);
  assert.ok(server.requests.filter(r => r.url === '/loop').length <= 6, 'the loop was cut after a handful of hops');
});

// ── content ───────────────────────────────────────────────────────────────────────
test('HTML becomes readable text: title extracted, scripts/styles/navigation dropped, entities decoded', async t => {
  const server = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Ma &amp; Page</title><style>p{color:red}</style><script>alert("x")</script></head><body><nav>menu</nav><header>bandeau</header><h1>Bonjour</h1><p>Un&nbsp;texte &lt;important&gt; &#233;t&#x00e9;</p><footer>pied</footer></body></html>');
  });
  const { fetchUrl } = await tools();
  const out = json(await fetchUrl({ url: server.url }));
  assert.equal(out.title, 'Ma & Page');
  assert.equal(out.content, 'Bonjour Un texte <important> été');
  assert.equal(out.provider, 'direct');
  assert.equal(out.chars, out.content.length);
  for (const gone of ['alert', 'color:red', 'menu', 'bandeau', 'pied']) assert.equal(out.content.includes(gone), false, gone);
});

test('plain text and JSON are returned as they are; non-text content is refused', async t => {
  const server = await serve(t, (req, res) => {
    if (req.url === '/txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('  du texte  '); }
    else if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"a":1}'); }
    else { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from([137, 80, 78, 71])); }
  });
  const { fetchUrl } = await tools();
  assert.equal(json(await fetchUrl({ url: `${server.url}/txt` })).content, 'du texte');
  assert.equal(json(await fetchUrl({ url: `${server.url}/json` })).content, '{"a":1}');
  await refuses(fetchUrl({ url: `${server.url}/img` }), /non textuel/i);
});

test('max_chars truncates with an ellipsis and is bounded', async t => {
  const server = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(10000)); });
  const { fetchUrl } = await tools();
  const out = json(await fetchUrl({ url: server.url, max_chars: 100 }));
  assert.equal(out.content, 'x'.repeat(100) + '…');
  assert.equal(json(await fetchUrl({ url: server.url })).content.length, 4001, 'default is 4000 characters');
  await refuses(fetchUrl({ url: server.url, max_chars: 0 }), /nombre/i);
  await refuses(fetchUrl({ url: server.url, max_chars: 50001 }), /nombre/i);
});

test('an HTTP error status is reported, not returned as content', async t => {
  const server = await serve(t, (_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('missing'); });
  const { fetchUrl } = await tools();
  await refuses(fetchUrl({ url: server.url }), /404/);
});

test('a huge body is read up to a cap only, and a gzip bomb cannot blow past it', async t => {
  const big = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('y'.repeat(3 * 1024 * 1024)); });
  const bomb = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.alloc(200 * 1024 * 1024, 97))); });
  const { fetchUrl } = await tools();
  const started = Date.now();
  assert.equal(json(await fetchUrl({ url: big.url, max_chars: 50000 })).content.length, 50001);
  const shrunk = json(await fetchUrl({ url: bomb.url, max_chars: 50000 }));
  assert.equal(shrunk.content.length, 50001);
  assert.ok(Date.now() - started < 10000, 'the bomb was cut, not decompressed to the end');
});

test('gzip-encoded pages are decoded', async t => {
  const server = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gzipSync('<title>Zip</title><p>compressé</p>')); });
  const { fetchUrl } = await tools();
  const out = json(await fetchUrl({ url: server.url }));
  assert.deepEqual([out.title, out.content], ['Zip', 'compressé']);
});

test('a silent server times out and an abort stops the request', async t => {
  const server = await serve(t, () => { /* never answers */ });
  const { fetchUrl } = await tools({ timeoutMs: 400 });
  const started = Date.now();
  await refuses(fetchUrl({ url: server.url }), /délai/i);
  assert.ok(Date.now() - started < 4000);
  const patient = await tools({ timeoutMs: 30000 });
  const controller = new AbortController();
  const running = patient.fetchUrl({ url: server.url }, controller.signal);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(running, { name: 'AbortError' });
});

test('a hostname is resolved through the injected resolver and the Host header is preserved', async t => {
  const server = await serve(t, (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(String(req.headers.host)); });
  const { fetchUrl } = await tools({ resolve: async (host: string) => (host === 'site.test' ? ['127.0.0.1'] : []) });
  const out = json(await fetchUrl({ url: `http://site.test:${server.port}/` }));
  assert.equal(out.content, `site.test:${server.port}`);
});

// ── internet_search ───────────────────────────────────────────────────────────────
const KEY = 'tvly-FAKE-KEY';

test('with a Tavily key the search goes to Tavily, key in the Authorization header and never in the results', async t => {
  const tavily = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Un', url: 'https://a.example/1', content: 'premier', raw_content: 'brut'.repeat(1000) }, { title: 'Deux', url: 'https://b.example/2', content: 'second' }] }));
  });
  const { search } = await tools({ env: { TAVILY_API_KEY: KEY }, tavilyUrl: `${tavily.url}/search` });
  const out = json(await search({ query: 'openagent', max_results: 2, topic: 'news', include_raw_content: true }));
  assert.equal(out.provider, 'tavily');
  assert.deepEqual(out.results.map((r: any) => [r.title, r.url, r.content.slice(0, 7)]), [['Un', 'https://a.example/1', 'premier'], ['Deux', 'https://b.example/2', 'second']]);
  assert.ok(out.results[0].raw_content.length <= 2000, 'raw content is bounded');
  assert.equal(JSON.stringify(out).includes(KEY), false);
  const sent = tavily.requests[0];
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(sent.body), { query: 'openagent', max_results: 2, topic: 'news', include_raw_content: true });
});

test('a Tavily failure is reported without echoing the key, and never falls back silently to another engine', async t => {
  const tavily = await serve(t, (_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `bad key ${KEY}` })); });
  const { search } = await tools({ env: { TAVILY_API_KEY: KEY }, tavilyUrl: `${tavily.url}/search` });
  await assert.rejects(search({ query: 'x' }), (error: any) => { assert.match(error.message, /401/); assert.equal(error.message.includes(KEY), false); return true; });
});

const DDG_PAGE = `<html><body>
 <div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Titre <b>A</b> &amp; co</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Extrait avec <b>gras</b> et &quot;guillemets&quot;</a></div></div>
 <div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://direct.example.org/b">Titre B</a></h2>
  <a class="result__snippet" href="https://direct.example.org/b">Extrait B</a></div></div>
 <div class="result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Piégé</a></h2><a class="result__snippet">x</a></div>
 <div class="result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fthird.example%2Fc">Titre C</a></h2><a class="result__snippet">Extrait C</a></div>
</body></html>`;

test('without a key DuckDuckGo results are parsed: tags stripped, redirect links unwrapped, unsafe links dropped', async t => {
  const ddg = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(DDG_PAGE); });
  const { search } = await tools({ env: {}, duckDuckGoUrl: `${ddg.url}/html/` });
  const out = json(await search({ query: 'openagent & co', max_results: 5 }));
  assert.equal(out.provider, 'duckduckgo');
  assert.deepEqual(out.results, [
    { title: 'Titre A & co', url: 'https://example.com/a?x=1', content: 'Extrait avec gras et "guillemets"' },
    { title: 'Titre B', url: 'https://direct.example.org/b', content: 'Extrait B' },
    { title: 'Titre C', url: 'https://third.example/c', content: 'Extrait C' },
  ]);
  assert.equal(ddg.requests[0].method, 'POST');
  assert.equal(new URLSearchParams(ddg.requests[0].body).get('q'), 'openagent & co');
  assert.equal(json(await search({ query: 'x', max_results: 1 })).results.length, 1, 'max_results is honoured');
});

test('a blank or whitespace Tavily key means DuckDuckGo', async t => {
  const ddg = await serve(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(DDG_PAGE); });
  const { search } = await tools({ env: { TAVILY_API_KEY: '   ' }, duckDuckGoUrl: `${ddg.url}/html/` });
  assert.equal(json(await search({ query: 'x' })).provider, 'duckduckgo');
});

test('DuckDuckGo throttling is retried, and a persistent failure is reported after 3 attempts', async t => {
  let calls = 0;
  const flaky = await serve(t, (_req, res) => { calls++; if (calls < 3) { res.writeHead(202); res.end('anomaly'); } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(DDG_PAGE); } });
  const { search } = await tools({ env: {}, duckDuckGoUrl: `${flaky.url}/html/` });
  assert.equal(json(await search({ query: 'x' })).results.length, 3);
  assert.equal(calls, 3);
  const down = await serve(t, (_req, res) => { res.writeHead(503); res.end('down'); });
  const failing = await tools({ env: {}, duckDuckGoUrl: `${down.url}/html/` });
  await refuses(failing.search({ query: 'x' }), /échec|503/i);
  assert.equal(down.requests.length, 3, 'three attempts, then it gives up');
});

test('search arguments are validated', async () => {
  const { search } = await tools({ env: {} });
  await refuses(search({}), /requis/i);
  await refuses(search({ query: 'x', max_results: 0 }), /nombre/i);
  await refuses(search({ query: 'x', max_results: 21 }), /nombre/i);
  await refuses(search({ query: 'x', topic: 'sports' }), /autoris/i);
  await refuses(search({ query: 'x', include_raw_content: 'yes' }), /booléen/i);
  await refuses(search({ query: '   ' }), /vide/i);
});
