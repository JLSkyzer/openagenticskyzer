// Shared helpers for tests that drive a real, separately-launched Electron process over
// the Chrome DevTools Protocol (Node's built-in WebSocket, no extra dependency).
const http = require('node:http');
require('./no-onboarding.cjs'); // side effect: see that file
const { spawn } = require('node:child_process');
const { delimiter } = require('node:path');
const { writeFile } = require('node:fs/promises');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
      })
      .on('error', reject);
  });
}

async function waitFor(fn, { timeout = 10000, interval = 150, what = '' } = {}) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(what ? `waitFor timed out: ${what}` : 'waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

// The /json entry of the page whose <title> is `title` (with its webSocketDebuggerUrl), once it has parsed.
async function waitForPage(port, title = 'openagent', timeout = 30000) {
  return waitFor(async () => {
    const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
    return list.find(page => page.type === 'page' && page.title === title) || null;
  }, { timeout, interval: 250, what: `page "${title}" on port ${port}` });
}

// One-shot Runtime.evaluate (awaits promises, returns by value) over a fresh CDP connection.
let nextEvaluateId = 1;
async function cdpEvaluate(webSocketDebuggerUrl, expression) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP connection failed')); });
  const id = nextEvaluateId++;
  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        if (message.error) reject(new Error(message.error.message));
        else if (message.result.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
        else resolve(message.result.result.value);
      };
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    ws.close();
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
    });
    // Without this, a dead renderer/crashed app leaves every in-flight CDP call hanging
    // forever instead of failing — the socket just never delivers a reply.
    const onGone = () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed (renderer likely crashed)'));
      this.pending.clear();
    };
    ws.addEventListener('close', onGone);
    ws.addEventListener('error', onGone);
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async screenshot(file) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(result.data, 'base64'));
  }
  close() { this.ws.close(); }
}

function sanitizedPathWithoutPython() {
  const entries = (process.env.PATH || process.env.Path || '').split(delimiter);
  // Windows also ships a `python.exe`/`python3.exe` App Execution Alias stub under
  // ...\WindowsApps regardless of whether a real interpreter is installed — strip that
  // directory too, or `where python` keeps "succeeding" against a non-interpreter shim.
  return entries.filter(entry => !/python/i.test(entry) && !/\\WindowsApps\\?$/i.test(entry)).join(delimiter);
}

// Strips every Python from PATH, then proves `where python` really fails under it. The
// returned PATH is what the app under test must be launched with.
async function checkPythonAbsent() {
  const sanitizedPath = sanitizedPathWithoutPython();
  const stripped = (process.env.PATH || '').split(delimiter).filter(entry => /python/i.test(entry));
  const lookup = spawn('cmd', ['/c', 'where python || where python3'], { env: { ...process.env, PATH: sanitizedPath } });
  const { code, out } = await new Promise(resolve => {
    let output = '';
    lookup.stdout.on('data', chunk => { output += chunk; });
    lookup.stderr.on('data', chunk => { output += chunk; });
    lookup.on('close', exitCode => resolve({ code: exitCode, out: output }));
  });
  return { sanitizedPath, stripped, whereCode: code, whereOutput: out.trim() };
}

module.exports = { httpGetJson, waitFor, waitForPage, cdpEvaluate, Cdp, checkPythonAbsent };
