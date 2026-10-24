// The benchmark's scenarios, exact copy (plan 2026-10-25-llm-performance, Task 1):
// - A: four short messages in one conversation, each one's prompt starting with the previous one's (reuse);
// - B: one message that must read a file with a tool and quote the code name it holds (quality gate);
// - C: one short message on a cold engine (« C-froid », fresh data home) and again in a new process on that home
//   (« C-chaud », the remembered layer limit kept).

export const SCENARIO_A: readonly string[] = Object.freeze([
  'Bonjour. En une phrase : à quoi sert un fichier README ?',
  'Et un fichier LICENSE ? Une phrase.',
  'Cite une licence libre, en un mot.',
  'Merci. Résume notre échange en une phrase.',
]);

/** The file B reads, copied from bench/fixtures/ into B's work folder. */
export const SCENARIO_B_FILE = 'note-banc.txt';
/** The code name inside it: the reply must quote it. */
export const SCENARIO_B_SENTINEL = 'HÉRON-42';
export const SCENARIO_B_MESSAGE = `Lis le fichier ${SCENARIO_B_FILE} avec read_file, puis donne-moi le nom de code qu'il contient.`;

export const SCENARIO_C_MESSAGE = 'Bonjour. Réponds en une phrase : qu\'est-ce qu\'un fichier README ?';
