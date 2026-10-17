import { test } from 'node:test';
import assert from 'node:assert/strict';
// Runs under plain Node (no Electron): require('electron') resolves to a path string
// outside a real Electron process, so the app/ipcMain-dependent code in main.cjs must
// stay behind the `require.main === module` guard for this import to be side-effect-free.
import mainModule from '../main.cjs';
const { buildCsp, chooseLoadTarget } = mainModule as any;

test('a packaged build never relaxes the CSP for Vite HMR', () => {
  const prod = buildCsp(true);
  assert.ok(!prod.includes('unsafe-eval'), 'no unsafe-eval in a packaged CSP');
  assert.ok(!prod.includes('5173'), 'no dev server origin in a packaged CSP');
  assert.match(prod, /default-src 'self'/);
  assert.match(prod, /object-src 'none'/);
});

test('only the artifact preview scheme may be framed, in a packaged build as in dev — and it is not a way to loosen scripts', () => {
  for (const csp of [buildCsp(true), buildCsp(false)]) {
    assert.match(csp, /frame-src oa-artifact:(;|$)/);
    assert.doesNotMatch(csp, /frame-src[^;]*(https?:|\*|'self')/, 'no web page, no same-origin frame');
  }
  assert.doesNotMatch(buildCsp(true), /script-src[^;]*unsafe-inline/, 'the app itself still forbids inline script');
});

test('the unpackaged dev CSP allows the Vite dev server, still scoped otherwise', () => {
  const dev = buildCsp(false);
  assert.ok(dev.includes('unsafe-eval'));
  assert.ok(dev.includes('ws://localhost:5173'));
  assert.match(dev, /default-src 'self'/);
});

test('the page reaches no network origin: connect-src is the app itself when packaged, plus only the Vite dev server in dev', () => {
  // The renderer makes no request of its own (no fetch, WebSocket or EventSource in renderer-src/src): the model runs
  // in the worker, the web tools too. Nothing remote is ever allowed to the page.
  assert.match(buildCsp(true), /connect-src 'self';/);
  assert.doesNotMatch(buildCsp(true), /https?:/);
  assert.doesNotMatch(buildCsp(false), /https:/);
  assert.match(buildCsp(false), /connect-src 'self' ws:\/\/localhost:5173 http:\/\/localhost:5173;/);
});

test('the load target is the packaged build unless explicitly unpackaged with the dev flag set', () => {
  assert.equal(chooseLoadTarget({ isPackaged: true, devFlag: '1' }).mode, 'file');
  assert.equal(chooseLoadTarget({ isPackaged: false, devFlag: undefined }).mode, 'file');
  assert.equal(chooseLoadTarget({ isPackaged: false, devFlag: '0' }).mode, 'file');
  const dev = chooseLoadTarget({ isPackaged: false, devFlag: '1' });
  assert.equal(dev.mode, 'url');
  assert.equal(dev.target, 'http://localhost:5173');
});
