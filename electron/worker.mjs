import { parentPort } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { writeFile, realpath, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SettingsService } from './core/settings.mts';
import { Conversations } from './core/conversations.mts';
import { FoldersService } from './core/folders.mts';
import { GgufLibrary } from './core/gguf-library.mts';
import { localProvider } from './core/local-engine.mts';
import { offeredTools, runAgent, TOOL_NAME_PATTERN } from './core/agent.mts';
import { basePrompt } from './core/system-prompt.mts';
import { ChatProvider } from './core/provider.mts';
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
import { contextWindow } from './core/context-budget.mts';
import { closeDanglingCalls } from './core/request-context.mts';
import { buildHtml, buildJson, buildMarkdown, exportFilename, renderEntries } from './core/export.mts';
import { cleanupOldFolders } from './core/cleanup.mts';
import { gitStatus } from './core/git-status.mts';
import { testHfToken } from './core/hf-token.mts';
import { migrateDataDir, resolveDataHome } from './core/data-dir.mts';
import { initializeProject, projectTools } from './core/project-analyzer.mts';
import { McpConfigStore, readProjectMcpConfig, mergeServerConfigs, redactSecrets, expandServerPlaceholders } from './core/mcp-config.mts';
import { mcpTools } from './core/mcp-client.mts';
import { searchTools } from './core/search-tools.mts';
import { indexFolder } from './core/semantic-index.mts';
import { loadPlugins } from './core/plugin-loader.mts';
import { ProjectTrustService } from './core/project-trust.mts';
import { addFileToKnowledge, listSources as listKnowledgeSources, removeSource as removeKnowledgeSource } from './core/knowledge-base.mts';

// OPENAGENT_HOME lets integration tests point the whole data layer at a temp directory
// instead of the real user's ~/.openagent — never rely on the default outside tests, and it
// always bypasses the redirect below so a test never touches the real developer's data home.
const defaultHome = process.env.OPENAGENT_HOME || join(homedir(), '.openagent');
const dataHome = process.env.OPENAGENT_HOME ? defaultHome : await resolveDataHome(defaultHome);
// A send turn finishing at or beyond this duration is flagged 'longRunning' so main.cjs can
// raise a native OS notification (mirrors the previous NiceGUI app's notifier.py threshold).
// OPENAGENT_LONG_RUN_MS lets tests use a real (not mocked) but fast agent turn instead of
// waiting out a real 10s — never rely on it outside tests.
const LONG_RUN_MS = Number(process.env.OPENAGENT_LONG_RUN_MS) || 10_000;
// OPENAGENT_PROVIDER_IDLE_MS shortens the provider's silence timeout (120 s) so a test can prove the expiry
// with a real silent server instead of waiting two minutes — never rely on it outside tests.
const PROVIDER_IDLE_MS = Number(process.env.OPENAGENT_PROVIDER_IDLE_MS) || undefined;
const settings = new SettingsService(dataHome);
const trust = new ProjectTrustService(dataHome, settings);
const conversations = new Conversations();
const folders = new FoldersService(dataHome);
const ggufLibrary = new GgufLibrary(dataHome);
const promptLibrary = new PromptLibrary(dataHome);
const mcpConfig = new McpConfigStore(dataHome);
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
    await indexFolder(folder, dataHome, (current, total) => postIndexEvent(folder, { state: 'indexing', current, total }));
    postIndexEvent(folder, { state: 'ready', current: undefined, total: undefined, message: undefined });
  } catch (error) {
    postIndexEvent(folder, { state: 'error', current: undefined, total: undefined, message: error instanceof Error ? error.message : 'Erreur interne' });
  }
}
// Archives (core/cleanup.mts: moves into <dataHome>/retention-archive/, never deletes) the conversation history of
// projects unused beyond session_retention_days (0 = keep forever). Run once at startup, before the worker starts
// taking requests. Never let a corrupt config/folders file crash the worker.
await cleanupOldFolders(folders, (await settings.global().catch(() => ({ session_retention_days: 0 }))).session_retention_days, dataHome).catch(() => {});
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
// 'shutdown' is internal: main.cjs sends it directly when the app closes; it is not in main's
// renderer-facing allow-list, so the page cannot call it.
const ops = new Set(['global-settings', 'project-settings', 'save-global-settings', 'save-project-settings', 'list-branches', 'messages', 'save-messages', 'fork', 'list_folders', 'activate_folder', 'settings', 'save_settings', 'send', 'stop', 'permission-decision', 'clear-history', 'remove-folder', 'reset-global-settings', 'compact', 'list-prompts', 'read-project-memory', 'export-conversation', 'gguf-list', 'gguf-add', 'gguf-remove', 'git-status', 'test-hf-token', 'migrate-data-dir', 'init-project', 'mcp-list', 'mcp-add', 'mcp-add-remote', 'mcp-remove', 'index-status', 'knowledge-list', 'knowledge-add', 'knowledge-remove', 'plugin-list', 'project-trust', 'trust-project', 'shutdown']);

// Anything in `active` on this folder — an agent run or a compaction — is writing its transcript.
function runningIn(folder) {
  const target = resolve(String(folder));
  return [...active.values()].some(run => resolve(String(run.folder)) === target);
}
function compactingIn(folder) {
  const target = resolve(String(folder));
  return [...active.values()].some(run => run.kind === 'compact' && resolve(String(run.folder)) === target);
}

/** The window a request must fit in (H3): the built-in engine's real context size (capped by max_tokens when the
 * user set one), else max_tokens or the provider's table entry (core/context-budget.mts). Shared by agent turns
 * and compaction, so the two can never size a request differently. */
async function windowFor(provider, connection, maxTokens) {
  return provider.contextWindow
    ? Math.min(await provider.contextWindow(), maxTokens ?? Number.POSITIVE_INFINITY)
    : contextWindow(connection?.provider ?? null, maxTokens);
}

/**
 * Summarises a branch in the background and reports through events (like `send`: the IPC round trip
 * is capped at 30 s, a summary is not). Nothing is written unless the model answered AND the branch
 * is still exactly what it was when the summary was requested.
 */
async function runCompaction(compactionId, folder, branchId, before, connection, provider) {
  const post = message => parentPort.postMessage({ type: 'event', event: 'agent', runId: compactionId, ...message });
  let outcome;
  try {
    // max_tokens is a global setting only (core/settings.mts), so the global config is the whole answer here.
    const window = await windowFor(provider, connection, (await settings.global()).max_tokens);
    const after = await compactMessages({ provider, connection, messages: before, contextWindow: window, signal: active.get(compactionId).controller.signal });
    await conversations.replaceIfUnchanged(folder, branchId, before, after);
    // context_bar.py::trigger_compact parity: persist the summary itself into the project's
    // memory so it survives a later clear-history/re-compaction. Awaited (not fire-and-forget)
    // so the write is guaranteed done before the 'compacted' event is announced — safe because
    // appendCompactionSummary itself never throws (a memory-write failure never turns an
    // already-successful compaction into a reported failure).
    await appendCompactionSummary(folder, dataHome, after[0].content.slice(SUMMARY_PREFIX.length));
    outcome = { kind: 'compacted', messages: after };
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
  return { effective, tools: [...others, ...pluginTools] };
}

/** Built-in + MCP tools for a real project folder — the project's .mcp.json servers only once the
 * project is trusted (never started or contacted before). */
async function nonPluginTools(folder, effective, projectTrust) {
  const projectServers = projectTrust.contentTrusted ? await readProjectMcpConfig(folder) : [];
  const merged = mergeServerConfigs(await mcpConfig.list(), projectServers);
  const { tools: mcpDiscovered, errors: mcpErrors } = await mcpTools(merged);
  // A broken/unreachable MCP server never blocks the turn or surfaces to the chat — same
  // server-log-only isolation agent.py's own logging.getLogger("openagentic.mcp").warning had.
  for (const error of mcpErrors) console.error(`[mcp] ${error}`);
  const builtIn = [
    ...await workspaceTools(folder, effective.ignored_patterns),
    ...await memoryTools(folder, dataHome),
    ...await gitTools(folder),
    ...projectTools(folder),
    ...await shellTools(folder),
    ...await webTools(),
    ...await searchTools(folder, dataHome),
  ];
  return [...builtIn, ...mcpToolsBeside(mcpDiscovered, builtIn)];
}

/** The discovered MCP tools minus any whose name is invalid or already taken — by a built-in, or
 * by an EARLIER MCP tool: two different servers (e.g. a global and a project filesystem server)
 * easily expose the same tool name, and runAgent refuses a duplicated or invalid name for the
 * WHOLE turn. First registered wins; mergeServerConfigs lists project servers first, so a project
 * server's tool wins over a global one's. Same idiom as pluginToolsBeside, logged like mcpErrors. */
function mcpToolsBeside(discovered, others) {
  const taken = new Set(others.map(tool => tool.name));
  const kept = [];
  for (const tool of discovered) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) console.error(`[mcp] ${tool.name}: nom d’outil invalide, ignoré`);
    else if (taken.has(tool.name)) console.error(`[mcp] ${tool.name}: nom déjà utilisé par un autre outil, ignoré`);
    else { taken.add(tool.name); kept.push(tool); }
  }
  return kept;
}

/** The merged server list for the Outils tab. Trusted project: merged exactly as a turn merges it
 * (placeholders expanded, so the same entries dedupe), each project entry shown as written in
 * .mcp.json — an expanded `${TOKEN}` in args or url is a secret, and those fields are displayed.
 * Untrusted project: its entries are listed (trusted: false) but take no part in the merge — a turn
 * only runs the global ones, so a colliding global entry must not be hidden. A project whose trust
 * cannot be evaluated (invalid .openagent/config.json, folder gone) is untrusted — never a reason to
 * hide the global servers. */
async function mcpServersForDisplay(folder) {
  const global = await mcpConfig.list();
  if (!folder) return global;
  let contentTrusted = false;
  try { contentTrusted = (await trust.evaluate(folder)).contentTrusted; }
  catch (error) { console.error(`[trust] ${folder} : confiance non évaluable, traité comme non approuvé : ${error instanceof Error ? error.message : error}`); }
  const asWritten = await readProjectMcpConfig(folder, { expandEnv: false }).catch(() => []);
  if (!contentTrusted) return [...global, ...asWritten.map(server => ({ ...server, trusted: false }))];
  const byId = new Map(asWritten.map(server => [server.id, server]));
  const merged = mergeServerConfigs(global, asWritten.map(server => expandServerPlaceholders(server)));
  return merged.map(server => (server.scope === 'project' ? { ...(byId.get(server.id) ?? server), trusted: true } : server));
}

/** The folder's plugin tools minus any whose name `others` already uses: runAgent refuses a
 * duplicated name for the WHOLE turn, so one plugin named like a built-in would otherwise break
 * every turn. The project's own plugins only once it is trusted — not even imported before.
 * Shared by registerTools and plugin-list, so the Outils tab shows exactly what a turn gets. */
async function pluginToolsBeside(folder, others, projectTrust) {
  const { tools, errors } = await loadPlugins(folder, dataHome, { includeProject: projectTrust.contentTrusted });
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
async function exportConversation(folder, branchId, format, provider, model) {
  if (!EXPORT_FORMATS.has(format)) throw new Error('Format d’export invalide');
  if (!isAbsolute(folder)) throw new Error('Dossier absolu requis');
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('Dossier introuvable');
  const messages = await conversations.messages(folder, branchId);
  const { tools } = await registerTools(folder);
  const toolCategory = new Map(tools.map(tool => [tool.name, tool.category]));
  const entries = renderEntries(messages, name => toolCategory.get(name));
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

function lastAssistantSummary(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && typeof messages[i].content === 'string' && messages[i].content.trim()) {
      return messages[i].content.slice(0, 100);
    }
  }
  return 'Tâche terminée';
}

/** Runs one agent turn to completion, streaming events to the renderer via parentPort. */
// "réveiller" a .gguf model: `localModel` (a gguf-library id, never a secret — unlike `connection`, which
// main.cjs never injects when this is set, see main.cjs's resolveSendPayload) resolves to a real file path
// and gets an object shaped like ChatProvider (`.complete()`, `.outputCap()`) — agent.mts/compactMessages
// never know the difference; its `.contextWindow()` is the engine's real context size (H3). An id whose file
// is gone (removed from the library, or moved) fails clearly, before anything starts.
async function providerFor(connection, localModel) {
  if (!localModel) return new ChatProvider(undefined, { idleTimeoutMs: PROVIDER_IDLE_MS });
  const modelPath = await ggufLibrary.resolve(localModel);
  if (!modelPath) throw new Error('Modèle local introuvable : il a peut-être été retiré de la bibliothèque. Choisis-en un autre.');
  return localProvider(modelPath);
}

async function runSend(runId, folder, branchId, text, connection, keep, attachments = [], provider) {
  const controller = new AbortController();
  const accumulated = [];
  active.set(runId, { controller, folder });
  const post = message => parentPort.postMessage({ type: 'event', event: 'agent', runId, ...message });
  const startedAt = Date.now();
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
  try {
    // The page already shows the user message (send-started), so the turn is assembled FIRST: from here on, any
    // failure (tools, instructions, the model) saves history + this message, and the file stays aligned with the
    // screen — edit and regenerate cut both at the same index. Only an unreadable conversation file stops here,
    // with nothing to save.
    const saved = await conversations.messages(folder, branchId);
    const history = (keep === undefined ? saved : saved.slice(0, keep)).map(m => ({ ...m, role: normalizeRole(m.role) }));
    // What was typed stays in `content`; the files ride beside it and are expanded only when the model is called.
    collected = [...history, { role: 'user', content: text, ...(attachments.length ? { attachments } : {}) }];
    const { effective, tools } = await registerTools(folder);
    const toolCategory = new Map(tools.map(tool => [tool.name, tool.category]));
    const agentSettings = { mode: effective.agent_mode, permission_mode: effective.permission_mode, files_ask: effective.files_ask, shell_ask: effective.shell_ask, search_ask: effective.search_ask, reserved_tokens: effective.reserved_tokens };
    // The prompt names exactly the tools offered this turn, adds the mode's instruction and, under
    // Windows, how run_command's shell behaves (core/system-prompt.mts).
    const offered = offeredTools(tools, agentSettings).map(tool => tool.name);
    const { instructions } = await buildInstructions({ folder, home: dataHome, base: basePrompt({ tools: offered, mode: agentSettings.mode, platform: process.platform }) });
    const emit = event => {
      const { type: kind, ...rest } = event;
      if (kind === 'delta') partialText += rest.text;
      if (kind === 'message') {
        accumulated.push(rest.message);
        if (rest.message.role === 'assistant') partialText = '';
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
    const contextTokens = await windowFor(provider, connection, effective.max_tokens);
    const result = await runAgent({
      provider, connection, messages: collected, instructions, tools, contextWindow: contextTokens,
      settings: agentSettings,
      signal: controller.signal, confirm, emit,
    });
    await conversations.save(folder, branchId, result);
    finish('done', { summary: lastAssistantSummary(result) });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    const message = error instanceof Error ? error.message : 'Erreur interne';
    // H4: a tool call of THIS run left without its result (Stop during a permission prompt or a running tool,
    // an error) gets one, in call order, so the saved transcript stays valid for every provider. Only this
    // run's messages: an older turn's dangling call is never sent again (H3), and closing it would insert a
    // message mid-list in the file but at the end on screen. Posted too: the screen must hold the same
    // messages as the file, at the same indices (edit/regenerate cut both at the same index).
    const { messages: produced, added } = closeDanglingCalls(accumulated, aborted ? "Interrompu par l'utilisateur" : `Interrompu : ${message}`);
    for (const closing of added) post({ kind: 'message', message: closing });
    // Text already streamed is kept whatever ended the turn — a Stop, a provider gone silent (idle
    // timeout), a cut stream — exactly like a completed message, so the screen and the saved
    // transcript agree.
    if (partialText.trim()) {
      const partial = { role: 'assistant', content: partialText };
      produced.push(partial);
      post({ kind: 'message', message: partial });
    }
    // Persist whatever the model/tools actually produced even on Stop/error — losing an
    // in-flight tool-call's already-emitted messages would silently discard real work. A failure after
    // `collected` is assembled (tools, instructions, the model) saves history + the user message, as the
    // screen shows them. Only a conversation file that could not be read leaves `collected` empty: saving []
    // would empty the branch, or overwrite a file deliberately kept because it could not be read.
    if (collected.length) await conversations.save(folder, branchId, [...collected, ...produced]).catch(() => {});
    // A Stop is the user's own action, taken while they're already looking at the app — never
    // worth an OS notification, unlike a completion or a failure reached while they stepped away.
    if (aborted) post({ kind: 'stopped' });
    else finish('error', { message });
  } finally {
    active.delete(runId);
  }
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
    if (op === 'git-status') result = await gitStatus(payload.folder);
    // OPENAGENT_HF_ENDPOINT lets tests point this at a local fake server instead of the real
    // HuggingFace API — never set outside tests.
    if (op === 'test-hf-token') result = await testHfToken(payload.token, process.env.OPENAGENT_HF_ENDPOINT ? { baseUrl: process.env.OPENAGENT_HF_ENDPOINT } : undefined);
    if (op === 'migrate-data-dir') result = await migrateDataDir(dataHome, defaultHome, payload.newDir);
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
        const { tools, errors } = await pluginToolsBeside(folder, await nonPluginTools(folder, effective, projectTrust), projectTrust);
        result = { tools: tools.map(t => t.name), errors, untrusted: projectTrust.contentTrusted ? [] : projectTrust.inventory.plugins };
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
    if (op === 'mcp-remove') result = redactSecrets(await mcpConfig.remove(payload.id));
    if (op === 'list_folders') result = await folders.list();
    if (op === 'index-status') result = indexStatus.get(resolve(String(payload.folder))) ?? { state: 'idle' };
    if (op === 'knowledge-list') result = await listKnowledgeSources(dataHome);
    if (op === 'knowledge-add') result = await addFileToKnowledge(payload.filePath, dataHome);
    if (op === 'knowledge-remove') result = await removeKnowledgeSource(payload.source, dataHome);
    if (op === 'activate_folder') {
      const list = await folders.recordOpened(payload.folder);
      result = { history: await conversations.messages(payload.folder, 'main').catch(() => []), folders: list };
      void triggerIndexing(payload.folder);
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
      let provider;
      try {
        before = await conversations.messages(folder, branchId);
        planCompaction(before); // too short → refused right away, model never called
        provider = await providerFor(payload.connection, payload.localModel);
      } catch (error) {
        active.delete(compactionId);
        throw error;
      }
      reply(id, true, { compactionId });
      void runCompaction(compactionId, folder, branchId, before, payload.connection, provider);
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
      // Same principle for a local model: an id whose file is gone must be reported synchronously, not as
      // a run that starts and immediately errors.
      const provider = await providerFor(payload.connection, payload.localModel);
      const runId = randomUUID();
      reply(id, true, { runId });
      // Fire-and-forget: the turn's real result streams back as 'event' messages, not
      // as this request's response (main.cjs's 30s IPC timeout could never cover a full
      // multi-step agent run).
      void runSend(runId, payload.folder, payload.branchId || 'main', payload.text, payload.connection, keep, attachments, provider);
      return;
    }
    if (op === 'stop') { active.get(payload.runId)?.controller.abort(); result = { stopped: true }; }
    if (op === 'shutdown') {
      // The app is closing: abort what is running and stop every dev server run_command started,
      // whole process trees included — terminating this thread would leave them running.
      for (const run of active.values()) run.controller.abort();
      await stopAllServers();
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
    if (op === 'export-conversation') result = await exportConversation(payload.folder, payload.branchId || 'main', payload.format, payload.provider || '', payload.model || '');
    if (op === 'list-branches') result = await conversations.list(payload.folder);
    if (op === 'messages') result = await conversations.messages(payload.folder, payload.branchId || 'main');
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
