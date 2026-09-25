'use strict';
// The `oa-artifact:` protocol: serves the side-panel previews (artifact_panel.py) of what a model wrote — an
// HTML page, an SVG, a Mermaid diagram — from the main process, each with its OWN Content-Security-Policy.
//
// Why not `<iframe srcdoc>`: such a frame (like blob: and data:) INHERITS the CSP of the page that embeds it. The
// app's CSP forbids inline scripts, so an interactive HTML artifact would be silently dead once packaged — while
// loosening the app's own policy to fix that would weaken the whole window. A document served by this protocol
// carries its own policy instead: inline script allowed for an HTML artifact, but `default-src 'none'`, i.e. no
// network of any kind (no fetch, no XHR, no WebSocket, no remote image or script). That is stricter than the
// original NiceGUI app, where the generated script could reach the Internet.
const { randomUUID } = require('node:crypto');

const SCHEME = 'oa-artifact';
const HOST = 'a';
const KINDS = new Set(['html', 'static']);
const ID = /^\/([0-9a-f-]{36})$/;

// `html`: a page that may run its inline script. `static` (svg, mermaid): no script at all — script-src is not
// listed, so it falls back to default-src 'none'.
function cspFor(kind) {
  const base = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
  return kind === 'html' ? `${base}; script-src 'unsafe-inline'` : base;
}

/**
 * In-memory store of the documents to serve. Bounded twice — by count (the oldest is forgotten) and by size
 * of one document — because the page hands over whatever a model wrote.
 */
function createArtifactStore({ max = 20, maxBytes = 2 * 1024 * 1024 } = {}) {
  const documents = new Map();

  function put(kind, html) {
    if (!KINDS.has(kind)) throw new Error('Type d’artifact invalide');
    if (typeof html !== 'string') throw new Error('Contenu d’artifact invalide');
    if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new Error('Artifact trop volumineux pour l’aperçu');
    const id = randomUUID();
    documents.set(id, { kind, html });
    while (documents.size > max) documents.delete(documents.keys().next().value);
    return { url: `${SCHEME}://${HOST}/${id}` };
  }

  // Never says why a request was refused (unknown id, wrong host, malformed URL all look the same).
  function respond(url, method) {
    let parsed;
    try { parsed = new URL(url); } catch { return { status: 404, headers: {}, body: '' }; }
    const match = parsed.protocol === `${SCHEME}:` && parsed.host === HOST ? ID.exec(parsed.pathname) : null;
    const found = match ? documents.get(match[1]) : undefined;
    if (!found) return { status: 404, headers: {}, body: '' };
    if (method !== 'GET') return { status: 405, headers: { allow: 'GET' }, body: '' };
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': cspFor(found.kind),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
      body: found.html,
    };
  }

  return { put, respond };
}

// Must run before the app is ready.
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
}

// Must run once the app is ready.
function installHandler(protocol, store) {
  protocol.handle(SCHEME, request => {
    const reply = store.respond(request.url, request.method);
    return new Response(reply.status === 200 ? reply.body : null, { status: reply.status, headers: reply.headers });
  });
}

module.exports = { SCHEME, cspFor, createArtifactStore, registerScheme, installHandler };
