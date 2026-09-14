import { parentPort } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsService } from './core/settings.mts';
import { Conversations } from './core/conversations.mts';
import { FoldersService } from './core/folders.mts';

// OPENAGENT_HOME lets integration tests point the whole data layer at a temp directory
// instead of the real user's ~/.openagent — never rely on the default outside tests.
const dataHome = process.env.OPENAGENT_HOME || join(homedir(), '.openagent');
const settings = new SettingsService(dataHome);
const conversations = new Conversations();
const folders = new FoldersService(dataHome);
const active = new Map();
const ops = new Set(['global-settings', 'project-settings', 'save-global-settings', 'save-project-settings', 'list-branches', 'messages', 'save-messages', 'fork', 'list_folders', 'activate_folder', 'settings', 'save_settings', 'send', 'stop']);

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
    if (op === 'send') result = { content: 'Le moteur agent Node est en cours de raccordement ; aucune requête Python ne sera lancée.' };
    if (op === 'stop') result = { stopped: true };
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
