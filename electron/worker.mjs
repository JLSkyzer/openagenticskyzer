import { parentPort, workerData } from 'node:worker_threads';
import { join, resolve, isAbsolute, relative, sep } from 'node:path';
import { writeFile, realpath, lstat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getModuleVersion } from 'node-llama-cpp';
import { SettingsService } from './core/settings.mts';
import { Conversations } from './core/conversations.mts';
import { FoldersService } from './core/folders.mts';
import { GgufLibrary } from './core/gguf-library.mts';
import { localProvider, plannedContextSize, loadedChatWrapper } from './core/local-engine.mts';
import { TurnLog, pruneTurnLogs, mcpSecretValues } from './core/turn-log.mts';
import { isSensitiveFile, protectedPathMatcher } from './core/file-filter.mts';
import { EstimateCache, estimateAndRemember, estimateKey, hardwareKey, ESTIMATE_BUSY } from './core/offload-estimate.mts';
import { EstimateJobs } from './core/estimate-jobs.mts';
import { readHardware } from './core/hardware.mts';
import { disposeLlama, setCudaPackSource, setRuntimeStart, backendChoice, restartRequired, runtimeNotice, GPU_BACKEND_CHOICES } from './core/llama-runtime.mts';
import { CudaPack, releaseBaseUrl, checkTestBaseUrl, CUDA_PACK_BUSY, CUDA_PACK_TURN_BUSY, CUDA_PACK_UNAVAILABLE } from './core/cuda-pack.mts';
import { offeredTools, runAgent, TOOL_NAME_PATTERN } from './core/agent.mts';
import { basePrompt } from './core/system-prompt.mts';
import { workspaceTools } from './core/workspace.mts';
import { memoryTools, appendCompactionSummary } from './core/memory-tools.mts';
import { gitTools } from './core/git-tools.mts';
import { shellTools, stopAllServers } from './core/shell-tool.mts';
import { webTools } from './core/web-tools.mts';
import { buildInstructions } from './core/context.mts';
import { compactMessages, planCompaction, SUMMARY_PREFIX } from './core/compact.mts';
import { PromptLibrary } from './core/prompts.mts';
import { readProjectMemory } from './core/project-memory.mts';
import { validateAttachments } from './core/attachments.mts';
import { turnWindow } from './core/turn-window.mts';
import { TurnClock } from './core/turn-clock.mts';
import { activeModel, modelStatus, turnModelStatus, contextRequestOf, NO_LOCAL_MODEL, LOCAL_MODEL_MISSING } from './core/active-model.mts';
import { closeDanglingCalls } from './core/request-context.mts';
import { buildHtml, buildJson, buildMarkdown, exportFilename, renderEntries } from './core/export.mts';
import { cleanupOldFolders } from './core/cleanup.mts';
import { gitStatus } from './core/git-status.mts';
import { testHfToken } from './core/hf-token.mts';
import { migrateDataDir } from './core/data-dir.mts';
import { resolveHomes } from './core/data-home.cjs';
import { initializeProject, projectTools } from './core/project-analyzer.mts';
import { McpConfigStore, readProjectMcpConfig, mergeServerConfigs, redactSecrets, expandServerPlaceholders, serverIdentity } from './core/mcp-config.mts';
import { mcpTools, stopAllMcpServers } from './core/mcp-client.mts';
import { searchTools } from './core/search-tools.mts';
import { indexFolder } from './core/semantic-index.mts';
import { setModelsDir, DEFAULT_MODELS_DIR } from './core/embeddings.mts';
import { loadPlugins, projectPythonPluginFiles } from './core/plugin-loader.mts';
import { ProjectTrustService } from './core/project-trust.mts';
import { addFileToKnowledge, listSources as listKnowledgeSources, removeSource as removeKnowledgeSource } from './core/knowledge-base.mts';

// The data home, resolved by core/data-home.cjs exactly as main.cjs resolves it at startup: ~/.openagent followed
// through its redirect.json. OPENAGENT_HOME lets integration tests replace ~/.openagent with a temp directory — its
// own redirect.json is followed, the real one is never read.
const { defaultHome, dataHome } = await resolveHomes();
// The bundled embedding model: main.cjs passes where it lives (packaged: <resources>/models); a worker started
// without it (tests) uses the repository copy. Semantic search never downloads anything (core/embeddings.mts).
setModelsDir(workerData?.modelsDir ?? DEFAULT_MODELS_DIR);
// A send turn finishing at or beyond this duration is flagged 'longRunning' so main.cjs can
// raise a native OS notification (mirrors the previous NiceGUI app's notifier.py threshold).
// OPENAGENT_LONG_RUN_MS lets tests use a real (not mocked) but fast agent turn instead of
// waiting out a real 10s — never rely on it outside tests.
const LONG_RUN_MS = Number(process.env.OPENAGENT_LONG_RUN_MS) || 10_000;
// TEST SEAM. Only a test passes workerData.testProviderModule (the absolute path of the scripted test model client,
// kept beside the tests); main.cjs never does (its workerOptions, proven by tests/test-seam.test.mts), and tests/**
// is never packaged. Without it, payload.testModel of send/compact is never read.
const testSeam = typeof workerData?.testProviderModule === 'string' && workerData.testProviderModule
  ? await import(pathToFileURL(workerData.testProviderModule).href)
  : null;
const settings = new SettingsService(dataHome);
// The CUDA pack (hardware and offload, Task 10). Its manifest is the copy shipped with the app (main.cjs passes
// where it lives; a worker started without it, in tests, uses the repository's resources/). Its parts come from the
// app's own GitHub release. TEST SEAM: only a test passes workerData.cudaPackBaseUrl, a loopback URL; anything else
// there stops the worker at start, and main.cjs never passes it (tests/test-seam.test.mts).
const testPackBaseUrl = workerData?.cudaPackBaseUrl == null ? null : checkTestBaseUrl(workerData.cudaPackBaseUrl);
// The release source is read from package.json's `repository` (electron-builder strips `build` from the packaged copy).
// Unreadable, the source stays empty: the CudaPack then says 'unavailable' and refuses any install, and the reason is
// logged once below.
let releaseUrl = '';
let releaseError = null;
try { releaseUrl = releaseBaseUrl(JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))); }
catch (error) { releaseError = error instanceof Error ? error.message : String(error); }
const cudaPack = new CudaPack({
  dataHome,
  manifestPath: typeof workerData?.cudaPackManifest === 'string' && workerData.cudaPackManifest
    ? workerData.cudaPackManifest
    : fileURLToPath(new URL('./resources/cuda-pack/manifest.json', import.meta.url)),
  baseUrl: testPackBaseUrl ?? releaseUrl,
  engineVersion: await getModuleVersion(),
  allowLoopback: testPackBaseUrl !== null,
});
if (cudaPack.unavailableReason !== null) console.warn(`[cuda-pack] pack CUDA non proposé : ${releaseError ?? cudaPack.unavailableReason}`);
// Before any install can begin and before any Llama: what an earlier uninstall or install left is finished first.
await cudaPack.finishPendingRemoval();
setCudaPackSource(cudaPack);
// The backend is decided once per worker (core/llama-runtime.mts): main.cjs passes the gpu_backend it read before
// putting the pack's runtime on PATH; a worker started without it (tests) reads the setting itself.
// The pack is activated only when it is the one main put on PATH (workerData.cudaRuntimeDir, null when none): a
// worker that disagrees with main (no runtime on PATH, another folder) runs without it, and restartRequired says so.
const savedBackend = () => settings.global().then(saved => saved.gpu_backend, () => 'auto');
const installedAtStart = await cudaPack.installedDir().catch(error => {
  console.warn(`[gpu-backend] pack CUDA illisible au démarrage : ${error?.message ?? error}`);
  return null;
});
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const mainRuntimeDir = typeof workerData?.cudaRuntimeDir === 'string' && workerData.cudaRuntimeDir ? workerData.cudaRuntimeDir : null;
const packAgreed = installedAtStart !== null && mainRuntimeDir !== null && samePath(join(installedAtStart, 'cuda-runtime'), mainRuntimeDir);
const startChoice = GPU_BACKEND_CHOICES.includes(workerData?.gpuBackend) ? workerData.gpuBackend : await savedBackend();
if (installedAtStart !== null && !packAgreed && (startChoice === 'auto' || startChoice === 'cuda')) {
  console.warn('[gpu-backend] pack CUDA installé mais absent du PATH de ce démarrage : non activé avant le prochain démarrage');
}
setRuntimeStart({ choice: startChoice, packDir: packAgreed ? installedAtStart : null });
const trust = new ProjectTrustService(dataHome, settings);
const conversations = new Conversations();
const folders = new FoldersService(dataHome);
const ggufLibrary = new GgufLibrary(dataHome);
const promptLibrary = new PromptLibrary(dataHome);
const mcpConfig = new McpConfigStore(dataHome);
// The worker's one estimate cache and job queue (hardware and offload): handed explicitly to whatever reads them.
const estimateCache = new EstimateCache(dataHome);
const estimateJobs = new EstimateJobs();
// index_status (semantic search): folder (resolved absolute path) -> {state, current?, total?, message?}.
// state.index_status in the previous NiceGUI app was a single free-form string a background thread
// updated in place; here it is a real small state machine ('idle'|'indexing'|'ready'|'error') per
// folder, pushed to the renderer as events — 'error' is a real, distinct state the original never had
// (it silently fell back to "" on any exception).
const indexStatus = new Map();
function postIndexEvent(folder, patch) {
  const key = resolve(String(folder));
  const status = { state: 'idle', ...indexStatus.get(key), ...patch };
  indexStatus.set(key, status);
  parentPort.postMessage({ type: 'event', event: 'index', folder: key, ...status });
}
/** Fire-and-forget: indexes `folder`'s codebase in the background (semantic-index.mts), streaming
 * progress through the 'index' event. One run at a time per folder — a second trigger while one is
 * already in flight (e.g. re-activating the same folder) is a harmless no-op, not a queued restart. */
async function triggerIndexing(folder) {
  const key = resolve(String(folder));
  if (indexStatus.get(key)?.state === 'indexing') return;
  postIndexEvent(folder, { state: 'indexing', current: 0, total: 0, message: undefined });
  try {
    // The project's ignored_patterns — the value the file tools get (settings.effective keeps it as the project wrote
    // it): an ignored or secret file is never indexed, and the rebuild purges what an older index held of it. An
    // unreadable project config ends in 'error' with nothing written.
    const { ignored_patterns: ignoredPatterns } = await settings.project(folder);
    await indexFolder(folder, dataHome, (current, total) => postIndexEvent(folder, { state: 'indexing', current, total }), ignoredPatterns);
    postIndexEvent(folder, { state: 'ready', current: undefined, total: undefined, message: undefined });
  } catch (error) {
    postIndexEvent(folder, { state: 'error', current: undefined, total: undefined, message: error instanceof Error ? error.message : 'Erreur interne' });
  }
}
// Archives (core/cleanup.mts: moves into <dataHome>/retention-archive/, never deletes) the conversation history of
// projects unused beyond session_retention_days (0 = keep forever). Run once at startup, before the worker starts
// taking requests. Never let a corrupt config/folders file crash the worker.
await cleanupOldFolders(folders, (await settings.global().catch(() => ({ session_retention_days: 0 }))).session_retention_days, dataHome).catch(() => {});
// The turn log (core/turn-log.mts): one file per day, kept 14 days — expired days are removed here, once, at start.
const turnLog = new TurnLog(dataHome);
await pruneTurnLogs(dataHome, new Date()).catch(error => console.error(`[turn-log] nettoyage impossible : ${error instanceof Error ? error.message : error}`));
// index_status parity: main.py sets state.active_folder to the last-used folder at startup when
// restore_last_folder is on, and a background thread indexes it from there. This worker mirrors
// that for the INDEX only (pre-warms it) — it does not select a folder as "active" in the renderer,
// which never auto-restores one today (a separate, pre-existing gap: verified Sidebar.tsx/App.tsx
// never call activate_folder on mount either way, so this is not a regression introduced here).
if ((await settings.global().catch(() => ({ restore_last_folder: true }))).restore_last_folder) {
  const [mostRecent] = await folders.list().catch(() => []);
  if (mostRecent?.path) void triggerIndexing(mostRecent.path);
}
const active = new Map();
// requestId -> { resolve(allow), folder, tool } — filled by the confirm() callback passed to
// runAgent, drained by the 'permission-decision' op below.
const pendingPermissions = new Map();
// "Toujours" (any tool: write, shell, network, extension) is remembered for this worker's lifetime
// only — folder + tool, until the app closes — and never written to a settings file (decision of
// 2026-10-03: it used to save files_ask/search_ask:false for the whole project, i.e. every git and
// memory write too). « Toujours » saved by earlier versions stay: past decisions, not migrated.
const sessionAllowed = new Set();
const allowKey = (folder, tool) => `${folder}\0${tool}`;
// Withdrawing or refusing a project's trust also forgets its « Toujours » (the Outils tab says so).
function forgetSessionAllowed(folder) {
  for (const key of sessionAllowed) if (key.startsWith(`${folder}\0`)) sessionAllowed.delete(key);
}
// Parity row 33: what the last TURN learned of each MCP server, under mcpDiscoveryKey: { names } (every tool it exposed,
// before any filtering) or { error } (why its discovery failed). Only a turn starts a server; the Outils tab
// (plugin-list, mcp-list) only reads this map, through rememberedMcpStatus.
const mcpDiscoveries = new Map();
/** A project server's discovery belongs to that project alone — another project may run the same command, with its
 * own env; a global server is the same server in every folder. The identity is the config as a turn runs it. */
const mcpDiscoveryKey = (folder, server) => JSON.stringify([server.scope === 'project' ? resolve(String(folder)) : null, serverIdentity(server)]);
// 'shutdown' is internal: main.cjs sends it directly when the app closes; it is not in main's
// renderer-facing allow-list, so the page cannot call it.
const ops = new Set(['global-settings', 'project-settings', 'save-global-settings', 'save-project-settings', 'list-branches', 'messages', 'save-messages', 'fork', 'list_folders', 'activate_folder', 'settings', 'save_settings', 'send', 'stop', 'permission-decision', 'clear-history', 'remove-folder', 'reset-global-settings', 'compact', 'list-prompts', 'read-project-memory', 'export-conversation', 'gguf-list', 'gguf-add', 'gguf-remove', 'git-status', 'test-hf-token', 'model-status', 'hardware-info', 'estimate-model', 'estimate-cancel', 'cuda-pack-status', 'cuda-pack-install', 'cuda-pack-cancel', 'cuda-pack-uninstall', 'migrate-data-dir', 'init-project', 'mcp-list', 'mcp-add', 'mcp-add-remote', 'mcp-remove', 'index-status', 'knowledge-list', 'knowledge-add', 'knowledge-remove', 'plugin-list', 'project-trust', 'trust-project', 'shutdown']);

// Anything in `active` on this folder — an agent run or a compaction — is writing its transcript.
function runningIn(folder) {
  const target = resolve(String(folder));
  return [...active.values()].some(run => resolve(String(run.folder)) === target);
}
function compactingIn(folder) {
  const target = resolve(String(folder));
  return [...active.values()].some(run => run.kind === 'compact' && resolve(String(run.folder)) === target);
}

/** The window a request must fit in (H3): the engine's real context size, capped by max_tokens when the user set
 * one (core/turn-window.mts). Shared by agent turns and compaction, so the two can never size a request differently.
 * provider.contextWindow() loads the engine. Its run is registered in `active` by now, so estimate-model refuses any
 * new estimate (ESTIMATE_BUSY): turnWindow cancels again one that started before that registration and waits for a
 * cancelled run to end. `options.signal` (the run's stop) cuts that wait and the load short; `options.onLoad` follows
 * the load. */
function windowFor(provider, maxTokens, options = {}) {
  return turnWindow(estimateJobs, provider, maxTokens, options);
}

/** Tells the page the model this turn runs on and the window its engine really runs with — known once windowFor has
 * loaded it. Built from the turn's own resolved model (never a fresh read of the setting), and best-effort: a status
 * that cannot be posted never fails the turn. */
function postModelStatus(model) {
  try {
    parentPort.postMessage({ type: 'event', event: 'model', ...turnModelStatus(model) });
  } catch { /* the page keeps its last status; the turn goes on */ }
}

/** The turn log's model-ready line, from the same sources as postModelStatus: where the loaded model really sits, the
 * context it runs with (the request window for a model that is not a loaded .gguf), its chat wrapper and the load
 * time (`loadMs`, none for a warm engine). Best-effort like postModelStatus. */
function logModelReady(model, contextTokens, loadMs, log) {
  try {
    const status = turnModelStatus(model);
    const placement = status.placement;
    const wrapper = model ? loadedChatWrapper(model.path) : null;
    log({
      event: 'model-ready', backend: placement?.backend ?? null,
      ...(placement ? { gpuLayers: placement.gpuLayers, totalLayers: placement.totalLayers } : {}),
      contextSize: placement?.contextSize ?? (status.loaded ? status.contextWindow : contextTokens),
      ...(wrapper ? { wrapper: wrapper.name, segments: wrapper.segments } : {}),
      ...(loadMs === undefined ? {} : { loadMs }),
    });
  } catch { /* a line missing never fails the turn */ }
}

/**
 * Summarises a branch in the background and reports through events (like `send`: the IPC round trip
 * is capped at 30 s, a summary is not). Nothing is written unless the model answered AND the branch
 * is still exactly what it was when the summary was requested.
 */
async function runCompaction(compactionId, folder, branchId, before, { provider, model }) {
  const post = message => parentPort.postMessage({ type: 'event', event: 'agent', runId: compactionId, ...message });
  let outcome;
  try {
    // max_tokens is a global setting only (core/settings.mts), so the global config is the whole answer here.
    const { signal } = active.get(compactionId).controller;
    const window = await windowFor(provider, (await settings.global()).max_tokens, { signal });
    postModelStatus(model);
    const after = await compactMessages({ provider, messages: before, contextWindow: window, signal });
    await conversations.replaceIfUnchanged(folder, branchId, before, after);
    // context_bar.py::trigger_compact parity: persist the summary itself into the project's
    // memory so it survives a later clear-history/re-compaction. Awaited (not fire-and-forget)
    // so the write is guaranteed done before the 'compacted' event is announced — safe because
    // appendCompactionSummary itself never throws (a memory-write failure never turns an
    // already-successful compaction into a reported failure).
    await appendCompactionSummary(folder, dataHome, after[0].content.slice(SUMMARY_PREFIX.length));
    outcome = { kind: 'compacted', messages: servedMessages(after) };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    outcome = { kind: 'compact-failed', message: aborted ? 'Compaction interrompue.' : error instanceof Error ? error.message : 'Erreur interne' };
  }
  // Release the folder BEFORE announcing the end, so whoever reacts to the event finds it free.
  active.delete(compactionId);
  post(outcome);
}

/** Every registered tool for this folder's settings, plus its effective settings — the single source
 * of truth `runSend`'s permission checks AND the exporter's tool tags both read from, so the two can
 * never drift apart. The project's trust is evaluated here, on EVERY turn: a plugin or .mcp.json
 * added during the session (git pull, or the agent itself) is not loaded before a new approval. */
async function registerTools(folder) {
  const projectTrust = await trust.evaluate(folder);
  const effective = await settings.effective(folder, { approvedRelaxations: projectTrust.approvedRelaxations });
  const others = await nonPluginTools(folder, effective, projectTrust);
  const { tools: pluginTools, errors: pluginErrors } = await pluginToolsBeside(folder, others, projectTrust);
  for (const error of pluginErrors) console.error(`[plugin] ${error}`);
  // projectTrust too: the turn log masks the secrets of exactly the MCP servers this turn runs (ruling M6).
  return { effective, tools: [...others, ...pluginTools], projectTrust };
}

/** The MCP servers a turn in `folder` runs, in its order: the project's .mcp.json ones only once the project is
 * trusted (never started or contacted before), then the global ones. Reading the config starts nothing. */
async function mcpServersFor(folder, projectTrust) {
  const projectServers = projectTrust.contentTrusted ? await readProjectMcpConfig(folder) : [];
  return mergeServerConfigs(await mcpConfig.list(), projectServers);
}

/** The built-in tools for a real project folder — building them starts no process. */
async function builtInTools(folder, effective) {
  return [
    ...await workspaceTools(folder, effective.ignored_patterns),
    ...await memoryTools(folder, dataHome),
    ...await gitTools(folder, effective.ignored_patterns),
    ...projectTools(folder),
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome, effective.ignored_patterns),
  ];
}

/** Built-in + MCP tools for a turn: the MCP servers are started here, and only here, to discover their tools. */
async function nonPluginTools(folder, effective, projectTrust) {
  const { tools: mcpDiscovered, errors: mcpErrors, servers } = await mcpTools(await mcpServersFor(folder, projectTrust));
  for (const { target, tools, error } of servers) {
    mcpDiscoveries.set(mcpDiscoveryKey(folder, target), tools ? { names: tools.map(tool => tool.name) } : { error });
  }
  // A broken/unreachable MCP server never blocks the turn or surfaces to the chat — same
  // server-log-only isolation agent.py's own logging.getLogger("openagentic.mcp").warning had.
  for (const error of mcpErrors) console.error(`[mcp] ${error}`);
  const builtIn = await builtInTools(folder, effective);
  return [...builtIn, ...mcpToolsBeside(mcpDiscovered, builtIn)];
}

/** The discovered MCP tools minus any whose name is invalid or already taken — by a built-in, or
 * by an EARLIER MCP tool: two different servers (e.g. a global and a project filesystem server)
 * easily expose the same tool name, and runAgent refuses a duplicated or invalid name for the
 * WHOLE turn. First registered wins; mergeServerConfigs lists project servers first, so a project
 * server's tool wins over a global one's. Same idiom as pluginToolsBeside, logged like mcpErrors. */
function mcpToolsBeside(discovered, others, log = message => console.error(`[mcp] ${message}`)) {
  const taken = new Set(others.map(tool => tool.name));
  const kept = [];
  for (const tool of discovered) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) log(`${tool.name}: nom d’outil invalide, ignoré`);
    else if (taken.has(tool.name)) log(`${tool.name}: nom déjà utilisé par un autre outil, ignoré`);
    else { taken.add(tool.name); kept.push(tool); }
  }
  return kept;
}

/** For each of `servers` (what a turn in `folder` runs, in its order), what the Outils tab shows WITHOUT starting it:
 * `tools`, the names a turn would offer from the last discovery — filtered by mcpToolsBeside against `builtIn`, exactly
 * as the turn filters them — or `error`, why that discovery failed; both null when no turn has started it. */
function rememberedMcpStatus(folder, servers, builtIn, agentSettings = null) {
  const statuses = servers.map(server => {
    const last = mcpDiscoveries.get(mcpDiscoveryKey(folder, server));
    return { names: last?.names ?? [], tools: last?.names ? [] : null, error: last?.error ?? null };
  });
  // Every MCP tool is an 'extension' (core/mcp-client.mts::toAgentTool): registered as such, then offered or not by
  // the agent mode exactly as runSend's offeredTools decides.
  const discovered = statuses.flatMap(status => status.names.map(name => ({ name, category: 'extension', status })));
  const registered = mcpToolsBeside(discovered, builtIn, () => {});
  for (const { name, status } of agentSettings ? offeredTools(registered, agentSettings) : registered) status.tools.push(name);
  return statuses.map(({ tools, error }) => ({ tools, error }));
}

/** The agent settings a turn runs under, from its effective settings — the same object runSend gives runAgent. */
function agentSettingsOf(effective) {
  return { mode: effective.agent_mode, permission_mode: effective.permission_mode, files_ask: effective.files_ask, shell_ask: effective.shell_ask, search_ask: effective.search_ask, reserved_tokens: effective.reserved_tokens };
}

/** The global mode, for a list shown with no readable folder settings; null (names unfiltered by mode) if unreadable. */
function globalAgentSettings() {
  return settings.global().then(agentSettingsOf, () => null);
}

/** A discovery error shown beside a project entry displayed as written: each expanded field value (command, args, url)
 * is put back as written — an expanded ${VAR} is typically a secret and never reaches the renderer. */
function errorAsWritten(error, expanded, written) {
  if (!error) return null;
  const pairs = 'url' in expanded
    ? [[expanded.url, written.url]]
    : [[expanded.command, written.command], ...expanded.args.map((arg, i) => [arg, written.args?.[i] ?? ''])];
  return pairs.reduce((text, [value, raw]) => (value && value !== raw ? text.split(value).join(raw) : text), error);
}

/** The merged server list for the Outils tab. Trusted project: merged exactly as a turn merges it
 * (placeholders expanded, so the same entries dedupe), each project entry shown as written in
 * .mcp.json — an expanded `${TOKEN}` in args or url is a secret, and those fields are displayed.
 * Untrusted project: its entries are listed (trusted: false) but take no part in the merge — a turn
 * only runs the global ones, so a colliding global entry must not be hidden. A project whose trust
 * cannot be evaluated (invalid .openagent/config.json, folder gone) is untrusted — never a reason to
 * hide the global servers. */
async function mcpServersForDisplay(folder) {
  // Every entry carries `tools` and `error` (rememberedMcpStatus): never started here, only what a turn learned.
  const global = await mcpConfig.list();
  const withStatus = (servers, statuses) => servers.map((server, i) => ({ ...server, ...statuses[i] }));
  // No active folder: no turn here, no built-in tool to collide with — the global servers as a turn without project
  // servers would offer them.
  if (!folder) return withStatus(global, rememberedMcpStatus(null, global, [], await globalAgentSettings()));
  let projectTrust = null;
  try { projectTrust = await trust.evaluate(folder); }
  catch (error) { console.error(`[trust] ${folder} : confiance non évaluable, traité comme non approuvé : ${error instanceof Error ? error.message : error}`); }
  // Built-in tools only matter here as names an MCP tool could collide with; a folder whose settings or path cannot be
  // read gets none (a turn there would fail anyway).
  // The agent mode decides what is offered: the folder's effective settings, else the global ones.
  let builtIn = [];
  let agentSettings = await globalAgentSettings();
  if (projectTrust) {
    try {
      const effective = await settings.effective(folder, { approvedRelaxations: projectTrust.approvedRelaxations });
      agentSettings = agentSettingsOf(effective);
      builtIn = await builtInTools(folder, effective);
    } catch { /* unreadable settings or path: the global mode, no built-in names */ }
  }
  const asWritten = await readProjectMcpConfig(folder, { expandEnv: false }).catch(() => []);
  if (!projectTrust?.contentTrusted) {
    // A turn runs only the global servers; the project's are listed « non approuvé », with no status.
    return [...withStatus(global, rememberedMcpStatus(folder, global, builtIn, agentSettings)), ...asWritten.map(server => ({ ...server, trusted: false, tools: null, error: null }))];
  }
  const byId = new Map(asWritten.map(server => [server.id, server]));
  const merged = mergeServerConfigs(global, asWritten.map(server => expandServerPlaceholders(server)));
  // The status is looked up on the EXPANDED entry (what a turn runs); a project entry is shown as written.
  const statuses = rememberedMcpStatus(folder, merged, builtIn, agentSettings);
  return merged.map((server, i) => {
    if (server.scope !== 'project') return { ...server, ...statuses[i] };
    const written = byId.get(server.id) ?? server;
    return { ...written, trusted: true, tools: statuses[i].tools, error: errorAsWritten(statuses[i].error, server, written) };
  });
}

/** The project's legacy .py plugins, listed beside its .mjs while the project is not approved — relative to the
 * project, as core/project-trust.mts lists the .mjs. Listing a directory runs nothing. */
async function projectPythonListing(folder) {
  try {
    const root = await realpath(folder);
    return (await projectPythonPluginFiles(root, dataHome)).map(file => relative(root, file).split(sep).join('/'));
  } catch {
    return [];
  }
}

/** The folder's plugin tools minus any whose name `others` already uses: runAgent refuses a
 * duplicated name for the WHOLE turn, so one plugin named like a built-in would otherwise break
 * every turn. The project's own plugins only once it is trusted — not even imported before.
 * Shared by registerTools and plugin-list, so the Outils tab shows exactly what a turn gets. */
async function pluginToolsBeside(folder, others, projectTrust) {
  // A project with nothing to approve (contentStatus 'none': no plugin to run, no .mcp.json server) still has its .py
  // reported as to port — listing a folder runs nothing.
  const { tools, errors } = await loadPlugins(folder, dataHome, {
    includeProject: projectTrust.contentTrusted,
    projectPython: projectTrust.contentTrusted || projectTrust.contentStatus === 'none',
  });
  const taken = new Set(others.map(tool => tool.name));
  const kept = [];
  for (const tool of tools) {
    if (taken.has(tool.name)) errors.push(`${tool.name}: nom déjà utilisé par un autre outil, ignoré`);
    else kept.push(tool);
  }
  return { tools: kept, errors };
}

/** What the renderer is shown about a project's trust: each part's own status (the aggregate `state`
 * alone cannot say what IS applied), never a secret (env/header values masked, like every mcp-*
 * reply — their NAMES stay, so the user sees e.g. a NODE_OPTIONS before approving). */
function trustView(projectTrust) {
  const { state, changed, token, contentStatus, unreadable, relaxationStatus, inventory } = projectTrust;
  return {
    state, changed, token, contentStatus, unreadable, relaxationStatus,
    plugins: inventory.plugins, mcpServers: redactSecrets(inventory.mcpServers), relaxations: inventory.relaxations,
  };
}

/** The user just saved these project fields themselves: approve them so they apply at once. Never
 * throws — the save already succeeded, and a failed approval only leaves the relaxation pending
 * (fail-closed: not applied until the user approves the project). */
async function approveSavedFields(folder, fields) {
  try {
    await trust.approveRelaxations(folder, fields);
  } catch (error) {
    console.error(`[trust] approbation de ${Object.keys(fields).join(', ')} impossible : ${error instanceof Error ? error.message : error}`);
  }
}

const EXPORT_FORMATS = new Set(['md', 'html', 'json']);

/** Writes the conversation to `<folder>/conversation_<timestamp>.<ext>` and returns its filename —
 * never a full path: main.cjs is the only one allowed to open a file, and only by folder + a
 * filename matching exactly what this function itself generates. */
async function exportConversation(folder, branchId, format) {
  if (!EXPORT_FORMATS.has(format)) throw new Error('Format d’export invalide');
  if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
  // As FoldersService.open (core/folders.mts): a folder realpath cannot resolve is refused with the worker's own reason,
  // not Node's « ENOENT … realpath '<absolute path>' », which the export toast showed as is (parity row 14, 2026-10-05).
  let root;
  try {
    root = await realpath(folder);
  } catch {
    throw new Error('Dossier introuvable');
  }
  if (!(await lstat(root)).isDirectory()) throw new Error('Dossier introuvable');
  const messages = await conversations.messages(folder, branchId);
  const { tools } = await registerTools(folder);
  const toolCategory = new Map(tools.map(tool => [tool.name, tool.category]));
  const entries = renderEntries(messages, name => toolCategory.get(name));
  // The header names the active .gguf, read here like a turn reads it: never a provider or a model sent by the page.
  // None active, or one whose file is gone: « Aucun modèle ».
  const model = (await activeModel(settings, ggufLibrary).catch(() => null))?.name ?? 'Aucun modèle';
  const provider = 'local';
  const date = new Date();
  const filename = exportFilename(format, date);
  const content =
    format === 'md' ? buildMarkdown(entries, { folder: root, model, provider, date }) :
    format === 'html' ? buildHtml(entries, { model, date }) :
    buildJson(entries);
  await writeFile(join(root, filename), content, 'utf8');
  return { filename };
}

function normalizeRole(role) {
  if (role === 'ai') return 'assistant';
  if (role === 'human') return 'user';
  return role;
}
/** R3: the Python app saved `ai`/`human`; the screen and the model request only know `assistant`/`user`. Applied
 * wherever a history is served (folder activation, branch load, a finished compaction, a turn) — never written back
 * by a read, so the file stays exactly as the Python app left it until the next real save. */
function servedMessages(messages) {
  return messages.map(message => ({ ...message, role: normalizeRole(message.role) }));
}

/** Puts `timing` on the last assistant message of `messages` at an index >= `from` (this run's own), if any. */
function withTiming(messages, from, timing) {
  for (let i = messages.length - 1; i >= from; i--) {
    if (messages[i].role === 'assistant') { messages[i] = { ...messages[i], timing }; return; }
  }
}

function lastAssistantSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && typeof messages[i].content === 'string' && messages[i].content.trim()) {
      return messages[i].content.slice(0, 100);
    }
  }
  return 'Tâche terminée';
}

/**
 * The model of a send or a compaction ("réveiller" the .gguf): the active_local_model the worker reads itself
 * (core/active-model.mts), never an id or a connection sent by the page. None active: NO_LOCAL_MODEL; one whose
 * file is gone: LOCAL_MODEL_MISSING — both before anything starts. The test seam answers only when no model is
 * active. The engine itself is loaded on the first request (windowFor), not here.
 */
async function turnProvider(payload) {
  const model = await activeModel(settings, ggufLibrary);
  // The engine context comes from « Contexte des modèles locaux », read on every send: a changed setting reloads the
  // model at the next message. max_tokens is not part of it (it caps the request window only, windowFor).
  if (model) {
    const request = await contextRequestOf(settings);
    // A turn has the machine to itself: a background estimate would compete with its load for the same memory.
    // Cancelled with no await left before the caller registers the run in `active` (after which estimate-model is
    // refused); windowFor cancels again and waits for the cancelled run to end before the load.
    estimateJobs.cancelAll();
    return { provider: localProvider(model.path, request), model };
  }
  if (testSeam && payload.testModel) return { provider: testSeam.createTestProvider(payload.testModel), model: null };
  throw new Error(NO_LOCAL_MODEL);
}

/**
 * Op estimate-model: where `modelId`'s layers (else the active model's) would go with the context it would be
 * loaded with. A cached estimate answers at once; otherwise a background job starts, the op answers its id, and the
 * job posts one 'estimate' event (done, cancelled or error). Refused during a turn or a compaction: an expected
 * refusal, so answered as a result ({ busy: true, message: ESTIMATE_BUSY }), never thrown (main logs what is thrown).
 */
const estimateBusy = () => ({ busy: true, message: ESTIMATE_BUSY, estimateId: null, estimate: null });

async function estimateModel(payload) {
  let model;
  if (payload.modelId) {
    model = (await ggufLibrary.list()).find(entry => entry.id === payload.modelId);
    if (!model) throw new Error(LOCAL_MODEL_MISSING);
  } else {
    model = await activeModel(settings, ggufLibrary);
    if (!model) throw new Error(NO_LOCAL_MODEL);
  }
  if (active.size > 0) return estimateBusy();
  const contextSize = await plannedContextSize(model.path, await contextRequestOf(settings));
  const source = { kind: 'file', path: model.path };
  const key = await estimateKey(source, contextSize, await hardwareKey());
  const cached = await estimateCache.get(key);
  if (cached) return { estimateId: null, estimate: cached };
  // Checked again after the awaits above: a turn that started meanwhile has already cancelled every job.
  if (active.size > 0) return estimateBusy();
  const modelId = model.id;
  const { id } = estimateJobs.start(key, signal => estimateAndRemember(estimateCache, key, source, { contextSize, signal }), outcome => {
    const { id: estimateId, ...rest } = outcome;
    parentPort.postMessage({ type: 'event', event: 'estimate', estimateId, modelId, ...rest });
  });
  return { estimateId: id, estimate: null };
}

/** Runs one agent turn to completion, streaming events to the renderer via parentPort. */
async function runSend(runId, folder, branchId, text, keep, attachments, { provider, model }) {
  const controller = new AbortController();
  const accumulated = [];
  const post = message => parentPort.postMessage({ type: 'event', event: 'agent', runId, ...message });
  const startedAt = Date.now();
  // The turn's figures (core/turn-clock.mts), joined to done, to stopped and to the saved reply.
  const clock = new TurnClock(startedAt);
  // The turn log (core/turn-log.mts). Its secrets and protected paths are known once registerTools has returned:
  // the lines before that wait in `pendingLog` (openLog writes them through the logger), and nothing is logged
  // after the `end` line.
  const pendingLog = [];
  let logger = null;
  let logClosed = false;
  const log = event => {
    if (logClosed) return;
    if (logger) logger.write(event); else pendingLog.push(event);
  };
  const openLog = (level, secrets, isProtected) => {
    logger = turnLog.begin({ runId, folder, level, secrets: secrets.filter(Boolean), isProtected });
    for (const event of pendingLog.splice(0)) logger.write(event);
  };
  // The level and hf_token, read once. Unreadable settings log nothing (`off`): the token to mask is not known.
  let logLevel = 'off';
  let hfToken = '';
  log({ event: 'turn-start', model: model?.name ?? null, text, attachments: attachments.length, ...(keep === undefined ? {} : { keep }) });
  // The phase the page shows while the turn runs. A post equal to the last one (same phase, progress and tool) is
  // skipped, and after « stopping » none is posted: the stop op posts it through the run's entry (ruling M7), so its
  // line is logged here too.
  let lastPhase = '';
  let stopping = false;
  // The phase shown now and since when, for each phase line's `previous` and `previousMs`.
  let shownPhase = null;
  let shownSince = 0;
  const phase = (name, extra = {}) => {
    if (stopping) return;
    const key = JSON.stringify([name, extra.progress ?? null, extra.tool ?? null]);
    if (key === lastPhase) return;
    lastPhase = key;
    if (name === 'stopping') stopping = true;
    post({ kind: 'phase', phase: name, ...extra });
    // A new phase closes the one shown (previousMs, its duration); a progress or another tool in the same phase does not.
    const now = Date.now();
    const changed = name !== shownPhase;
    log({ event: 'phase', phase: name, previous: shownPhase, previousMs: changed && shownPhase !== null ? now - shownSince : null, ...extra });
    if (changed) { shownPhase = name; shownSince = now; }
  };
  // stopRequestedAt: when the user asked to stop (the stop op), for the stop latency.
  active.set(runId, { controller, folder, kind: 'send', post, phase, stopRequestedAt: null });
  // Wraps a terminal post (done/stopped/error) with a longRunning flag once the turn has taken
  // at least LONG_RUN_MS — main.cjs raises a native notification only when this is set.
  const finish = (kind, extra = {}) => {
    const durationMs = Date.now() - startedAt;
    post({ kind, ...extra, ...(durationMs >= LONG_RUN_MS ? { longRunning: true, durationMs } : {}) });
  };
  let collected = [];
  // Tracks the assistant text currently streaming in, so a Stop mid-delta (before
  // agent.mts ever emits the completed 'message') still has something to persist and
  // show — cleared once that turn's real 'message' event lands. Declared here (not
  // inside the try block) so the catch block below can actually see it.
  let partialText = '';
  // The reasoning streamed beside it (thinking events), kept with the partial reply on a stop.
  let partialReasoning = '';
  // For the turn log: the model call in progress (agent `turn` step), each tool call's name and arguments (from the
  // assistant message that made it) and when it started (its tool-start; none for a refused or invalid call).
  let step = 0;
  const calls = new Map();
  const toolStarts = new Map();
  const logTool = (message, ok) => {
    const content = typeof message.content === 'string' ? message.content : '';
    const call = calls.get(message.tool_call_id);
    const startedAt = toolStarts.get(message.tool_call_id);
    log({
      event: 'tool', tool: message.name ?? call?.name ?? '', ...(message.category ? { category: message.category } : {}),
      arguments: call ? call.arguments : null, ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
      ok: ok ?? !content.startsWith('Erreur : '), result: content,
    });
  };
  // The `end` line closes the log, and the terminal event is posted only once it is on disk (flush never rejects).
  const endLog = async event => {
    log(event);
    logClosed = true;
    await logger?.flush();
  };
  try {
    phase('preparing');
    const globalConfig = await settings.global().catch(() => null);
    if (globalConfig) {
      logLevel = globalConfig.turn_log;
      hfToken = typeof globalConfig.hf_token === 'string' ? globalConfig.hf_token : '';
    }
    // The page already shows the user message (send-started), so the turn is assembled FIRST: from here on, any
    // failure (tools, instructions, the model) saves history + this message, and the file stays aligned with the
    // screen — edit and regenerate cut both at the same index. Only an unreadable conversation file stops here,
    // with nothing to save.
    const saved = await conversations.messages(folder, branchId);
    const history = servedMessages(keep === undefined ? saved : saved.slice(0, keep));
    // What was typed stays in `content`; the files ride beside it and are expanded only when the model is called.
    collected = [...history, { role: 'user', content: text, ...(attachments.length ? { attachments } : {}) }];
    const { effective, tools, projectTrust } = await registerTools(folder);
    // The turn log masks hf_token and the secrets of the MCP servers this turn runs, and never logs a file tool's
    // arguments and result on a sensitive or protected path — tested as the file tools test it, relative to the project.
    const protectedRel = protectedPathMatcher(effective.ignored_patterns);
    openLog(logLevel, [hfToken, ...mcpSecretValues(await mcpServersFor(folder, projectTrust))],
      path => isSensitiveFile(path) || protectedRel(relative(folder, resolve(folder, path))));
    const toolCategory = new Map(tools.map(tool => [tool.name, tool.category]));
    const agentSettings = agentSettingsOf(effective);
    // The prompt names exactly the tools offered this turn, adds the mode's instruction and, under
    // Windows, how run_command's shell behaves (core/system-prompt.mts).
    const offered = offeredTools(tools, agentSettings).map(tool => tool.name);
    const { instructions } = await buildInstructions({ folder, home: dataHome, base: basePrompt({ tools: offered, mode: agentSettings.mode, platform: process.platform }) });
    const emit = event => {
      const { type: kind, ...rest } = event;
      // A generation's figures feed the clock only, and never end anything: pieces may still follow (ruling T2-m4).
      if (kind === 'stats') {
        clock.stats(rest);
        log({ event: 'generation', step, inputTokens: rest.inputTokens, outputTokens: rest.outputTokens, generationMs: rest.generationMs });
        return;
      }
      if (kind === 'turn') { step = rest.step; phase('reading'); clock.readStart(); }
      if (kind === 'thinking') {
        // `moved`: what was streamed as the answer was reasoning (a bare </think>, core/reasoning-split.mts).
        clock.chunk(rest.moved ? 'moved' : 'thought');
        if (rest.moved) partialText = '';
        partialReasoning += rest.text;
        phase('thinking');
      }
      // An empty delta (a provider's empty content) is no word of the answer yet.
      if (kind === 'delta' && rest.text) {
        clock.chunk('text');
        partialText += rest.text;
        phase('writing');
      }
      if (kind === 'tool-start') { toolStarts.set(rest.id, Date.now()); phase('tool', { tool: rest.tool }); }
      if (kind === 'message') {
        accumulated.push(rest.message);
        if (rest.message.role === 'assistant') {
          partialText = ''; partialReasoning = '';
          const { content, reasoning, tool_calls: toolCalls = [] } = rest.message;
          for (const call of toolCalls) {
            let args = call.function?.arguments;
            try { args = JSON.parse(args); } catch { /* kept as the model wrote it */ }
            calls.set(call.id, { name: call.function?.name, arguments: args });
          }
          log({ event: 'reply', step, ...(reasoning ? { reasoning } : {}), text: typeof content === 'string' ? content : '', toolCalls: toolCalls.length });
        }
        if (rest.message.role === 'tool') logTool(rest.message);
      }
      const enriched = { kind, ...rest };
      if (kind === 'tool-start') enriched.category = toolCategory.get(rest.tool);
      post(enriched);
    };
    const confirm = (request, signal) => new Promise((resolve, reject) => {
      if (sessionAllowed.has(allowKey(folder, request.tool))) { resolve(true); return; }
      const requestId = randomUUID();
      pendingPermissions.set(requestId, { resolve, folder, tool: request.tool });
      signal.addEventListener('abort', () => { pendingPermissions.delete(requestId); reject(signal.reason); }, { once: true });
      post({ kind: 'permission-request', requestId, tool: request.tool, category: toolCategory.get(request.tool), arguments: request.arguments });
    });
    // A real load (none for a warm engine) shows « loading », its progress in whole percents. Once the run is
    // aborted, the load going on natively behind the stop reports nothing more; a load that fails or is stopped never
    // calls 'end', so the turn has no loadMs, and its terminal event closes the phase (ruling T2-m5).
    const onLoad = event => {
      if (controller.signal.aborted) return;
      if (event.kind === 'start') { clock.loadStart(); phase('loading'); }
      if (event.kind === 'progress') phase('loading', { progress: Math.min(100, Math.max(0, Math.floor(event.progress * 100))) });
      if (event.kind === 'end') clock.loadEnd();
    };
    const contextTokens = await windowFor(provider, effective.max_tokens, { signal: controller.signal, onLoad });
    postModelStatus(model);
    logModelReady(model, contextTokens, clock.timing().loadMs, log);
    const result = await runAgent({
      provider, messages: collected, instructions, tools, contextWindow: contextTokens,
      settings: agentSettings,
      signal: controller.signal, confirm, emit,
    });
    const timing = clock.timing();
    withTiming(result, collected.length, timing);
    await conversations.save(folder, branchId, result);
    await endLog({ event: 'end', kind: 'done', timing });
    finish('done', { summary: lastAssistantSummary(result), timing });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    const message = error instanceof Error ? error.message : 'Erreur interne';
    // H4: a tool call of THIS run left without its result (Stop during a permission prompt or a running tool,
    // an error) gets one, in call order, so the saved transcript stays valid for every provider. Only this
    // run's messages: an older turn's dangling call is never sent again (H3), and closing it would insert a
    // message mid-list in the file but at the end on screen. Posted too: the screen must hold the same
    // messages as the file, at the same indices (edit/regenerate cut both at the same index).
    // A turn that failed before registerTools returned still logs what it queued, masked with hf_token and the token
    // patterns: the MCP secrets are not known then (ruling M5), and no file tool has run.
    if (!logger) openLog(logLevel, [hfToken], path => isSensitiveFile(path) || protectedPathMatcher('')(path));
    const { messages: produced, added } = closeDanglingCalls(accumulated, aborted ? "Interrompu par l'utilisateur" : `Interrompu : ${message}`);
    for (const closing of added) { post({ kind: 'message', message: closing }); logTool(closing, false); }
    // Text already streamed is kept whatever ended the turn — a Stop, a provider gone silent (idle
    // timeout), a cut stream — exactly like a completed message, so the screen and the saved
    // transcript agree.
    if (partialText.trim() || partialReasoning.trim()) {
      const partial = { role: 'assistant', content: partialText, ...(partialReasoning.trim() ? { reasoning: partialReasoning } : {}) };
      produced.push(partial);
      post({ kind: 'message', message: partial });
      log({ event: 'reply', step, ...(partial.reasoning ? { reasoning: partial.reasoning } : {}), text: partialText, toolCalls: 0 });
    }
    // A stop's figures go on the last reply this run produced; a run stopped before any reply saves none.
    const timing = aborted ? clock.timing() : null;
    if (timing) withTiming(produced, 0, timing);
    // Persist whatever the model/tools actually produced even on Stop/error — losing an
    // in-flight tool-call's already-emitted messages would silently discard real work. A failure after
    // `collected` is assembled (tools, instructions, the model) saves history + the user message, as the
    // screen shows them. Only a conversation file that could not be read leaves `collected` empty: saving []
    // would empty the branch, or overwrite a file deliberately kept because it could not be read.
    if (collected.length) await conversations.save(folder, branchId, [...collected, ...produced]).catch(() => {});
    // The stop latency: from the user's stop to here (a stop by the app closing has none). An error logs the turn's
    // figures too (ruling T3-m1); its event carries none.
    const stopRequestedAt = active.get(runId)?.stopRequestedAt;
    await endLog(aborted
      ? { event: 'end', kind: 'stopped', timing, ...(typeof stopRequestedAt === 'number' ? { stopLatencyMs: Date.now() - stopRequestedAt } : {}) }
      : { event: 'end', kind: 'error', timing: clock.timing(), message });
    // A Stop is the user's own action, taken while they're already looking at the app — never
    // worth an OS notification, unlike a completion or a failure reached while they stepped away.
    if (aborted) post({ kind: 'stopped', timing });
    else finish('error', { message });
  } finally {
    active.delete(runId);
  }
}

/** Whether what is saved now (the pack, gpu_backend) would start another backend than this worker's (D-CUDA-4). */
async function restartNeeded() {
  const [dir, saved] = await Promise.all([cudaPack.installedDir().catch(() => null), savedBackend()]);
  return restartRequired(dir, GPU_BACKEND_CHOICES.includes(saved) ? saved : 'auto');
}
// `install`: the running install's id and last progress, so that a view opened mid-install (the settings tab was left
// and reopened) follows it and can cancel it; null when none runs.
async function cudaPackView() {
  const job = cudaInstall;
  const install = job ? { installId: job.id, receivedBytes: job.received, totalBytes: job.total } : null;
  return { ...await cudaPack.status(), restartRequired: await restartNeeded(), notice: runtimeNotice(), install };
}
// The one CUDA pack install of this worker, if any: { id, controller, received, total }.
let cudaInstall = null;
/** Op cuda-pack-install, up to its answer: reserved before the first await, so two requests cannot both start one. */
async function reserveCudaPackInstall() {
  if (cudaInstall) throw new Error(CUDA_PACK_BUSY);
  // A turn has the machine to itself, and the pack may be the backend it runs on.
  if (active.size > 0) throw new Error(CUDA_PACK_TURN_BUSY);
  const job = { id: randomUUID(), controller: new AbortController(), received: 0, total: 0 };
  cudaInstall = job;
  try {
    if ((await cudaPack.status()).state === 'unavailable') throw new Error(CUDA_PACK_UNAVAILABLE);
  } catch (error) {
    cudaInstall = null;
    throw error;
  }
  return job;
}
/** The install itself, in the background: progress at most every 250 ms, then one done / cancelled / error event. */
async function runCudaPackInstall(job) {
  const post = patch => parentPort.postMessage({ type: 'event', event: 'cuda-pack', installId: job.id, ...patch });
  let last = -Infinity;
  const onProgress = (receivedBytes, totalBytes) => {
    job.received = receivedBytes;
    job.total = totalBytes;
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    post({ state: 'progress', receivedBytes, totalBytes });
  };
  let outcome;
  try {
    await cudaPack.install({ signal: job.controller.signal, onProgress });
    outcome = { state: 'done' };
  } catch (error) {
    outcome = job.controller.signal.aborted ? { state: 'cancelled' } : { state: 'error', message: error instanceof Error ? error.message : 'Erreur interne' };
  }
  if (cudaInstall === job) cudaInstall = null;
  post(outcome);
}

function reply(id, ok, result, error) { parentPort.postMessage({ type: 'response', id, ok, ...(ok ? { result } : { error }) }); }
async function handle(message) {
  const { id, op, payload = {} } = message || {};
  if (!id || !ops.has(op)) { reply(id, false, null, 'Opération IPC inconnue'); return; }
  try {
    let result;
    if (op === 'gguf-list') result = await ggufLibrary.list();
    if (op === 'gguf-add') result = await ggufLibrary.add(payload.path);
    if (op === 'gguf-remove') result = await ggufLibrary.remove(payload.id);
    if (op === 'model-status') result = await modelStatus(settings, ggufLibrary, estimateCache);
    // payload.refresh is accepted and ignored for now: every call re-reads free memory.
    if (op === 'hardware-info') result = { ...await readHardware(), backendChoice: backendChoice(), restartRequired: await restartNeeded() };
    if (op === 'cuda-pack-status') result = await cudaPackView();
    if (op === 'cuda-pack-install') {
      const job = await reserveCudaPackInstall();
      reply(id, true, { installId: job.id });
      void runCudaPackInstall(job);
      return;
    }
    if (op === 'cuda-pack-cancel') {
      const job = cudaInstall && cudaInstall.id === String(payload.installId ?? '') ? cudaInstall : null;
      job?.controller.abort();
      result = { cancelled: Boolean(job) };
    }
    if (op === 'cuda-pack-uninstall') {
      if (active.size > 0) throw new Error(CUDA_PACK_TURN_BUSY);
      await cudaPack.uninstall();
      result = await cudaPackView();
    }
    if (op === 'estimate-model') result = await estimateModel(payload);
    if (op === 'estimate-cancel') result = { cancelled: estimateJobs.cancel(String(payload.estimateId ?? '')) };
    if (op === 'git-status') result = await gitStatus(payload.folder);
    // OPENAGENT_HF_ENDPOINT lets tests point this at a local fake server instead of the real
    // HuggingFace API — never set outside tests.
    if (op === 'test-hf-token') result = await testHfToken(payload.token, process.env.OPENAGENT_HF_ENDPOINT ? { baseUrl: process.env.OPENAGENT_HF_ENDPOINT } : undefined);
    if (op === 'migrate-data-dir') {
      result = await migrateDataDir(dataHome, defaultHome, payload.newDir);
      // The data home moved: a turn line now would recreate logs/turns in the old one. Nothing more until the restart.
      turnLog.suspend();
    }
    if (op === 'init-project') result = await initializeProject(payload.folder, Boolean(payload.overwrite));
    if (op === 'plugin-list') {
      const folder = payload.folder ?? null;
      if (!folder) {
        // No active project: no built-in tool set to collide with yet — the global plugins as loaded.
        const { tools, errors } = await loadPlugins(null, dataHome);
        result = { tools: tools.map(t => t.name), errors, untrusted: [] };
      } else {
        const projectTrust = await trust.evaluate(folder);
        const effective = await settings.effective(folder, { approvedRelaxations: projectTrust.approvedRelaxations });
        // Parity row 33: the Outils tab never starts an MCP server. Plugin names are checked against the built-in tools
        // and the MCP names a turn would offer from what it last discovered — a server not started has none yet.
        const builtIn = await builtInTools(folder, effective);
        const remembered = rememberedMcpStatus(folder, await mcpServersFor(folder, projectTrust), builtIn).flatMap(status => status.tools ?? []);
        const { tools, errors } = await pluginToolsBeside(folder, [...builtIn, ...remembered.map(name => ({ name }))], projectTrust);
        // Parity row 32: a project awaiting a decision has its .py listed like its .mjs (not loaded, not reported); one with
        // nothing to approve has them reported (pluginToolsBeside), never listed « non approuvé ».
        const awaitingDecision = !projectTrust.contentTrusted && projectTrust.contentStatus !== 'none';
        const untrusted = awaitingDecision ? [...projectTrust.inventory.plugins, ...await projectPythonListing(folder)] : [];
        result = { tools: tools.map(t => t.name), errors, untrusted };
      }
    }
    if (op === 'project-trust') result = trustView(await trust.evaluate(payload.folder));
    if (op === 'trust-project') {
      result = trustView(payload.decision === 'revoke'
        ? await trust.revoke(payload.folder)
        : await trust.decide(payload.folder, payload.decision, payload.token));
      if (payload.decision === 'revoke' || payload.decision === 'ignored') forgetSessionAllowed(payload.folder);
    }
    // Every MCP op's reply goes through redactSecrets: env/header values never reach the renderer.
    if (op === 'mcp-list') result = redactSecrets(await mcpServersForDisplay(payload.folder ?? null));
    if (op === 'mcp-add') result = redactSecrets(await mcpConfig.add(payload.commandLine));
    if (op === 'mcp-add-remote') result = redactSecrets(await mcpConfig.addRemote(payload.url, payload.type, payload.headers));
    if (op === 'mcp-remove') {
      // What the turns learned of it goes with it: added again later, it is « non démarré » until a turn starts it.
      const removed = (await mcpConfig.list()).find(server => server.id === payload.id);
      result = redactSecrets(await mcpConfig.remove(payload.id));
      // Kept while another global entry runs that same server (same identity, same key).
      const key = removed && mcpDiscoveryKey(null, removed);
      if (key && !result.some(server => mcpDiscoveryKey(null, server) === key)) mcpDiscoveries.delete(key);
    }
    if (op === 'list_folders') result = await folders.list();
    if (op === 'index-status') result = indexStatus.get(resolve(String(payload.folder))) ?? { state: 'idle' };
    if (op === 'knowledge-list') result = await listKnowledgeSources(dataHome);
    if (op === 'knowledge-add') result = await addFileToKnowledge(payload.filePath, dataHome);
    if (op === 'knowledge-remove') result = await removeKnowledgeSource(payload.source, dataHome);
    if (op === 'activate_folder') {
      // `folder`: the canonical path the history stores (core/folders.mts) — the Sidebar activates every opened folder
      // (dialog, history, typed path) under it. The index is keyed on it too: its 'index' events and index-status name
      // the folder the renderer activates, not `C:/X/PROJ` typed (or a junction picked) for `C:\x\proj`.
      const { folder: canonical, folders: list } = await folders.open(payload.folder);
      const history = await conversations.messages(payload.folder, 'main').catch(() => []);
      result = { history: servedMessages(history), folders: list, folder: canonical };
      void triggerIndexing(canonical);
    }
    if (op === 'settings') result = payload.folder ? await settings.project(payload.folder) : await settings.publicGlobal();
    if (op === 'save_settings') {
      if (!payload.folder) { await settings.saveGlobal(payload.settings || {}); result = await settings.publicGlobal(); }
      else {
        const patch = { agent_mode: payload.settings?.agent_mode || 'inherit', custom_prompt: payload.settings?.custom_prompt || '' };
        result = await settings.saveProject(payload.folder, patch);
        await approveSavedFields(payload.folder, patch);
      }
    }
    if (op === 'compact') {
      const folder = payload.folder;
      const branchId = payload.branchId || 'main';
      if (compactingIn(folder)) throw new Error('Une compaction est déjà en cours dans ce dossier.');
      if (runningIn(folder)) throw new Error('Un message est en cours dans ce dossier : attends la fin avant de compresser.');
      // Reserve the folder BEFORE the first await: two requests must not both pass the checks above.
      const compactionId = randomUUID();
      active.set(compactionId, { controller: new AbortController(), folder, kind: 'compact' });
      let before;
      let turn;
      try {
        before = await conversations.messages(folder, branchId);
        planCompaction(before); // too short → refused right away, model never called
        turn = await turnProvider(payload);
      } catch (error) {
        active.delete(compactionId);
        throw error;
      }
      reply(id, true, { compactionId });
      void runCompaction(compactionId, folder, branchId, before, turn);
      return;
    }
    if (op === 'send') {
      // A run appends to the same transcript the summary is about to replace.
      if (compactingIn(payload.folder)) throw new Error('Une compaction est en cours dans ce dossier : attends la fin avant d’envoyer un message.');
      // `keep` (✏️ edit / 🔄 regenerate): cut the saved history to its first `keep` messages before the turn.
      // Checked here, before the reply, so a refusal reaches the page and nothing has been touched.
      const keep = payload.keep;
      if (keep !== undefined) {
        if (!Number.isInteger(keep) || keep < 0) throw new Error('Paramètre keep invalide : un entier positif ou nul est attendu.');
        const saved = await conversations.messages(payload.folder, payload.branchId || 'main');
        if (keep > saved.length) throw new Error('L’historique enregistré est plus court que la conversation affichée : recharge-la avant de réessayer.');
      }
      // The files of the message (📎 / paste / drop), checked before anything starts like `keep` above: the page is
      // not trusted to send only what its own upload code produced.
      const attachments = validateAttachments(payload.attachments);
      // Same principle for the model: none active, or one whose file is gone, is reported synchronously, not as
      // a run that starts and immediately errors.
      const turn = await turnProvider(payload);
      const runId = randomUUID();
      reply(id, true, { runId });
      // Fire-and-forget: the turn's real result streams back as 'event' messages, not
      // as this request's response (main.cjs's 30s IPC timeout could never cover a full
      // multi-step agent run).
      void runSend(runId, payload.folder, payload.branchId || 'main', payload.text, keep, attachments, turn);
      return;
    }
    if (op === 'stop') {
      // A turn says « stopping » at once, then aborts: the stop takes effect at the next point that checks it (a
      // prompt being read by node-llama-cpp is not one: it ends first). A compaction is only aborted.
      const run = active.get(payload.runId);
      if (run?.kind === 'send') {
        run.stopRequestedAt ??= Date.now();
        run.phase('stopping');
      }
      run?.controller.abort();
      result = { stopped: true };
    }
    if (op === 'shutdown') {
      // The app is closing: abort what is running and stop every dev server run_command started,
      // whole process trees included — terminating this thread would leave them running.
      for (const run of active.values()) run.controller.abort();
      estimateJobs.cancelAll();
      cudaInstall?.controller.abort();
      // MCP processes too: a discovery has no abort signal, and a call's session only closes once it unwinds.
      await Promise.all([stopAllServers(), stopAllMcpServers()]);
      // Then the local model and the Llama: several gigabytes of RAM/VRAM, freed rather than left to the exit.
      await disposeLlama();
      result = { stopped: true };
    }
    if (op === 'permission-decision') {
      const pending = pendingPermissions.get(payload.requestId);
      if (pending) {
        pendingPermissions.delete(payload.requestId);
        if (payload.always && payload.allow) sessionAllowed.add(allowKey(pending.folder, pending.tool));
        pending.resolve(payload.allow);
      }
      result = { ok: true };
    }
    if (op === 'global-settings') result = await settings.publicGlobal();
    if (op === 'project-settings') result = await settings.project(payload.folder);
    // Replies go through publicGlobal(): the HuggingFace token is written to disk but must
    // never travel back to the renderer (only hf_token_configured does).
    if (op === 'save-global-settings') { await settings.saveGlobal(payload.patch); result = await settings.publicGlobal(); }
    if (op === 'save-project-settings') {
      result = await settings.saveProject(payload.folder, payload.patch);
      await approveSavedFields(payload.folder, payload.patch);
    }
    // Zone Danger: none of these delete project files — history and sidebar entries only.
    if (op === 'clear-history') {
      // An agent run or a compaction is about to write its transcript into this history: clearing it now
      // would be undone (or corrupted) a moment later. Same defence as `fork`.
      if (runningIn(payload.folder)) throw new Error('Un message est en cours dans ce dossier : attends la fin avant d’effacer l’historique.');
      result = await conversations.clear(payload.folder);
    }
    if (op === 'remove-folder') result = await folders.remove(payload.folder);
    if (op === 'reset-global-settings') result = await settings.resetGlobal();
    if (op === 'list-prompts') result = await promptLibrary.list();
    if (op === 'read-project-memory') result = await readProjectMemory(payload.folder);
    if (op === 'export-conversation') result = await exportConversation(payload.folder, payload.branchId || 'main', payload.format);
    if (op === 'list-branches') result = await conversations.list(payload.folder);
    if (op === 'messages') result = servedMessages(await conversations.messages(payload.folder, payload.branchId || 'main'));
    if (op === 'save-messages') result = await conversations.save(payload.folder, payload.branchId || 'main', payload.messages);
    if (op === 'fork') {
      // The transcript on disk is only complete once the run ended: forking mid-run would cut
      // at an index the renderer computed from a longer, not yet saved, view.
      if (runningIn(payload.folder)) throw new Error('Un message est en cours dans ce dossier : attends la fin avant de créer une branche.');
      result = await conversations.fork(payload.folder, payload.source || 'main', payload.count, payload.label);
    }
    reply(id, true, result);
  } catch (error) { reply(id, false, null, error instanceof Error ? error.message : 'Erreur interne'); }
}
parentPort?.on('message', handle);
