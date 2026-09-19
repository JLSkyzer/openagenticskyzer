// Shared helpers for tests that drive a real, separately-launched Electron process over
// the Chrome DevTools Protocol (Node's built-in WebSocket, no extra dependency).
const http = require('node:http');
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

async function waitFor(fn, { timeout = 10000, interval = 150 } = {}) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, interval));
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

module.exports = { httpGetJson, waitFor, Cdp };
