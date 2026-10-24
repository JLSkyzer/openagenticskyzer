// The data folder explains itself. At the worker's start, the folders the user may drop files into (knowledge/,
// tools/) and the turn log's logs/ are created when missing, and LISEZMOI.txt — the one file the app owns there and
// rewrites — says what each entry is. Nothing that exists is ever modified, moved or overwritten, LISEZMOI.txt aside.
// Every entry described below is one the app really reads or writes (checked against the code, 2026-10-22):
// config.json (settings.mts), *.pre-electron.bak (json-store.mts), folders.json (folders.mts), gguf-library.json
// (gguf-library.mts), mcp.json (mcp-config.mts), prompts.json (prompts.mts: read only), trusted-projects.json
// (project-trust.mts), memory.md (memory-tools.mts, context.mts), learnings.jsonl (context.mts: read only),
// estimates.v3.json (offload-estimate.mts), redirect.json (data-home.cjs, data-dir.mts), knowledge/ (knowledge-base.mts),
// tools/ (plugin-loader.mts), cuda-pack/ (cuda-pack.mts), retention-archive/ (cleanup.mts), logs/turns/ (turn-log.mts),
// and per project .openagent/ (json-store.mts::metadataDirectory and the same modules, workspace.mts for trash/,
// semantic-index.mts for index/, conversations.mts for the two history files).
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Created at start when missing. cuda-pack/ is not: it belongs to its installer. */
export const DATA_FOLDERS = ['knowledge', 'tools', 'logs'] as const;
export const README_FILE = 'LISEZMOI.txt';

export const DATA_HOME_ENTRIES: ReadonlyArray<{ name: string; role: string }> = [
  { name: 'config.json', role: 'Les réglages globaux, écrits par l’app quand vous enregistrez les Réglages. Il contient aussi le jeton Hugging Face s’il a été saisi : ne le partagez pas.' },
  { name: '*.pre-electron.bak', role: 'Une copie de sécurité d’un fichier, faite une seule fois, juste avant que cette version de l’app ne le réécrive pour la première fois.' },
  { name: 'folders.json', role: 'Les dossiers de projet ouverts récemment, ceux que montre la barre latérale.' },
  { name: 'gguf-library.json', role: 'La bibliothèque de modèles .gguf : seulement les chemins des fichiers que vous avez ajoutés. Les modèles eux-mêmes ne sont jamais copiés ni déplacés.' },
  { name: 'mcp.json', role: 'Les serveurs MCP globaux, ajoutés dans Réglages › Outils.' },
  { name: 'prompts.json', role: 'Votre bibliothèque de prompts, celle qu’ouvre la touche / dans une zone de saisie vide. L’app ne l’écrit jamais : sans ce fichier, ou s’il est illisible, elle propose ses prompts par défaut.' },
  { name: 'trusted-projects.json', role: 'Vos décisions de confiance, projet par projet : ce qu’un projet peut charger (plugins, serveurs MCP, assouplissements de permission) une fois approuvé.' },
  { name: 'memory.md', role: 'La mémoire globale. Les outils de mémoire de l’agent l’écrivent quand vous le demandez ; elle est relue au début de chaque tour.' },
  { name: 'learnings.jsonl', role: 'Les apprentissages globaux. L’app les lit (seulement les lignes confirmées) mais ne les écrit jamais.' },
  { name: 'estimates.v3.json', role: 'Les dernières estimations de répartition d’un modèle entre la carte graphique et le processeur. C’est un cache : il est recalculé s’il manque.' },
  { name: 'redirect.json', role: 'Présent seulement dans le dossier par défaut (.openagent du dossier utilisateur), quand le dossier de données a été déplacé (Réglages › Général › Répertoire de données) : il indique où se trouvent désormais les données.' },
  { name: 'knowledge/', role: 'La base de connaissances (knowledge.json), alimentée depuis la section « Base de connaissances » de la barre latérale.' },
  { name: 'tools/', role: 'Vos outils : déposez-y des fichiers .mjs (ou .mts) ; ils sont chargés au tour suivant. Les anciens plugins Python (.py) y sont signalés comme non pris en charge, jamais exécutés.' },
  { name: 'cuda-pack/', role: 'Le pack CUDA optionnel, installé et retiré par son installeur (Réglages › Matériel). Ne le modifiez pas à la main.' },
  { name: 'retention-archive/', role: 'Les conversations des projets inutilisés au-delà de la durée de rétention, archivées par date. Elles n’y sont jamais supprimées.' },
  { name: 'logs/turns/', role: 'Le journal des tours : un fichier par jour, gardé 14 jours, pour diagnostiquer un tour lent ou bloqué. Son niveau se règle dans Réglages › Général › « Journal des tours ». Ce n’est pas une sauvegarde : les conversations restent dans chaque projet. Il contient les chemins des dossiers, nom d’utilisateur compris, et les textes des tours : relisez-le avant de le partager.' },
  { name: README_FILE, role: 'Ce fichier.' },
  { name: '<projet>/.openagent/', role: 'Dans chaque dossier de projet : config.json (réglages du projet), conversations.json (l’historique et ses branches ; chat_history.json, celui de l’ancienne version, n’est plus que lu), memory.md et learnings.jsonl (mémoire et apprentissages du projet), index/ (l’index de recherche), trash/ (les fichiers supprimés par l’agent, récupérables) et tools/ (les outils du projet).' },
];

const INTRO = 'Dossier de données d’openagent. Ce fichier est régénéré à chaque démarrage : vos modifications seraient perdues.';

/** One paragraph per entry, `<name> — <role>`, separated by blank lines; os.EOL line ends (Notepad-friendly on Windows). */
export const README_TEXT: string = [INTRO, ...DATA_HOME_ENTRIES.map(({ name, role }) => `${name} — ${role}`)].join(EOL + EOL) + EOL;

/**
 * Creates each of DATA_FOLDERS missing from `dataHome` — one level, never through a link: an entry of that name,
 * whatever it is (a folder, a file, a link or a junction), is left as it is. Returns the names it created.
 */
export async function ensureDataFolders(dataHome: string): Promise<string[]> {
  await mkdir(dataHome, { recursive: true });
  const created: string[] = [];
  for (const name of DATA_FOLDERS) {
    try {
      await mkdir(join(dataHome, name));
      created.push(name);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return created;
}

/** Writes README_TEXT to `<dataHome>/LISEZMOI.txt` through a temp file renamed over it: never half-written. */
export async function writeReadme(dataHome: string): Promise<void> {
  const file = join(dataHome, README_FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, README_TEXT, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}
