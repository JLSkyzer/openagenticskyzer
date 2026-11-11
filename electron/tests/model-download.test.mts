// The download manager against the local fake Hugging Face (tests/support/fake-hf.mts): no test reaches the network,
// every home is a temp folder, and the free space is always injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelDownloads, sha256File, HASH_MISMATCH, NOT_ENOUGH_DISK, MODEL_DISK_MARGIN_BYTES, DISK_FULL, MODELS_DIR_GONE,
  NO_HASH, FILE_EXISTS, FILE_BUSY, NETWORK_FAILED, ACCESS_DENIED, URL_REFUSED,
  type DownloadJob,
} from '../core/model-download.mts';
import type { ModelVariant } from '../core/hf-catalogue.mts';
import { startFakeHf } from './support/fake-hf.mts';
import { removeAtEnd, terminateAtEnd } from './teardown.mts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const REPO = 'owner/name';
const KB = 1024;
const TERMINAL = ['done', 'error', 'cancelled'];

function variantOf(name: string, ...files: [string, Uint8Array][]): ModelVariant {
  const entries = files.map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) }));
  return { name, files: entries, totalBytes: entries.reduce((sum, f) => sum + f.size, 0) };
}

async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : -1);

async function bench(t: Parameters<typeof removeAtEnd>[0]) {
  const hf = await startFakeHf();
  const home = await mkdtemp(join(tmpdir(), 'oa-model-download-'));
  const dir = join(home, 'models');
  await mkdir(dir);
  const managers: ModelDownloads[] = [];
  removeAtEnd(t, home);
  terminateAtEnd(t, { terminate: async () => { await Promise.allSettled(managers.map(m => m.close())); await hf.close(); } });

  function open(options: Partial<ConstructorParameters<typeof ModelDownloads>[0]> = {}) {
    const done: DownloadJob[] = [];
    const changes: DownloadJob[] = [];
    const manager = new ModelDownloads({
      home,
      baseUrl: hf.baseUrl,
      freeBytes: async () => 1e15,
      retryDelaysMs: [5, 5, 5],
      onChange: job => { changes.push(job); },
      onDone: async job => { done.push(job); },
      ...options,
    });
    managers.push(manager);
    const job = (id: string) => manager.list().find(j => j.id === id)!;
    const settled = async (id: string) => {
      await until(`job ${id} to end`, () => TERMINAL.includes(job(id)?.state));
      return job(id);
    };
    return { manager, done, changes, job, settled };
  }

  const resolveHits = () => hf.hits.filter(h => h.path.includes('/resolve/') || h.path.startsWith('/blob/'));
  return { hf, home, dir, open, resolveHits, store: join(home, 'model-downloads.json') };
}

test('a two-part variant is downloaded, verified, renamed and reported once', async t => {
  const b = await bench(t);
  const one = randomBytes(300 * KB);
  const two = randomBytes(120 * KB);
  b.hf.setFile(`${REPO}/m-00001-of-00002.gguf`, one);
  b.hf.setFile(`${REPO}/m-00002-of-00002.gguf`, two);
  const { manager, done, changes, settled } = b.open({ freeBytes: undefined as never, token: async () => undefined });
  // freeBytes left to its default here: the one test that also exercises the real statfs.
  const added = await manager.add(REPO, variantOf('m', ['m-00001-of-00002.gguf', one], ['m-00002-of-00002.gguf', two]), b.dir);
  assert.equal(added.state, 'queued');
  assert.equal(added.totalBytes, one.length + two.length);
  const job = await settled(added.id);

  assert.equal(job.state, 'done', job.error ?? '');
  assert.equal(job.error, null);
  assert.equal(job.receivedBytes, job.totalBytes);
  assert.equal(job.bytesPerSecond, null);
  assert.equal(job.finalPath, join(b.dir, 'm-00001-of-00002.gguf'));
  assert.deepEqual(await readFile(join(b.dir, 'm-00001-of-00002.gguf')), one);
  assert.deepEqual(await readFile(join(b.dir, 'm-00002-of-00002.gguf')), two);
  assert.equal(existsSync(join(b.dir, 'm-00001-of-00002.gguf.part')), false);
  assert.equal(existsSync(join(b.dir, 'm-00002-of-00002.gguf.part')), false);
  assert.equal(done.length, 1);
  assert.equal(done[0].state, 'done');
  assert.equal(done[0].finalPath, job.finalPath);
  assert.deepEqual([...new Set(changes.map(c => c.state))], ['queued', 'downloading', 'verifying', 'done']);
  await manager.close();
  const saved = JSON.parse(await readFile(b.store, 'utf8'));
  assert.equal(saved.jobs[0].state, 'done');
  assert.deepEqual(saved.parts, {}, 'no record of a .part that no longer exists');
});

test('Review Focus 1: the token goes to huggingface, never across a redirect to another host', async t => {
  const b = await bench(t);
  const bytes = randomBytes(40 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { redirect: 'other-port' });
  const { manager, settled } = b.open({ token: async () => 'hf_secret_value' });
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
  const hits = b.resolveHits();
  assert.equal(hits.length, 2);
  assert.match(hits[0].path, /\/resolve\/main\/a\.gguf$/);
  assert.equal(hits[0].authorization, 'Bearer hf_secret_value');
  assert.match(hits[1].path, /^\/blob\//);
  assert.equal(hits[1].authorization, undefined);
  assert.equal(hits[0].userAgent, 'openagent');
  assert.equal((await readFile(b.store, 'utf8')).includes('hf_secret_value'), false, 'the token is never persisted');
});

test('a relative redirect stays on the host, so it keeps the token', async t => {
  const b = await bench(t);
  const bytes = randomBytes(10 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { redirect: 'relative' });
  const { manager, settled } = b.open({ token: async () => 'hf_secret_value' });
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
  const hits = b.hf.hits.filter(h => h.path.includes('a.gguf'));
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(h => h.authorization), ['Bearer hf_secret_value', 'Bearer hf_secret_value']);
});

test('a connection cut mid-stream is retried with the right Range and the file is byte-exact', async t => {
  const b = await bench(t);
  const bytes = randomBytes(200 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { cutAfter: 70 * KB, redirect: 'none' });
  const { manager, done, settled } = b.open();
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined, `bytes=${70 * KB}-`]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), bytes);
  assert.equal(done.length, 1);
});

test('close() during a download, then a new manager and resume() finishes it from where it stopped', async t => {
  const b = await bench(t);
  const bytes = randomBytes(150 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { holdAfter: 60 * KB, redirect: 'none' });
  const first = b.open();
  const added = await first.manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir);
  await until('the first bytes on disk', () => sizeOf(join(b.dir, 'a.gguf.part')) === 60 * KB);
  await first.manager.close();
  assert.equal(sizeOf(join(b.dir, 'a.gguf.part')), 60 * KB, 'close keeps the .part');
  assert.equal(first.done.length, 0);
  assert.equal(JSON.parse(await readFile(b.store, 'utf8')).jobs[0].state, 'downloading');

  const second = b.open();
  await second.manager.resume();
  const job = await second.settled(added.id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined, `bytes=${60 * KB}-`]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), bytes);
  assert.equal(second.done.length, 1);
});

test('a wrong hash: error, HASH_MISMATCH, no final file, no .part, onDone not called', async t => {
  const b = await bench(t);
  const bytes = randomBytes(30 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes);
  const { manager, done, settled } = b.open();
  const variant = variantOf('a', ['a.gguf', bytes]);
  variant.files[0].sha256 = 'a'.repeat(64);
  const job = await settled((await manager.add(REPO, variant, b.dir)).id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, HASH_MISMATCH);
  assert.equal(job.finalPath, null);
  assert.equal(existsSync(join(b.dir, 'a.gguf')), false);
  assert.equal(existsSync(join(b.dir, 'a.gguf.part')), false);
  assert.equal(done.length, 0);
});

test('a split model appears under its final names only when every part is verified', async t => {
  const b = await bench(t);
  const one = randomBytes(20 * KB);
  const two = randomBytes(20 * KB);
  b.hf.setFile(`${REPO}/m-00001-of-00002.gguf`, one);
  b.hf.setFile(`${REPO}/m-00002-of-00002.gguf`, two);
  const { manager, done, settled } = b.open();
  const variant = variantOf('m', ['m-00001-of-00002.gguf', one], ['m-00002-of-00002.gguf', two]);
  variant.files[1].sha256 = 'b'.repeat(64);
  const job = await settled((await manager.add(REPO, variant, b.dir)).id);
  assert.equal(job.error, HASH_MISMATCH);
  assert.equal(existsSync(join(b.dir, 'm-00001-of-00002.gguf')), false, 'the good part is not exposed alone');
  assert.equal(existsSync(join(b.dir, 'm-00002-of-00002.gguf')), false);
  assert.equal(done.length, 0);
});

test('free space below the need: NOT_ENOUGH_DISK before any request, exactly the need goes through', async t => {
  const b = await bench(t);
  const bytes = randomBytes(10 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes);
  const need = bytes.length + MODEL_DISK_MARGIN_BYTES;
  const asked: string[] = [];
  const short = b.open({ freeBytes: async dir => { asked.push(dir); return need - 1; } });
  const refused = await short.settled((await short.manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(refused.state, 'error');
  assert.equal(refused.error, NOT_ENOUGH_DISK);
  assert.equal(b.resolveHits().length, 0);
  assert.deepEqual(asked, [b.dir]);
  await short.manager.close();

  const enough = b.open({ freeBytes: async () => need });
  const job = await enough.settled((await enough.manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
});

test('on a resume only what is still to come needs disk space: the .part already holds the rest', async t => {
  const b = await bench(t);
  const bytes = randomBytes(100 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { holdAfter: 40 * KB, redirect: 'none' });
  const first = b.open();
  const added = await first.manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir);
  await until('the first bytes on disk', () => sizeOf(join(b.dir, 'a.gguf.part')) === 40 * KB);
  await first.manager.close();

  const second = b.open({ freeBytes: async () => 60 * KB + MODEL_DISK_MARGIN_BYTES });
  await second.manager.resume();
  const job = await second.settled(added.id);
  assert.equal(job.state, 'done', job.error ?? '');
});

test('Review Focus 2: ENOSPC while writing ends the job in French, nothing is final, the next job still starts', async t => {
  const b = await bench(t);
  const one = randomBytes(30 * KB);
  const two = randomBytes(30 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, one);
  b.hf.setFile(`${REPO}/b.gguf`, two);
  let failed = false;
  const { manager, done, settled } = b.open({
    writeChunk: async (handle, chunk) => {
      if (!failed) { failed = true; throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); }
      await handle.write(chunk);
    },
  });
  const a = await manager.add(REPO, variantOf('a', ['a.gguf', one]), b.dir);
  const c = await manager.add(REPO, variantOf('b', ['b.gguf', two]), b.dir);
  const refused = await settled(a.id);
  assert.equal(refused.state, 'error');
  assert.equal(refused.error, DISK_FULL);
  assert.match(DISK_FULL, /^Le disque est plein/);
  assert.equal(existsSync(join(b.dir, 'a.gguf')), false);
  assert.equal(b.resolveHits().filter(h => h.path.includes('a.gguf') && h.path.includes('/resolve/')).length, 1, 'a full disk is not retried');
  const next = await settled(c.id);
  assert.equal(next.state, 'done', next.error ?? '');
  assert.deepEqual(done.map(j => j.id), [c.id]);
});

test('Review Focus 4: a pending job whose folder is gone goes to error on resume, and the folder is not recreated', async t => {
  const b = await bench(t);
  const bytes = randomBytes(50 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { holdAfter: 10 * KB, redirect: 'none' });
  const first = b.open();
  const added = await first.manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir);
  await until('the first bytes on disk', () => sizeOf(join(b.dir, 'a.gguf.part')) === 10 * KB);
  await first.manager.close();
  await rm(b.dir, { recursive: true });
  const before = b.resolveHits().length;

  const second = b.open();
  await second.manager.resume();
  const job = second.job(added.id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, MODELS_DIR_GONE);
  assert.equal(existsSync(b.dir), false);
  assert.equal(b.resolveHits().length, before, 'no request for it');
  assert.equal(second.changes.at(-1)?.state, 'error', 'the error is announced');
  assert.equal(second.done.length, 0);
});

test('cancel during a download removes the .part, ends in cancelled and starts the next', async t => {
  const b = await bench(t);
  const one = randomBytes(40 * KB);
  const two = randomBytes(10 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, one, { holdAfter: 15 * KB, redirect: 'none' });
  b.hf.setFile(`${REPO}/b.gguf`, two, { redirect: 'none' });
  const { manager, done, job, settled } = b.open();
  const a = await manager.add(REPO, variantOf('a', ['a.gguf', one]), b.dir);
  const c = await manager.add(REPO, variantOf('b', ['b.gguf', two]), b.dir);
  await until('the first bytes on disk', () => sizeOf(join(b.dir, 'a.gguf.part')) === 15 * KB);
  assert.equal(job(c.id).state, 'queued', 'a second add waits: one download at a time');
  assert.equal(b.resolveHits().some(h => h.path.includes('b.gguf')), false);

  await manager.cancel(a.id);
  assert.equal(job(a.id).state, 'cancelled');
  assert.equal(job(a.id).error, null);
  assert.equal(existsSync(join(b.dir, 'a.gguf.part')), false);
  const next = await settled(c.id);
  assert.equal(next.state, 'done', next.error ?? '');
  assert.deepEqual(done.map(d => d.id), [c.id]);
});

test('cancelling a queued job never requests it, and cancelling a job in error clears its .part', async t => {
  const b = await bench(t);
  const one = randomBytes(30 * KB);
  const two = randomBytes(10 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, one, { cutAfter: 10 * KB, redirect: 'none' });
  b.hf.setFile(`${REPO}/b.gguf`, two, { redirect: 'none' });
  let writes = 0;
  const { manager, job, settled } = b.open({
    writeChunk: async (handle, chunk) => {
      writes++;
      if (writes > 1) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      await handle.write(chunk);
    },
  });
  const a = await manager.add(REPO, variantOf('a', ['a.gguf', one]), b.dir);
  const queued = await manager.add(REPO, variantOf('b', ['b.gguf', two]), b.dir);
  await manager.cancel(queued.id);
  assert.equal(job(queued.id).state, 'cancelled');
  const failed = await settled(a.id);
  assert.equal(failed.state, 'error');
  assert.equal(b.resolveHits().some(h => h.path.includes('b.gguf')), false);
  assert.equal(existsSync(join(b.dir, 'a.gguf.part')), true, 'an error keeps the .part for a later try');
  await manager.cancel(a.id);
  assert.equal(job(a.id).state, 'cancelled');
  assert.equal(existsSync(join(b.dir, 'a.gguf.part')), false);
});

test('a server that answers 200 to a Range restarts at zero, and nothing is appended', async t => {
  const b = await bench(t);
  const bytes = randomBytes(90 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { ranges: false, cutAfter: 30 * KB, redirect: 'none' });
  const { manager, settled } = b.open();
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined, `bytes=${30 * KB}-`]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), bytes);
});

async function closedMidway(b: Awaited<ReturnType<typeof bench>>, bytes: Uint8Array, at: number) {
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { holdAfter: at, redirect: 'none' });
  const first = b.open();
  const added = await first.manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir);
  await until('the first bytes on disk', () => sizeOf(join(b.dir, 'a.gguf.part')) === at);
  await first.manager.close();
  return added;
}

test('a change of the expected hash in the job restarts at zero', async t => {
  const b = await bench(t);
  const old = randomBytes(60 * KB);
  const added = await closedMidway(b, old, 20 * KB);
  const fresh = randomBytes(60 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, fresh, { redirect: 'none' });
  const saved = JSON.parse(await readFile(b.store, 'utf8'));
  saved.jobs[0].files[0].sha256 = sha(fresh);
  await writeFile(b.store, JSON.stringify(saved));

  const second = b.open();
  await second.manager.resume();
  const job = await second.settled(added.id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined, undefined]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), fresh);
});

test('a change of the expected size in the job restarts at zero', async t => {
  const b = await bench(t);
  const added = await closedMidway(b, randomBytes(60 * KB), 20 * KB);
  const fresh = randomBytes(80 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, fresh, { redirect: 'none' });
  const saved = JSON.parse(await readFile(b.store, 'utf8'));
  saved.jobs[0].files[0] = { path: 'a.gguf', size: fresh.length, sha256: sha(fresh) };
  await writeFile(b.store, JSON.stringify(saved));

  const second = b.open();
  await second.manager.resume();
  const job = await second.settled(added.id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.equal(job.totalBytes, fresh.length, 'the total follows the files');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined, undefined]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), fresh);
});

test('a .part larger than expected restarts at zero', async t => {
  const b = await bench(t);
  const bytes = randomBytes(40 * KB);
  const added = await closedMidway(b, bytes, 10 * KB);
  await appendFile(join(b.dir, 'a.gguf.part'), randomBytes(50 * KB));
  const second = b.open();
  await second.manager.resume();
  const job = await second.settled(added.id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined, undefined]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), bytes);
});

test('a .part that is complete is verified without another request', async t => {
  const b = await bench(t);
  const bytes = randomBytes(40 * KB);
  const added = await closedMidway(b, bytes, 10 * KB);
  await writeFile(join(b.dir, 'a.gguf.part'), bytes);
  const before = b.resolveHits().length;
  const second = b.open();
  await second.manager.resume();
  const job = await second.settled(added.id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.equal(b.resolveHits().length, before);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), bytes);
});

test('a .part from nobody knows where is not trusted: the download starts at zero', async t => {
  const b = await bench(t);
  const bytes = randomBytes(20 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { redirect: 'none' });
  await writeFile(join(b.dir, 'a.gguf.part'), randomBytes(5 * KB));
  const { manager, settled } = b.open();
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), bytes);
});

test('a crash between two renames: the part already final is checked, not fetched again', async t => {
  const b = await bench(t);
  const one = randomBytes(20 * KB);
  const two = randomBytes(30 * KB);
  b.hf.setFile(`${REPO}/m-00001-of-00002.gguf`, one, { redirect: 'none' });
  b.hf.setFile(`${REPO}/m-00002-of-00002.gguf`, two, { holdAfter: 5 * KB, redirect: 'none' });
  const first = b.open();
  const added = await first.manager.add(REPO, variantOf('m', ['m-00001-of-00002.gguf', one], ['m-00002-of-00002.gguf', two]), b.dir);
  await until('the second part on disk', () => sizeOf(join(b.dir, 'm-00002-of-00002.gguf.part')) === 5 * KB);
  await first.manager.close();
  // What a crash just after the first rename leaves behind.
  await writeFile(join(b.dir, 'm-00001-of-00002.gguf'), one);
  await rm(join(b.dir, 'm-00001-of-00002.gguf.part'));

  const before = b.resolveHits().length;
  const second = b.open();
  await second.manager.resume();
  const job = await second.settled(added.id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().slice(before).map(h => h.path.includes('00002')), [true]);
  assert.deepEqual(await readFile(join(b.dir, 'm-00002-of-00002.gguf')), two);
  assert.equal(second.done.length, 1);
});

test('another file already under the final name is never overwritten', async t => {
  const b = await bench(t);
  const bytes = randomBytes(10 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes);
  const mine = randomBytes(10 * KB); // same size, other content: only the hash can tell
  await writeFile(join(b.dir, 'a.gguf'), mine);
  const { manager, done, settled } = b.open();
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, FILE_EXISTS);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), mine);
  assert.equal(done.length, 0);
  assert.equal(b.resolveHits().length, 0);
});

test('network failures that make no progress end in a French error, keep the .part, and the next job starts', async t => {
  const b = await bench(t);
  const one = randomBytes(20 * KB);
  const two = randomBytes(5 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, one, { cutAfter: 0, cutTimes: 100, redirect: 'none' });
  b.hf.setFile(`${REPO}/b.gguf`, two, { redirect: 'none' });
  const { manager, settled } = b.open();
  const a = await manager.add(REPO, variantOf('a', ['a.gguf', one]), b.dir);
  const c = await manager.add(REPO, variantOf('b', ['b.gguf', two]), b.dir);
  const failed = await settled(a.id);
  assert.equal(failed.state, 'error');
  assert.equal(failed.error, NETWORK_FAILED);
  assert.equal(b.resolveHits().filter(h => h.path.includes('a.gguf')).length, 4, 'one try and three retries');
  assert.equal((await settled(c.id)).state, 'done');
});

test('a server that stops sending is treated as a cut: the download resumes after the idle limit', async t => {
  const b = await bench(t);
  const bytes = randomBytes(60 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { holdAfter: 25 * KB, redirect: 'none' });
  const { manager, settled } = b.open({ idleTimeoutMs: 150 });
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(b.resolveHits().map(h => h.range), [undefined, `bytes=${25 * KB}-`]);
  assert.deepEqual(await readFile(join(b.dir, 'a.gguf')), bytes);
});

test('a refused access is final at once, with no retry', async t => {
  const b = await bench(t);
  const bytes = randomBytes(5 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { status: 403 });
  const { manager, settled } = b.open();
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, ACCESS_DENIED);
  assert.equal(b.resolveHits().length, 1);
});

test('at most five redirects are followed', async t => {
  const b = await bench(t);
  const bytes = randomBytes(5 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { location: `/${REPO}/resolve/main/a.gguf` });
  const { manager, settled } = b.open();
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, URL_REFUSED);
  assert.equal(b.resolveHits().length, 6, 'the first request and five redirects');
});

test('a redirect to plain http outside the loopback seam is refused without being requested', async t => {
  const b = await bench(t);
  const bytes = randomBytes(5 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { location: 'http://cdn.example.invalid/a.gguf' });
  const { manager, settled } = b.open({ retryDelaysMs: [60_000] });
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, URL_REFUSED);
});

test('progress is reported at most four times a second, with a speed', async t => {
  const b = await bench(t);
  const bytes = randomBytes(4096 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { redirect: 'none' });
  const stamps: { at: number; job: DownloadJob }[] = [];
  let chunks = 0;
  const { manager, settled } = b.open({
    onChange: job => { stamps.push({ at: performance.now(), job }); },
    writeChunk: async (handle, chunk) => {
      chunks++;
      await new Promise(resolve => setTimeout(resolve, 15));
      await handle.write(chunk);
    },
  });
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
  const progress = stamps.filter(s => s.job.state === 'downloading' && s.job.receivedBytes > 0);
  assert.ok(progress.length >= 2, `only ${progress.length} progress events`);
  assert.ok(chunks > progress.length * 2, `${chunks} chunks for ${progress.length} events: nothing was throttled`);
  for (let i = 1; i < progress.length; i++) {
    const gap = progress[i].at - progress[i - 1].at;
    assert.ok(gap >= 200, `two progress events ${gap} ms apart`);
  }
  assert.ok(progress.every(s => (s.job.bytesPerSecond ?? 0) > 0), 'every progress event carries a speed');
  assert.ok(progress[1].job.receivedBytes > progress[0].job.receivedBytes);
});

test('an install that onDone refuses ends in error, in French, with the file kept', async t => {
  const b = await bench(t);
  const bytes = randomBytes(5 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes);
  const { manager, settled } = b.open({ onDone: async () => { throw new Error('bibliothèque illisible'); } });
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'error');
  assert.equal(job.error, "Le modèle est téléchargé et vérifié, mais son ajout a échoué : bibliothèque illisible");
  assert.equal(existsSync(join(b.dir, 'a.gguf')), true);
});

test('add refuses what cannot be installed safely, before creating anything', async t => {
  const b = await bench(t);
  const { manager } = b.open();
  const good = randomBytes(1 * KB);
  const missingHash = variantOf('a', ['a.gguf', good]);
  missingHash.files[0].sha256 = null;
  await assert.rejects(manager.add(REPO, missingHash, b.dir), { message: NO_HASH });
  await assert.rejects(manager.add(REPO, variantOf('a', ['../evil.gguf', good]), b.dir), { message: 'Nom de fichier refusé' });
  await assert.rejects(manager.add(REPO, variantOf('a', ['a.exe', good]), b.dir), { message: 'Nom de fichier refusé' });
  await assert.rejects(manager.add('owner/..', variantOf('a', ['a.gguf', good]), b.dir), /Dépôt refusé/);
  await assert.rejects(manager.add(REPO, variantOf('a', ['x/a.gguf', good], ['y/a.gguf', good]), b.dir), { message: 'Nom de fichier refusé' });
  assert.deepEqual(manager.list(), []);
});

test('adding the same variant twice gives the same job; another model on the same file is refused', async t => {
  const b = await bench(t);
  const bytes = randomBytes(20 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { holdAfter: 5 * KB, redirect: 'none' });
  const { manager } = b.open();
  const variant = variantOf('a', ['a.gguf', bytes]);
  const first = await manager.add(REPO, variant, b.dir);
  const again = await manager.add(REPO, variant, b.dir);
  assert.equal(again.id, first.id);
  assert.equal(manager.list().length, 1);
  await assert.rejects(manager.add('other/repo', variant, b.dir), { message: FILE_BUSY });
});

test('adding again after an error replaces the old line and resumes its .part', async t => {
  const b = await bench(t);
  const bytes = randomBytes(30 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { redirect: 'none', holdAfter: 12 * KB });
  const { manager, job, settled } = b.open({ idleTimeoutMs: 60, retryDelaysMs: [] });
  const variant = variantOf('a', ['a.gguf', bytes]);
  const first = await manager.add(REPO, variant, b.dir);
  const failed = await settled(first.id);
  assert.equal(failed.error, NETWORK_FAILED);
  assert.equal(sizeOf(join(b.dir, 'a.gguf.part')), 12 * KB);

  const second = await manager.add(REPO, variant, b.dir);
  assert.notEqual(second.id, first.id);
  assert.equal(job(first.id), undefined, 'the old line is replaced');
  const done = await settled(second.id);
  assert.equal(done.state, 'done', done.error ?? '');
  assert.equal(b.resolveHits().at(-1)?.range, `bytes=${12 * KB}-`);
});

test('after a restart the finished lines are gone, the failed one stays so its .part can be cleared', async t => {
  const b = await bench(t);
  const good = randomBytes(5 * KB);
  const bad = randomBytes(5 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, good);
  b.hf.setFile(`${REPO}/b.gguf`, bad, { status: 403 });
  const first = b.open();
  const a = await first.manager.add(REPO, variantOf('a', ['a.gguf', good]), b.dir);
  const c = await first.manager.add(REPO, variantOf('b', ['b.gguf', bad]), b.dir);
  await first.settled(a.id);
  await first.settled(c.id);
  await first.manager.close();

  const second = b.open();
  await second.manager.resume();
  assert.deepEqual(second.manager.list().map(j => j.id), [c.id]);
  assert.equal(second.manager.list()[0].error, ACCESS_DENIED);
});

test('resume is safe on an absent store, and add works without an explicit resume', async t => {
  const b = await bench(t);
  const { manager, settled } = b.open();
  await manager.resume();
  await manager.resume();
  assert.deepEqual(manager.list(), []);
  const bytes = randomBytes(2 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes);
  const job = await settled((await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir)).id);
  assert.equal(job.state, 'done', job.error ?? '');
});

test('a returned job is a copy: changing it does not change the queue', async t => {
  const b = await bench(t);
  const bytes = randomBytes(2 * KB);
  b.hf.setFile(`${REPO}/a.gguf`, bytes, { holdAfter: 1 * KB, redirect: 'none' });
  const { manager, job } = b.open();
  const added = await manager.add(REPO, variantOf('a', ['a.gguf', bytes]), b.dir);
  added.files[0].sha256 = 'tampered';
  manager.list()[0].dir = 'elsewhere';
  assert.equal(job(added.id).files[0].sha256, sha(bytes));
  assert.equal(job(added.id).dir, b.dir);
});

test('sha256File hashes in a worker, says so for a missing file, and stops on abort', async t => {
  const b = await bench(t);
  const path = join(b.home, 'blob.bin');
  const bytes = randomBytes(9 * KB * KB);
  await writeFile(path, bytes);
  assert.equal(await sha256File(path), sha(bytes));
  await assert.rejects(sha256File(join(b.home, 'absent.bin')));

  const already = new AbortController();
  already.abort();
  await assert.rejects(sha256File(path, already.signal), { name: 'AbortError' });

  const late = new AbortController();
  const running = sha256File(path, late.signal);
  late.abort();
  await assert.rejects(running, { name: 'AbortError' });
});
