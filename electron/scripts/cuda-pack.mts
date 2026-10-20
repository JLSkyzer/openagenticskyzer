// Builds the CUDA pack (hardware and offload, Task 8) from node_modules and a folder of NVIDIA runtime files.
//   node --experimental-strip-types scripts/cuda-pack.mts --runtime <dir> [--out build/cuda-pack]
//        [--placement beside-binaries|cuda-runtime] [--node-modules <dir>]
// <dir> holds cublas64_13.dll, cublasLt64_13.dll and NVIDIA's LICENSE.txt, unpacked from NVIDIA's libcublas archive.
// The NVIDIA files stay NVIDIA-licensed (never MIT): the licence travels inside the pack beside them (D-CUDA-1).
import { readdir, readFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writePack, type PackFile } from '../core/cuda-pack-format.mts';

type RuntimePlacement = 'beside-binaries' | 'cuda-runtime';
// D-CUDA-3 (« Bilan — Task 1 (spike CUDA) », docs/superpowers/plans/2026-10-18-hardware-and-offload.md): the
// runtime DLLs go to `<pack>/cuda-runtime/`, which the main process prepends to PATH (D-CUDA-2, mechanism B).
// Beside the binaries failed in the spike: Windows does not search the folder of ggml-cuda.dll for its imports.
export const DEFAULT_RUNTIME_PLACEMENT: RuntimePlacement = 'cuda-runtime';

// D-CUDA-3: only the main CUDA 13 build. `win-x64-cuda-ext` (a CUDA 12 fallback) needs CUDA 12 DLLs the pack lacks.
const PACKAGE = '@node-llama-cpp/win-x64-cuda';
const PACKAGE_BINS = `node_modules/${PACKAGE}/bins/win-x64-cuda`;
const LICENCE_NAMES = ['LICENSE.txt', 'LICENSE'];

async function version(packageDir: string): Promise<string> {
  return (JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as { version: string }).version;
}

/** Every regular file under `dir`, as posix paths relative to it. A link is refused, never followed. */
async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Lien refusé dans le pack : ${join(dir, path)}`);
    if (entry.isDirectory()) out.push(...await listFiles(dir, path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export async function collectPackFiles(options: { nodeModules: string; runtimeDir: string; runtimePlacement: RuntimePlacement }): Promise<{ files: PackFile[]; nodeLlamaCppVersion: string }> {
  const engine = await version(join(options.nodeModules, 'node-llama-cpp'));
  const packageDir = join(options.nodeModules, ...PACKAGE.split('/'));
  const packageVersion = await version(packageDir);
  if (packageVersion !== engine) throw new Error(`Version incohérente : ${PACKAGE} ${packageVersion} au lieu de ${engine}`);

  const files: PackFile[] = (await listFiles(packageDir)).map(rel => ({ path: `node_modules/${PACKAGE}/${rel}`, source: join(packageDir, ...rel.split('/')) }));

  const runtimeDir = options.runtimePlacement === 'cuda-runtime' ? 'cuda-runtime' : PACKAGE_BINS;
  const entries = await readdir(options.runtimeDir, { withFileTypes: true });
  const dlls = entries.filter(entry => entry.isFile() && /\.dll$/i.test(entry.name)).map(entry => entry.name);
  if (dlls.length === 0) throw new Error(`Aucune DLL dans ${options.runtimeDir}`);
  for (const name of dlls) files.push({ path: `${runtimeDir}/${name}`, source: join(options.runtimeDir, name) });

  // D-CUDA-1: NVIDIA's licence (with the Volkov BSD notice cuBLAS requires) ships beside its DLLs, as LICENSE.txt.
  const licence = entries.find(entry => entry.isFile() && LICENCE_NAMES.includes(entry.name));
  if (!licence) throw new Error(`Licence NVIDIA absente de ${options.runtimeDir} : le pack doit contenir son LICENSE.txt (D-CUDA-1).`);
  files.push({ path: `${runtimeDir}/LICENSE.txt`, source: join(options.runtimeDir, licence.name) });
  return { files, nodeLlamaCppVersion: engine };
}

async function main(): Promise<void> {
  const electron = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({
    options: {
      runtime: { type: 'string' },
      out: { type: 'string', default: join(electron, 'build', 'cuda-pack') },
      placement: { type: 'string', default: DEFAULT_RUNTIME_PLACEMENT },
      'node-modules': { type: 'string', default: join(electron, 'node_modules') },
    },
  });
  if (!values.runtime) throw new Error('Usage : cuda-pack.mts --runtime <dossier> [--out build/cuda-pack] [--placement beside-binaries|cuda-runtime]');
  if (values.placement !== 'beside-binaries' && values.placement !== 'cuda-runtime') throw new Error(`--placement invalide : ${values.placement}`);
  if (!(await lstat(values.runtime)).isDirectory()) throw new Error(`--runtime n'est pas un dossier : ${values.runtime}`);
  const { files, nodeLlamaCppVersion } = await collectPackFiles({
    nodeModules: values['node-modules']!, runtimeDir: values.runtime, runtimePlacement: values.placement,
  });
  const manifest = await writePack(files, values.out!, { nodeLlamaCppVersion });
  console.log(`Pack CUDA ${nodeLlamaCppVersion} : ${manifest.files} fichiers, ${manifest.installedBytes} octets installés, `
    + `${manifest.parts.length} morceau(x), ${manifest.downloadBytes} octets à télécharger -> ${resolve(values.out!)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
