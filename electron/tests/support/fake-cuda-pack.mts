// An installed CUDA pack written straight into a test data home (hardware and offload, Task 10), as the installer
// (core/cuda-pack.mts) would leave it: <dataHome>/cuda-pack/current/ with the real `dist/index.js` of
// `@node-llama-cpp/win-x64-cuda`, its package.json (version set to `engineVersion`), its real build metadata, and
// the pack.json marker. `corrupt`: a 1 KiB random `llama-addon.node`, which no loader can ever load — the engine
// must fall back. No NVIDIA DLL is written: no test ever loads a real CUDA build.
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ELECTRON = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(ELECTRON, 'node_modules', '@node-llama-cpp', 'win-x64-cuda');

export async function writeInstalledPack(dataHome: string, options: { engineVersion: string; corrupt: boolean }): Promise<void> {
  const current = join(dataHome, 'cuda-pack', 'current');
  const pkg = join(current, 'node_modules', '@node-llama-cpp', 'win-x64-cuda');
  const bins = join(pkg, 'bins', 'win-x64-cuda');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  await mkdir(bins, { recursive: true });
  await mkdir(join(current, 'cuda-runtime'), { recursive: true });
  await copyFile(join(SOURCE, 'dist', 'index.js'), join(pkg, 'dist', 'index.js'));
  const manifest = JSON.parse(await readFile(join(SOURCE, 'package.json'), 'utf8'));
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ ...manifest, version: options.engineVersion }, null, 2) + '\n');
  await copyFile(join(SOURCE, 'bins', 'win-x64-cuda', '_nlcBuildMetadata.json'), join(bins, '_nlcBuildMetadata.json'));
  if (options.corrupt) await writeFile(join(bins, 'llama-addon.node'), randomBytes(1024));
  const marker = { nodeLlamaCppVersion: options.engineVersion, parts: [], installedAt: new Date().toISOString() };
  await writeFile(join(current, 'pack.json'), JSON.stringify(marker, null, 2) + '\n');
}
