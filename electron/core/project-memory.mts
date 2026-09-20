import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { metadataDirectory } from './json-store.mts';

/** How much of the memory the "🧠 Mémoire projet" window shows. */
export const MEMORY_DISPLAY_LIMIT = 200_000;
// A file bigger than this is only read from its end, whatever it holds.
const FULL_READ_LIMIT = 5_000_000;
const TAIL_BYTES = 1_000_000;

/**
 * Reads the project's persistent memory for display (command_palette.py::_show_memory). Read-only: it
 * neither creates a directory nor writes anything. Facts are appended at the bottom of the file and the
 * engine only injects its end into the prompt, so a long memory is cut to its END and `truncated` says so.
 * A symbolic link is refused: it could make the window show any file of the machine.
 */
export async function readProjectMemory(folder: string): Promise<{ content: string; truncated: boolean }> {
  const file = join(await metadataDirectory(folder), 'memory.md');
  let info;
  try { info = await lstat(file); }
  catch (error: any) { if (error.code === 'ENOENT') return { content: '', truncated: false }; throw error; }
  if (!info.isFile()) throw new Error('Mémoire du projet non régulière : lecture refusée');

  let text: string;
  const handle = await open(file, 'r');
  try {
    const start = info.size > FULL_READ_LIMIT ? info.size - TAIL_BYTES : 0;
    const buffer = Buffer.alloc(Math.min(info.size, info.size > FULL_READ_LIMIT ? TAIL_BYTES : info.size));
    await handle.read(buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
    // Starting in the middle of a multi-byte character leaves one replacement character in front.
    if (start > 0 && text.startsWith('�')) text = text.slice(1);
  } finally { await handle.close(); }
  text = text.replace(/^﻿/, '');
  const truncated = info.size > FULL_READ_LIMIT || text.length > MEMORY_DISPLAY_LIMIT;
  return { content: text.length > MEMORY_DISPLAY_LIMIT ? text.slice(-MEMORY_DISPLAY_LIMIT) : text, truncated };
}
