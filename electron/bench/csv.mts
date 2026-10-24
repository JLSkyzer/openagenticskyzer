// The quoted CSV rows Windows tools print (tasklist /fo csv, typeperf, the guard's PowerShell): each field in double
// quotes, a quote inside doubled.

/** One row's quoted fields, in order. */
export function csvFields(row: string): string[] {
  return [...row.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"'));
}
