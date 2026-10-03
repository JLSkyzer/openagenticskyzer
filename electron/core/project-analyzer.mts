import { readdir, readFile, open, unlink, rename, stat } from 'node:fs/promises';
import { join, relative, sep, extname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentTool } from './agent.mts';
import { defineTool } from './tool-kit.mts';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build']);
const TEST_DIR_NAMES = new Set(['tests', 'test', '__tests__', 'spec']);
const MAX_DEPTH = 3;

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  '.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.rb': 'Ruby',
  '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.sh': 'Shell', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
};
const FRAMEWORKS_BY_INDICATOR: Record<string, string> = {
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', nicegui: 'NiceGUI', react: 'React', vue: 'Vue',
  angular: 'Angular', svelte: 'Svelte', next: 'Next.js', express: 'Express', nestjs: 'NestJS',
  rails: 'Rails', spring: 'Spring', laravel: 'Laravel',
};
const PACKAGE_MANAGER_PRIORITY: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['uv.lock', 'uv'], ['poetry.lock', 'poetry'],
  ['Pipfile.lock', 'pipenv'], ['package.json', 'npm'], ['Pipfile', 'pipenv'], ['requirements.txt', 'pip'],
  ['pyproject.toml', 'pip'], ['Cargo.toml', 'cargo'], ['go.mod', 'go modules'], ['Gemfile', 'bundler'],
  ['pom.xml', 'maven'], ['build.gradle', 'gradle'],
];
const TEST_RUNNER_PRIORITY: Array<[string, string]> = [
  ['pytest', 'pytest'], ['unittest', 'unittest'], ['vitest', 'vitest'], ['jest', 'jest'], ['mocha', 'mocha'], ['rspec', 'rspec'],
];
const CI_PATHS: Array<[string, string]> = [
  ['.github/workflows', 'GitHub Actions'], ['.gitlab-ci.yml', 'GitLab CI'], ['Jenkinsfile', 'Jenkins'],
  ['.circleci', 'CircleCI'], ['bitbucket-pipelines.yml', 'Bitbucket Pipelines'], ['.travis.yml', 'Travis CI'],
];
const CONTENT_FILES = new Set([
  'package.json', 'pyproject.toml', 'setup.cfg', 'pytest.ini', 'requirements.txt', 'Pipfile', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle',
]);
const ENTRY_POINT_NAMES = new Set(['main.py', 'app.py', 'index.js', 'index.ts', 'main.ts', 'server.py']);

function isSensitiveFilename(filename: string): boolean {
  return filename === '.env' || filename.startsWith('.env.')
    || ['secrets.json', 'credentials.json', 'private.key', 'id_rsa'].includes(filename)
    || ['.pem', '.p12', '.key'].some(ext => filename.endsWith(ext));
}

async function readTextIfPossible(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}

function detectFrameworks(filename: string, content: string): string[] {
  if (!content) return [];
  const lowered = content.toLowerCase();
  const found: string[] = [];
  for (const [indicator, framework] of Object.entries(FRAMEWORKS_BY_INDICATOR)) {
    const hit = filename === 'package.json'
      ? lowered.includes(`"${indicator}"`) || lowered.includes(`'${indicator}'`)
      : new RegExp(`\\b${indicator}\\b`).test(lowered);
    if (hit) found.push(framework);
  }
  return found;
}

function selectFirstDetected(priority: Array<[string, string]>, detected: Set<string>): string {
  for (const [key, value] of priority) if (detected.has(key)) return value;
  return '';
}

async function topLevelSummary(root: string): Promise<string> {
  let entries: import('node:fs').Dirent[] = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { entries = []; }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !IGNORED_DIRECTORIES.has(entry.name)) dirs.push(entry.name);
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  dirs.sort(); files.sort();
  return `Dossiers: ${dirs.slice(0, 8).join(', ') || 'aucun'}\n`
    + `Fichiers racine: ${files.slice(0, 10).join(', ') || 'aucun'}`;
}

export interface ProjectAnalysis {
  root: string;
  languages: string[];
  frameworks: string[];
  testRunner: string;
  packageManager: string;
  ciCd: string;
  sensitiveFiles: string[];
  entryPoints: string[];
  structureSummary: string;
}

/** Inspects at most MAX_DEPTH nested levels of `root`. Every filesystem operation is best
 * effort — an inaccessible directory or file simply contributes nothing, mirroring
 * project_analyzer.py::_scan_project's onerror=ignore walk. */
export async function scanProject(root: string): Promise<ProjectAnalysis> {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const detectedNames = new Set<string>();
  const testSignals = new Set<string>();
  const sensitiveFiles = new Set<string>();
  const entryPoints = new Set<string>();
  const testDirectories = new Set<string>();

  async function visit(dir: string, depth: number): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    const dirNames = entries.filter(e => e.isDirectory() && !IGNORED_DIRECTORIES.has(e.name)).map(e => e.name).sort();
    const fileNames = entries.filter(e => e.isFile()).map(e => e.name).sort();
    for (const name of fileNames) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      detectedNames.add(name);
      const language = LANGUAGES_BY_EXTENSION[extname(name).toLowerCase()];
      if (language) languages.add(language);
      if (ENTRY_POINT_NAMES.has(name)) entryPoints.add(rel);
      if (isSensitiveFilename(name)) sensitiveFiles.add(rel);
      if (CONTENT_FILES.has(name)) {
        const content = await readTextIfPossible(abs);
        for (const framework of detectFrameworks(name, content)) frameworks.add(framework);
        const lowered = content.toLowerCase();
        for (const [indicator, runner] of TEST_RUNNER_PRIORITY) {
          if (new RegExp(`\\b${indicator}\\b`).test(lowered)) testSignals.add(runner);
        }
      }
    }
    for (const name of dirNames) if (TEST_DIR_NAMES.has(name)) testDirectories.add(name);
    if (depth >= MAX_DEPTH) return;
    for (const name of dirNames) await visit(join(dir, name), depth + 1);
  }
  await visit(root, 0);

  const packageManager = selectFirstDetected(PACKAGE_MANAGER_PRIORITY, detectedNames);
  let testRunner = selectFirstDetected(TEST_RUNNER_PRIORITY, testSignals);
  if (!testRunner && testDirectories.size) {
    if (languages.has('Python')) testRunner = 'pytest';
    else if (languages.has('JavaScript') || languages.has('TypeScript')) testRunner = 'jest';
  }

  let ciCd = '';
  for (const [relPath, name] of CI_PATHS) {
    try { await stat(join(root, relPath)); ciCd = name; break; } catch { /* absent */ }
  }

  return {
    root,
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    testRunner,
    packageManager,
    ciCd,
    sensitiveFiles: [...sensitiveFiles].sort(),
    entryPoints: [...entryPoints].sort(),
    structureSummary: await topLevelSummary(root),
  };
}

const TEST_COMMANDS: Record<string, string> = {
  pytest: 'pytest -v', unittest: 'python -m unittest discover', jest: 'npx jest',
  vitest: 'npx vitest run', mocha: 'npx mocha', rspec: 'bundle exec rspec',
};

/** Generates editable OPENAGENT.md content from a scan — same sections/order as
 * project_instructions.py::generate_openagent_md, read back by core/context.mts unchanged. */
export function generateOpenAgentMd(analysis: ProjectAnalysis): string {
  const lines: string[] = [];
  lines.push("# OPENAGENT.md — Instructions pour l'agent", '');
  lines.push('> Fichier généré automatiquement par OpenAgentic Skyzer. Modifiez selon vos besoins.', '');

  lines.push('## Stack');
  lines.push(`- **Langages :** ${analysis.languages.join(', ') || 'Non détecté'}`);
  if (analysis.frameworks.length) lines.push(`- **Frameworks :** ${analysis.frameworks.join(', ')}`);
  if (analysis.packageManager) lines.push(`- **Gestionnaire de paquets :** ${analysis.packageManager}`);
  if (analysis.ciCd) lines.push(`- **CI/CD :** ${analysis.ciCd}`);
  lines.push('');

  lines.push('## Règles');
  lines.push('- Suis le style de code existant dans le projet.');
  lines.push("- N'installe pas de nouvelles dépendances sans accord explicite.");
  lines.push('- Écris des tests pour tout nouveau code.');
  lines.push('- Commits atomiques avec messages descriptifs.');
  lines.push('');

  if (analysis.sensitiveFiles.length) {
    lines.push('## ⚠️ Fichiers sensibles — NE PAS MODIFIER');
    for (const path of analysis.sensitiveFiles) lines.push(`- \`${path}\``);
    lines.push('');
  }

  if (analysis.testRunner) {
    lines.push('## Tests');
    lines.push(`- **Runner :** \`${analysis.testRunner}\``);
    lines.push(`- **Commande :** \`${TEST_COMMANDS[analysis.testRunner] ?? analysis.testRunner}\``);
    lines.push('- Exécute les tests avant chaque commit.');
    lines.push('');
  }

  if (analysis.structureSummary) {
    lines.push('## Structure', '```', analysis.structureSummary, '```', '');
  }

  if (analysis.entryPoints.length) {
    lines.push("## Points d'entrée");
    for (const entry of analysis.entryPoints) lines.push(`- \`${entry}\``);
    lines.push('');
  }

  lines.push('## Notes');
  lines.push("_À compléter manuellement : architecture spécifique, conventions d'équipe, contraintes métier._");

  return lines.join('\n');
}

export interface ProjectInitResult {
  success: boolean;
  message: string;
}

/**
 * Scans, generates and writes OPENAGENT.md after caller authorization. Existing instructions
 * require explicit `overwrite` and are replaced atomically (temp file + rename); without it,
 * exclusive creation ('wx') both prevents a collision and gives a precise EEXIST signal.
 */
export async function initializeProject(folder: string, overwrite = false): Promise<ProjectInitResult> {
  if (!isAbsolute(folder)) return { success: false, message: 'Dossier absent ou invalide.' };
  try { if (!(await stat(folder)).isDirectory()) return { success: false, message: 'Dossier absent ou invalide.' }; }
  catch { return { success: false, message: 'Dossier absent ou invalide.' }; }

  const target = join(folder, 'OPENAGENT.md');
  const alreadyExists = await stat(target).then(() => true).catch(() => false);
  if (alreadyExists && !overwrite) {
    return { success: false, message: 'OPENAGENT.md existe déjà. Confirmez son écrasement.' };
  }

  const analysis = await scanProject(folder);
  const content = generateOpenAgentMd(analysis);
  try {
    if (overwrite) {
      const temp = join(folder, `.openagent-init-${randomUUID()}.tmp`);
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
      try { await rename(temp, target); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
    } else {
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
    }
  } catch (error: any) {
    if (error?.code === 'EEXIST') return { success: false, message: 'OPENAGENT.md existe déjà. Confirmez son écrasement.' };
    return { success: false, message: `Impossible d'initialiser le dossier : ${error instanceof Error ? error.message : String(error)}` };
  }

  const languages = analysis.languages.join(', ') || 'Non détecté';
  return { success: true, message: `OPENAGENT.md généré dans ${folder} (${languages}).` };
}

/**
 * The agent tool (Python parity: agent.py::analyze_project_and_init). Unlike the Python tool it takes NO
 * folder: it acts on the active project only, the folder the tools are registered for, so the model can
 * never write OPENAGENT.md anywhere else (an extra `folder` key is dropped by the argument validation).
 * initializeProject takes no abort signal: defineTool refuses an already-aborted call, and the scan and
 * the one small write that follow are not interruptible.
 */
export function projectTools(folder: string): AgentTool[] {
  return [defineTool({
    name: 'analyze_project_and_init',
    description: "Analyse le projet actif et ÉCRIT OPENAGENT.md avec les instructions de sa stack. Si OPENAGENT.md existe déjà, demande d'abord à l'utilisateur son accord explicite : n'appelle avec overwrite: true qu'après cet accord. Le nouveau OPENAGENT.md devient prioritaire sur un éventuel CLAUDE.md.",
    category: 'write',
    properties: { overwrite: { type: 'boolean', description: "true pour remplacer un OPENAGENT.md existant (seulement après l'accord explicite de l'utilisateur) ; false par défaut" } },
    execute: async args => (await initializeProject(folder, args.overwrite === true)).message,
  })];
}
