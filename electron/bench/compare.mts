// Compares two bench results files: `node --experimental-strip-types bench/compare.mts <avant.json> <après.json>`
// prints the Markdown table (bench/metrics.mts::formatComparison).
import { readFile } from 'node:fs/promises';
import { compareRuns, formatComparison, type BenchRun } from './metrics.mts';

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error('Usage : bench/compare.mts <avant.json> <après.json>');
  process.exit(2);
}
const read = async (path: string): Promise<BenchRun> => JSON.parse(await readFile(path, 'utf8'));
process.stdout.write(formatComparison(compareRuns(await read(before), await read(after))));
