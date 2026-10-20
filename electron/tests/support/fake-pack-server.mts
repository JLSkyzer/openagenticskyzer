// A local stand-in for the release host of the CUDA pack (hardware and offload, Task 9). It serves the parts of a
// synthetic pack from `dir` on 127.0.0.1 only: no test ever reaches GitHub, NVIDIA or the network.
//   bytesPerTick: throttles a part to one write of that many bytes every 50 ms (for cancel tests);
//   tamper:       the name of a part served with one byte flipped;
//   redirectTo:   every request is answered 302 with this Location (absolute, or relative to the request);
//   stallAfter:   sends that many bytes of each part, then nothing more, the connection held open (idle tests).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

export async function startFakePackServer(dir: string, options: { bytesPerTick?: number; tamper?: string; redirectTo?: string; stallAfter?: number } = {}): Promise<{ url: string; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
    requests.push(name);
    if (options.redirectTo !== undefined) {
      res.writeHead(302, { location: options.redirectTo });
      res.end();
      return;
    }
    // Only plain file names of `dir`: no folder, no traversal.
    if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); res.end(); return; }
    let bytes: Buffer;
    try { bytes = await readFile(join(dir, name)); } catch { res.writeHead(404); res.end(); return; }
    if (name === options.tamper) {
      bytes = Buffer.from(bytes);
      bytes[bytes.length >> 1] ^= 0xff;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    if (options.stallAfter !== undefined) { res.write(bytes.subarray(0, options.stallAfter)); return; }
    const step = options.bytesPerTick;
    if (!step) { res.end(bytes); return; }
    let offset = 0;
    const tick = () => {
      if (res.destroyed) return;
      res.write(bytes.subarray(offset, offset + step));
      offset += step;
      if (offset >= bytes.length) { res.end(); return; }
      const timer = setTimeout(() => { timers.delete(timer); tick(); }, 50);
      timers.add(timer);
    };
    tick();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
