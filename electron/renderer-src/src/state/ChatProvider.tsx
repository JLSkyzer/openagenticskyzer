import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import {
  compactConversation,
  decidePermission,
  forkBranch,
  getConnection,
  getGlobalSettings,
  getMessages,
  listBranches,
  onAgentEvent,
  onSettingsChanged,
  sendMessage,
  stop,
  type AgentEvent,
  type ChatMessage,
} from '../ipc/bridge';
import { canForkAt, nextBranchLabel } from './branches';
import { computeContext, type ContextUsage } from './context';
import { chatReducer, initialChatState, type ChatState } from './reducer';

// What the gauge needs from the settings (all global) and from the active connection (its provider
// decides the default context window).
export interface ContextSettings {
  show_context_bar: boolean;
  auto_compact: boolean;
  compact_threshold: number;
  max_tokens: number | null;
  reserved_tokens: number;
  provider: string | null;
}
// Same defaults as the settings service, used until the first read answers.
const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  show_context_bar: true, auto_compact: true, compact_threshold: 70, max_tokens: null, reserved_tokens: 2048, provider: null,
};

function readContextSettings(global: Record<string, unknown>, provider: string | null): ContextSettings {
  const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    show_context_bar: typeof global.show_context_bar === 'boolean' ? global.show_context_bar : DEFAULT_CONTEXT_SETTINGS.show_context_bar,
    auto_compact: typeof global.auto_compact === 'boolean' ? global.auto_compact : DEFAULT_CONTEXT_SETTINGS.auto_compact,
    compact_threshold: number(global.compact_threshold, DEFAULT_CONTEXT_SETTINGS.compact_threshold),
    max_tokens: typeof global.max_tokens === 'number' && Number.isFinite(global.max_tokens) ? global.max_tokens : null,
    reserved_tokens: number(global.reserved_tokens, DEFAULT_CONTEXT_SETTINGS.reserved_tokens),
    provider,
  };
}

interface ChatContextValue {
  state: ChatState;
  activeFolder: string | null;
  // The gauge: usage of the messages on screen, derived on every render, never stored.
  context: { usage: ContextUsage; settings: ContextSettings };
  // Summarise the conversation on screen (context_bar.py::trigger_compact).
  compact(): Promise<void>;
  send(text: string): Promise<void>;
  stopRun(): Promise<void>;
  decide(allow: boolean, always: boolean): Promise<void>;
  // Branch off the current view right after the user message at `index` (chat.py::_fork_from).
  forkFrom(index: number): Promise<void>;
  switchBranch(id: string): Promise<void>;
  dismissNotice(): void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

interface ChatProviderProps {
  activeFolder: string | null;
  // The Sidebar's own activate_folder call already returns this history — re-fetching
  // it here via a second async round trip is not just redundant, it is a real race: if
  // that fetch resolves after a send() has already started for the new folder, its
  // 'folder-loaded' dispatch resets the whole reducer state and silently discards the
  // in-flight run. Taking it as a prop keeps the dispatch synchronous with the folder
  // change instead.
  initialMessages: ChatMessage[];
  children: ReactNode;
}

export function ChatProvider({ activeFolder, initialMessages, children }: ChatProviderProps) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const initialMessagesRef = useRef(initialMessages);
  initialMessagesRef.current = initialMessages;
  // Async branch operations run across several awaits: they must read the state and folder as they
  // are when each await resumes, not as they were when the click happened.
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeFolderRef = useRef(activeFolder);
  activeFolderRef.current = activeFolder;

  useEffect(() => {
    if (!activeFolder) return;
    dispatch({ type: 'folder-loaded', messages: initialMessagesRef.current });
    // The saved forks live on disk (unlike the NiceGUI app, which lost them at restart): list them
    // for this folder. `cancelled` drops the answer if the user already moved to another folder.
    let cancelled = false;
    listBranches(activeFolder)
      .then(branches => { if (!cancelled) dispatch({ type: 'branches-loaded', branches }); })
      .catch(error => {
        if (!cancelled) dispatch({ type: 'branch-failed', error: error instanceof Error ? error.message : 'Branches illisibles' });
      });
    return () => { cancelled = true; };
    // Intentionally keyed on activeFolder alone: this must fire exactly once per folder
    // switch, reading whichever initialMessages the Sidebar handed over for that same
    // switch — not on every initialMessages identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolder]);

  // The end of a compaction can be delivered before compact() has seen the answer that names it:
  // keep it, compact() replays it right after registering the compaction, so the chat is never left
  // waiting for an event that already went by.
  const endedCompactions = useRef(new Map<string, AgentEvent>());
  useEffect(
    () =>
      onAgentEvent(event => {
        if (event.kind === 'compacted' || event.kind === 'compact-failed') endedCompactions.current.set(event.runId, event);
        dispatch({ type: 'agent-event', event });
      }),
    [],
  );

  // Settings and provider of the gauge: read again for each folder and after any save made elsewhere
  // (settings dialog, model dialog) — the bridge announces those.
  const [contextSettings, setContextSettings] = useState<ContextSettings>(DEFAULT_CONTEXT_SETTINGS);
  const [settingsVersion, setSettingsVersion] = useState(0);
  useEffect(() => onSettingsChanged(() => setSettingsVersion(version => version + 1)), []);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getGlobalSettings(), getConnection(activeFolder)])
      .then(([global, connection]) => { if (!cancelled) setContextSettings(readContextSettings(global, connection.provider)); })
      .catch(() => { /* keep what is shown: a gauge that cannot read its settings must not break the chat */ });
    return () => { cancelled = true; };
  }, [activeFolder, settingsVersion]);

  const usage = useMemo(
    () => computeContext(state.messages, { provider: contextSettings.provider, max_tokens: contextSettings.max_tokens, reserved_tokens: contextSettings.reserved_tokens }),
    [state.messages, contextSettings],
  );

  const compact = useCallback(async () => {
    const folder = activeFolderRef.current;
    const before = stateRef.current;
    if (!folder || before.agentRunning || before.compacting) return;
    try {
      const { compactionId } = await compactConversation(folder, before.currentBranchId);
      if (activeFolderRef.current !== folder) return;
      dispatch({ type: 'compaction-started', id: compactionId });
      const early = endedCompactions.current.get(compactionId);
      if (early) dispatch({ type: 'agent-event', event: early });
      endedCompactions.current.delete(compactionId);
    } catch (error) {
      dispatch({ type: 'show-error', error: error instanceof Error ? error.message : 'Compression impossible' });
    }
  }, []);

  const forkFrom = useCallback(async (index: number) => {
    const folder = activeFolderRef.current;
    const before = stateRef.current;
    if (!folder || before.agentRunning) return;
    const source = before.currentBranchId;
    const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
    try {
      const persisted = await getMessages(folder, source);
      if (activeFolderRef.current !== folder) return;
      if (!canForkAt(persisted, before.messages, index)) {
        // Branching at a guessed place would be worse than not branching: show what is really saved.
        dispatch({ type: 'branch-switched', id: source, messages: persisted });
        dispatch({ type: 'branch-failed', error: 'La conversation affichée ne correspondait plus à celle enregistrée : elle a été rechargée, réessaie.' });
        return;
      }
      const created = await forkBranch(folder, source, index + 1, nextBranchLabel(before.branches));
      const [branches, messages] = await Promise.all([listBranches(folder), getMessages(folder, created.id)]);
      if (activeFolderRef.current !== folder) return;
      // A message sent while the fork was being created keeps the view it started on; the new
      // branch still exists, so it must appear in the selector.
      if (stateRef.current.agentRunning) { dispatch({ type: 'branches-loaded', branches }); return; }
      dispatch({ type: 'branch-created', id: created.id, label: created.label, branches, messages });
    } catch (error) {
      dispatch({ type: 'branch-failed', error: message(error, 'Impossible de créer la branche') });
    }
  }, []);

  const switchBranch = useCallback(async (id: string) => {
    const folder = activeFolderRef.current;
    const before = stateRef.current;
    if (!folder || before.agentRunning || id === before.currentBranchId) return;
    try {
      const messages = await getMessages(folder, id);
      if (activeFolderRef.current !== folder) return;
      dispatch({ type: 'branch-switched', id, messages });
    } catch (error) {
      dispatch({ type: 'branch-failed', error: error instanceof Error ? error.message : 'Impossible de changer de branche' });
    }
  }, []);

  const dismissNotice = useCallback(() => dispatch({ type: 'clear-notice' }), []);

  const send = useCallback(
    async (text: string) => {
      if (!activeFolder || !text.trim()) return;
      try {
        const { runId } = await sendMessage(activeFolder, state.currentBranchId, text);
        dispatch({ type: 'send-started', runId, text });
      } catch (error) {
        // Without this, a rejected IPC call (e.g. connections.resolve() refusing an
        // unconfirmed key/endpoint pairing) left the send silently doing nothing — no
        // message, no error, no way out of the input box short of restarting the app.
        dispatch({ type: 'send-failed', error: error instanceof Error ? error.message : 'Échec de l’envoi du message' });
      }
    },
    [activeFolder, state.currentBranchId],
  );

  const stopRun = useCallback(async () => {
    if (state.runId) await stop(state.runId);
  }, [state.runId]);

  const decide = useCallback(
    async (allow: boolean, always: boolean) => {
      if (!state.runId || !state.pendingPermission) return;
      await decidePermission(state.runId, state.pendingPermission.requestId, allow, always);
      dispatch({ type: 'permission-decided' });
    },
    [state.runId, state.pendingPermission],
  );

  return (
    <ChatContext.Provider
      value={{ state, activeFolder, context: { usage, settings: contextSettings }, compact, send, stopRun, decide, forkFrom, switchBranch, dismissNotice }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat doit être utilisé à l’intérieur de ChatProvider');
  return ctx;
}
