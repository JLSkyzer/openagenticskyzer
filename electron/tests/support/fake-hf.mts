// A local stand-in for huggingface.co (catalogue and downloads), on 127.0.0.1 only: no test ever reaches the network.
// It serves the three endpoints the app reads:
//   GET /api/models                         the list given to setModels (raw JSON entries, as the real API shapes them);
//   GET /api/models/<owner>/<name>/tree/main the tree built from the files given to setFile;
//   GET /<owner>/<name>/resolve/main/<file>  a 307 to the bytes, then the bytes (with Range when the file allows it).
// setFile('owner/name/dir/file.gguf', bytes, options) — the first two segments are the repository:
//   lfs:      false lists the file without an `lfs` block (no SHA-256); default true, oid = SHA-256 of the bytes;
//   sha256:   overrides the listed oid (to serve bytes that do not match it);
//   ranges:   false ignores the Range header and never says Accept-Ranges (default true);
//   cutAfter: closes the connection after that many body bytes, for the first `cutTimes` requests (default 1);
//   holdAfter: sends that many body bytes then goes silent with the connection open, for the first `holdTimes` requests (default 1);
//   status:   401 or 403 on /resolve (and on the tree for that file's repository if `treeStatus` is set);
//   redirect: 'relative' (Location: /api/resolve-cache/...), 'other-port' (a second server) or 'none' (200 at once);
//   location: /resolve answers a 307 to exactly this Location (a loop, a refused scheme), whatever `redirect` says.
// failApi(status) makes /api/* answer that status until failApi(null). `hits` records every request.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface FakeFileOptions {
  lfs?: boolean;
  sha256?: string;
  ranges?: boolean;
  cutAfter?: number;
  cutTimes?: number;
  holdAfter?: number;
  holdTimes?: number;
  status?: 401 | 403;
  treeStatus?: 401 | 403;
  redirect?: 'relative' | 'other-port' | 'none';
  location?: string;
}

export interface FakeHit { method: string; path: string; authorization: string | undefined; range: string | undefined; userAgent: string | undefined }

interface StoredFile { bytes: Uint8Array; options: FakeFileOptions; cuts: number; holds: number }

export async function startFakeHf() {
  const files = new Map<string, StoredFile>(); // key: "owner/name/path"
  let models: unknown[] = [];
  let apiStatus: number | null = null;
  const hits: FakeHit[] = [];

  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  function serveBytes(req: IncomingMessage, res: ServerResponse, file: StoredFile) {
    const total = file.bytes.length;
    let start = 0;
    let end = total - 1;
    let partial = false;
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && file.options.ranges !== false) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
      if (start >= total) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return; }
      partial = true;
    }
    const body = file.bytes.subarray(start, end + 1);
    const headers: Record<string, string | number> = { 'content-type': 'application/octet-stream', 'content-length': body.length };
    if (file.options.ranges !== false) headers['accept-ranges'] = 'bytes';
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${total}`;
    res.writeHead(partial ? 206 : 200, headers);
    const cutTimes = file.options.cutTimes ?? 1;
    if (file.options.cutAfter !== undefined && file.cuts < cutTimes) {
      file.cuts++;
      // The delay lets the client read those bytes: an immediate destroy can reset the socket with them still unread.
      res.write(body.subarray(0, file.options.cutAfter), () => setTimeout(() => req.socket.destroy(), 50));
      return;
    }
    if (file.options.holdAfter !== undefined && file.holds < (file.options.holdTimes ?? 1)) {
      file.holds++;
      res.write(body.subarray(0, file.options.holdAfter));
      return;
    }
    res.end(body);
  }

  const find = (key: string) => files.get(key);

  // The second server: where an 'other-port' redirect lands. Path: /blob/<owner>/<name>/<file>.
  const other: Server = createServer((req, res) => {
    record(req);
    const file = find(decodeURIComponent((req.url ?? '').replace(/^\/blob\//, '').split('?')[0]));
    if (!file) { res.writeHead(404); res.end(); return; }
    serveBytes(req, res, file);
  });

  function record(req: IncomingMessage) {
    hits.push({
      method: req.method ?? 'GET',
      path: req.url ?? '',
      authorization: req.headers.authorization,
      range: req.headers.range,
      userAgent: req.headers['user-agent'],
    });
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as AddressInfo).port;
  const otherUrl = `http://127.0.0.1:${otherPort}`;

  const main: Server = createServer((req, res) => {
    record(req);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      if (apiStatus !== null) { json(res, apiStatus, { error: 'failed on purpose' }); return; }
      if (path === '/api/models') { json(res, 200, models); return; }
      const tree = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/.exec(path);
      if (tree) {
        const repo = decodeURIComponent(tree[1]);
        const own = [...files].filter(([key]) => key.startsWith(`${repo}/`));
        if (own.some(([, f]) => f.options.treeStatus)) { json(res, own.find(([, f]) => f.options.treeStatus)![1].options.treeStatus!, { error: 'restricted' }); return; }
        json(res, 200, own.map(([key, f]) => {
          const name = key.slice(repo.length + 1);
          const entry: Record<string, unknown> = { type: 'file', oid: sha(new TextEncoder().encode(key)).slice(0, 40), size: f.bytes.length, path: name };
          if (f.options.lfs !== false) entry.lfs = { oid: f.options.sha256 ?? sha(f.bytes), size: f.bytes.length, pointerSize: 136 };
          return entry;
        }));
        return;
      }
      // /api/resolve-cache/models/<owner>/<name>/<rev>/<file> — what a relative redirect points at
      const cache = /^\/api\/resolve-cache\/models\/([^/]+\/[^/]+)\/main\/(.+)$/.exec(path);
      if (cache) {
        const file = find(`${decodeURIComponent(cache[1])}/${decodeURIComponent(cache[2])}`);
        if (!file) { res.writeHead(404); res.end(); return; }
        serveBytes(req, res, file);
        return;
      }
      json(res, 404, { error: 'not found' });
      return;
    }

    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(path);
    if (resolve) {
      const repo = decodeURIComponent(resolve[1]);
      const name = decodeURIComponent(resolve[2]);
      const file = find(`${repo}/${name}`);
      if (!file) { res.writeHead(404); res.end(); return; }
      if (file.options.status) { res.writeHead(file.options.status); res.end(); return; }
      if (file.options.location) { res.writeHead(307, { location: file.options.location }); res.end(); return; }
      const mode = file.options.redirect ?? 'relative';
      if (mode === 'none') { serveBytes(req, res, file); return; }
      const key = `${repo}/${name}`;
      const location = mode === 'relative'
        ? `/api/resolve-cache/models/${repo}/main/${encodeURI(name)}`
        : `${otherUrl}/blob/${encodeURI(key)}`;
      res.writeHead(307, { location });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolve => main.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(main.address() as AddressInfo).port}`;

  return {
    baseUrl,
    otherUrl,
    hits,
    setModels(list: unknown[]) { models = list; },
    setFile(path: string, bytes: Uint8Array, options: FakeFileOptions = {}) { files.set(path, { bytes, options, cuts: 0, holds: 0 }); },
    failApi(status: number | null) { apiStatus = status; },
    async close() {
      main.closeAllConnections();
      other.closeAllConnections();
      await Promise.all([main, other].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
    },
  };
}
