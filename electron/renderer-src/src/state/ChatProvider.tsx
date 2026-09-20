import { createContext, useCallback, useContext, useEffect, useReducer, useRef, type ReactNode } from 'react';
import {
  decidePermission,
  forkBranch,
  getMessages,
  listBranches,
  onAgentEvent,
  sendMessage,
  stop,
  type ChatMessage,
} from '../ipc/bridge';
import { canForkAt, nextBranchLabel } from './branches';
import { chatReducer, initialChatState, type ChatState } from './reducer';

interface ChatContextValue {
  state: ChatState;
  activeFolder: string | null;
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

  useEffect(() => onAgentEvent(event => dispatch({ type: 'agent-event', event })), []);

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
    <ChatContext.Provider value={{ state, activeFolder, send, stopRun, decide, forkFrom, switchBranch, dismissNotice }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat doit être utilisé à l’intérieur de ChatProvider');
  return ctx;
}
