// Compares two bench results files: `node --experimental-strip-types bench/compare.mts <avant.json> <après.json>`
// prints the Markdown table (bench/metrics.mts::formatComparison), preceded by what makes the two runs not comparable
// (another model, context, backend or cap) and by each run's failures. Exit 1 when they are not comparable.
import { readFile } from 'node:fs/promises';
import { comparability, compareRuns, formatComparison, type BenchRun } from './metrics.mts';

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error('Usage : bench/compare.mts <avant.json> <après.json>');
  process.exit(2);
}
const read = async (path: string): Promise<BenchRun> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    console.error(`Fichier de résultats illisible : ${path} (${error instanceof Error ? error.message : error})`);
    process.exit(2);
  }
};
const [a, b] = [await read(before), await read(after)];
const issues = comparability(a, b);
for (const issue of issues) console.log(`> **Non comparable** : ${issue}`);
for (const [side, run] of [['avant', a], ['après', b]] as const) {
  for (const failure of run.failures ?? []) console.log(`> Échec (${side}) : ${failure}`);
}
if (issues.length || (a.failures?.length ?? 0) || (b.failures?.length ?? 0)) console.log('');
process.stdout.write(formatComparison(compareRuns(a, b)));
process.exit(issues.length ? 1 : 0);
