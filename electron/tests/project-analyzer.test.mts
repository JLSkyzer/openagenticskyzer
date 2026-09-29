import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-analyzer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('scanProject detects languages, a framework, the package manager and CI', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'index.ts'), 'export {};');
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci');

  const { scanProject } = await import('../core/project-analyzer.mts');
  const analysis = await scanProject(root);
  assert.deepEqual(analysis.languages, ['TypeScript']);
  assert.deepEqual(analysis.frameworks, ['React']);
  assert.equal(analysis.packageManager, 'npm');
  assert.equal(analysis.ciCd, 'GitHub Actions');
});

test('scanProject prefers pnpm over npm when both lockfiles are somehow present', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, 'pnpm-lock.yaml'), '');
  const { scanProject } = await import('../core/project-analyzer.mts');
  assert.equal((await scanProject(root)).packageManager, 'pnpm');
});

test('scanProject excludes ignored directories (node_modules, .git) from the scan entirely', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'node_modules', 'somelib'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'somelib', 'index.js'), 'module.exports = {};');
  const { scanProject } = await import('../core/project-analyzer.mts');
  const analysis = await scanProject(root);
  assert.deepEqual(analysis.languages, []);
});

test('scanProject never descends past 3 levels deep', async t => {
  const root = await fixture(t);
  const deep = join(root, 'a', 'b', 'c', 'd');
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'too-deep.py'), '');
  await writeFile(join(root, 'a', 'b', 'c', 'still-depth-3.py'), '');
  const { scanProject } = await import('../core/project-analyzer.mts');
  const analysis = await scanProject(root);
  assert.deepEqual(analysis.languages, ['Python'], 'depth-3 file is seen, depth-4 is not');
});

test('scanProject lists sensitive files separately, and detects the test runner from a directory name', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.env'), 'SECRET=1');
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'app.py'), '');
  const { scanProject } = await import('../core/project-analyzer.mts');
  const analysis = await scanProject(root);
  assert.deepEqual(analysis.sensitiveFiles, ['.env']);
  assert.deepEqual(analysis.entryPoints, ['app.py']);
  assert.equal(analysis.testRunner, 'pytest', 'a "tests" dir + Python source falls back to pytest');
});

test('generateOpenAgentMd includes the sensitive-files warning section only when there are any', async t => {
  const { generateOpenAgentMd } = await import('../core/project-analyzer.mts');
  const withSecrets = generateOpenAgentMd({
    root: '/x', languages: ['Python'], frameworks: [], testRunner: '', packageManager: '', ciCd: '',
    sensitiveFiles: ['.env'], entryPoints: [], structureSummary: '',
  });
  assert.match(withSecrets, /NE PAS MODIFIER/);
  assert.match(withSecrets, /`\.env`/);
  const withoutSecrets = generateOpenAgentMd({
    root: '/x', languages: ['Python'], frameworks: [], testRunner: '', packageManager: '', ciCd: '',
    sensitiveFiles: [], entryPoints: [], structureSummary: '',
  });
  assert.doesNotMatch(withoutSecrets, /NE PAS MODIFIER/);
  assert.match(withoutSecrets, /# OPENAGENT\.md/);
  assert.match(withoutSecrets, /## Notes/);
});

test('initializeProject creates OPENAGENT.md, then refuses to overwrite without permission', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'app.py'), '');
  const { initializeProject } = await import('../core/project-analyzer.mts');

  const created = await initializeProject(root);
  assert.equal(created.success, true);
  assert.match(created.message, /OPENAGENT\.md généré/);
  const content = await readFile(join(root, 'OPENAGENT.md'), 'utf8');
  assert.match(content, /Python/);

  const refused = await initializeProject(root);
  assert.equal(refused.success, false);
  assert.match(refused.message, /existe déjà/);
  // Refusing must never touch the file already on disk.
  assert.equal(await readFile(join(root, 'OPENAGENT.md'), 'utf8'), content);
});

test('initializeProject overwrites atomically when explicitly authorized', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'OPENAGENT.md'), 'ancien contenu à la main');
  await writeFile(join(root, 'index.ts'), '');
  const { initializeProject } = await import('../core/project-analyzer.mts');
  const result = await initializeProject(root, true);
  assert.equal(result.success, true);
  const content = await readFile(join(root, 'OPENAGENT.md'), 'utf8');
  assert.match(content, /TypeScript/);
  assert.doesNotMatch(content, /ancien contenu/);
  // No leftover temp file from the atomic rename.
  const entries = await import('node:fs/promises').then(m => m.readdir(root));
  assert.ok(!entries.some(name => name.startsWith('.openagent-init-')));
});

test('initializeProject rejects a missing/invalid folder without throwing', async t => {
  const root = await fixture(t);
  const { initializeProject } = await import('../core/project-analyzer.mts');
  const result = await initializeProject(join(root, 'does-not-exist'));
  assert.equal(result.success, false);
  assert.match(result.message, /invalide/);
});
