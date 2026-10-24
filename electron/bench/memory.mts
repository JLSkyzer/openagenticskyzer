// A memory sample for the benchmark: the process's resident memory, and its GPU memory as Windows counts it per
// process (the `GPU Process Memory` counters — never the card's global figure, lesson 2026-10-21).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MemorySample } from './metrics.mts';

import { csvFields } from './csv.mts';

/** The dedicated and shared GPU bytes in `typeperf` CSV output: each counter column summed over its instances
 * (one per adapter), from the last sample row; null for a kind no column reports. */
export function parseGpuCounters(typeperfCsv: string): { dedicated: number | null; shared: number | null } {
  const rows = typeperfCsv.split(/\r?\n/).filter(row => row.startsWith('"')).map(csvFields);
  if (rows.length < 2) return { dedicated: null, shared: null };
  const [header, last] = [rows[0], rows.at(-1)!];
  let dedicated: number | null = null;
  let shared: number | null = null;
  for (let i = 1; i < header.length; i++) {
    const value = Number(last[i]);
    if (last[i] === undefined || last[i].trim() === '' || !Number.isFinite(value)) continue;
    if (/dedicated/i.test(header[i])) dedicated = (dedicated ?? 0) + value;
    else if (/shared/i.test(header[i])) shared = (shared ?? 0) + value;
  }
  return { dedicated, shared };
}

/** This process's RSS, and `pid`'s GPU memory (default: this process) from typeperf (10 s at most); the GPU figures
 * are null off Windows or on any failure. */
export async function sampleMemory(pid: number = process.pid): Promise<MemorySample> {
  const rssBytes = process.memoryUsage().rss;
  if (process.platform !== 'win32') return { rssBytes, gpuDedicatedBytes: null, gpuSharedBytes: null };
  try {
    const counter = (name: string) => `\\GPU Process Memory(pid_${pid}*)\\${name}`;
    const { stdout } = await promisify(execFile)('typeperf', [counter('Dedicated Usage'), counter('Shared Usage'), '-sc', '1'], { windowsHide: true, timeout: 10000 });
    const { dedicated, shared } = parseGpuCounters(stdout);
    return { rssBytes, gpuDedicatedBytes: dedicated, gpuSharedBytes: shared };
  } catch {
    return { rssBytes, gpuDedicatedBytes: null, gpuSharedBytes: null };
  }
}
