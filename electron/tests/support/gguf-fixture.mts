// Test helper: a copy of a real GGUF whose `<arch>.context_length` (the train context) is overwritten in place.
// The source file is never modified; the copy keeps the exact same size (a uint32 replaced by a uint32).
import { readFile, writeFile } from 'node:fs/promises';

// GGUF value types (spec v3): their fixed sizes in bytes; 8 = string, 9 = array.
const FIXED: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const UINT32 = 4;

export async function withTrainContext(source: string, destination: string, trainContextSize: number): Promise<void> {
  const buffer = await readFile(source);
  if (buffer.toString('latin1', 0, 4) !== 'GGUF') throw new Error('GGUF fixture: magic absent');
  let offset = 8; // magic + version
  offset += 8; // tensor count (uint64)
  const kvCount = Number(buffer.readBigUInt64LE(offset)); offset += 8;
  const readString = () => {
    const length = Number(buffer.readBigUInt64LE(offset)); offset += 8;
    const value = buffer.toString('utf8', offset, offset + length); offset += length;
    return value;
  };
  const skipValue = (type: number) => {
    if (type === 8) { readString(); return; }
    if (type === 9) {
      const itemType = buffer.readUInt32LE(offset); offset += 4;
      const count = Number(buffer.readBigUInt64LE(offset)); offset += 8;
      for (let i = 0; i < count; i++) skipValue(itemType);
      return;
    }
    const size = FIXED[type];
    if (size === undefined) throw new Error(`GGUF fixture: type ${type} inconnu`);
    offset += size;
  };
  let architecture: string | undefined;
  const uint32Offsets = new Map<string, number>();
  for (let i = 0; i < kvCount; i++) {
    const key = readString();
    const type = buffer.readUInt32LE(offset); offset += 4;
    if (key === 'general.architecture' && type === 8) { architecture = readString(); continue; }
    if (type === UINT32) uint32Offsets.set(key, offset);
    skipValue(type);
  }
  const key = `${architecture}.context_length`;
  const at = uint32Offsets.get(key);
  if (at === undefined) throw new Error(`GGUF fixture: ${key} introuvable`);
  const copy = Buffer.from(buffer);
  copy.writeUInt32LE(trainContextSize, at);
  await writeFile(destination, copy);
}
