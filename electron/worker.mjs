import { parentPort } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsService } from './core/settings.mts';
import { Conversations } from './core/conversations.mts';
import { FoldersService } from './core/folders.mts';
import { runAgent } from './core/agent.mts';
import { ChatProvider } from './core/provider.mts';
import { workspaceTools } from './core/workspace.mts';
import { buildInstructions } from './core/context.mts';

// OPENAGENT_HOME lets integration tests point the whole data layer at a temp directory
// instead of the real user's ~/.openagent — never rely on the default outside tests.
const dataHome = process.env.OPENAGENT_HOME || join(homedir(), '.openagent');
const settings = new SettingsService(dataHome);
const conversations = new Conversations();
const folders = new FoldersService(dataHome);
const active = new Map();
// requestId -> { resolve(allow), folder, category } — filled by the confirm() callback
// passed to runAgent, drained by the 'permission-decision' op below.
const pendingPermissions = new Map();
const ops = new Set(['global-settings', 'project-settings', 'save-global-settings', 'save-project-settings', 'list-branches', 'messages', 'save-messages', 'fork', 'list_folders', 'activate_folder', 'settings', 'save_settings', 'send', 'stop', 'permission-decision']);

const BASE_SYSTEM_PROMPT = 'Tu es openagent, un assistant de développement qui lit et modifie les fichiers du projet actif via les outils fournis. Explique brièvement ce que tu fais avant d’appeler un outil.';

function normalizeRole(role) {
  if (role === 'ai') return 'assistant';
  if (role === 'human') return 'user';
  return role;
}

const PERMISSION_FIELD = { write: 'files_ask', network: 'search_ask', shell: 'shell_ask' };

/** Runs one agent turn to completion, streaming events to the renderer via parentPort. */
async function runSend(runId, folder, branchId, text, connection) {
  const controller = new AbortController();
  const accumulated = [];
  active.set(runId, { controller });
  const post = message => parentPort.postMessage({ type: 'event', event: 'agent', runId, ...message });
  let collected = [];
  try {
    const effective = await settings.effective(folder);
    const tools = await workspaceTools(folder, effective.ignored_patterns);
    const toolCategory = new Map(tools.map(tool => [tool.name, tool.category]));
    const { instructions } = await buildInstructions({ folder, home: dataHome, base: BASE_SYSTEM_PROMPT });
    const history = (await conversations.messages(folder, branchId)).map(m => ({ ...m, role: normalizeRole(m.role) }));
    collected = [...history, { role: 'user', content: text }];
    const emit = event => {
      const { type: kind, ...rest } = event;
      if (kind === 'message') accumulated.push(rest.message);
      const enriched = { kind, ...rest };
      if (kind === 'tool-start') enriched.category = toolCategory.get(rest.tool);
      post(enriched);
    };
    const confirm = (request, signal) => new Promise((resolve, reject) => {
      const requestId = randomUUID();
      pendingPermissions.set(requestId, { resolve, folder, category: toolCategory.get(request.tool) });
      signal.addEventListener('abort', () => { pendingPermissions.delete(requestId); reject(signal.reason); }, { once: true });
      post({ kind: 'permission-request', requestId, tool: request.tool, category: toolCategory.get(request.tool), arguments: request.arguments });
    });
    const result = await runAgent({
      provider: new ChatProvider(), connection, messages: collected, instructions, tools,
      settings: { mode: effective.agent_mode, permission_mode: effective.permission_mode, files_ask: effective.files_ask, shell_ask: effective.shell_ask, search_ask: effective.search_ask, reserved_tokens: effective.reserved_tokens },
      signal: controller.signal, confirm, emit,
    });
    await conversations.save(folder, branchId, result);
    post({ kind: 'done' });
  } catch (error) {
    // Persist whatever the model/tools actually produced even on Stop/error — losing an
    // in-flight tool-call's already-emitted messages would silently discard real work.
    await conversations.save(folder, branchId, [...collected, ...accumulated]).catch(() => {});
    const aborted = error?.name === 'AbortError';
    post(aborted ? { kind: 'stopped' } : { kind: 'error', message: error instanceof Error ? error.message : 'Erreur interne' });
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
    if (op === 'list_folders') result = await folders.list();
    if (op === 'activate_folder') {
      const list = await folders.recordOpened(payload.folder);
      result = { history: await conversations.messages(payload.folder, 'main').catch(() => []), folders: list };
    }
    if (op === 'settings') result = payload.folder ? await settings.project(payload.folder) : await settings.publicGlobal();
    if (op === 'save_settings') {
      if (!payload.folder) result = await settings.saveGlobal(payload.settings || {});
      else result = await settings.saveProject(payload.folder, { agent_mode: payload.settings?.agent_mode || 'inherit', custom_prompt: payload.settings?.custom_prompt || '' });
    }
    if (op === 'send') {
      const runId = randomUUID();
      reply(id, true, { runId });
      // Fire-and-forget: the turn's real result streams back as 'event' messages, not
      // as this request's response (main.cjs's 30s IPC timeout could never cover a full
      // multi-step agent run).
      void runSend(runId, payload.folder, payload.branchId || 'main', payload.text, payload.connection);
      return;
    }
    if (op === 'stop') { active.get(payload.runId)?.controller.abort(); result = { stopped: true }; }
    if (op === 'permission-decision') {
      const pending = pendingPermissions.get(payload.requestId);
      if (pending) {
        pendingPermissions.delete(payload.requestId);
        const field = PERMISSION_FIELD[pending.category];
        if (payload.always && payload.allow && field) {
          await settings.saveProject(pending.folder, { override_permissions: true, [field]: false }).catch(() => {});
        }
        pending.resolve(payload.allow);
      }
      result = { ok: true };
    }
    if (op === 'global-settings') result = await settings.publicGlobal();
    if (op === 'project-settings') result = await settings.project(payload.folder);
    if (op === 'save-global-settings') result = await settings.saveGlobal(payload.patch);
    if (op === 'save-project-settings') result = await settings.saveProject(payload.folder, payload.patch);
    if (op === 'list-branches') result = await conversations.list(payload.folder);
    if (op === 'messages') result = await conversations.messages(payload.folder, payload.branchId || 'main');
    if (op === 'save-messages') result = await conversations.save(payload.folder, payload.branchId || 'main', payload.messages);
    if (op === 'fork') result = await conversations.fork(payload.folder, payload.source || 'main', payload.count, payload.label);
    reply(id, true, result);
  } catch (error) { reply(id, false, null, error instanceof Error ? error.message : 'Erreur interne'); }
}
parentPort?.on('message', handle);
