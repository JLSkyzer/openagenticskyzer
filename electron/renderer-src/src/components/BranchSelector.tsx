import { useChat } from '../state/ChatProvider';

// chat.py::branch_selector: a 🌿 label and a select of "🌿 Main" + the fork labels, shown only once
// at least one fork exists. Disabled while the agent runs (the NiceGUI switch is a no-op then).
export function BranchSelector() {
  const { state, switchBranch } = useChat();
  if (!state.branches.some(branch => branch.id !== 'main')) return null;

  return (
    <div className="flex items-center gap-2 px-5 pt-2" data-testid="oa-branch-selector">
      <span className="text-xs text-gray-600">🌿</span>
      <select
        data-testid="oa-branch-select"
        aria-label="Branche de la conversation"
        value={state.currentBranchId}
        disabled={state.agentRunning}
        onChange={event => void switchBranch(event.target.value)}
        className="max-w-36 rounded border border-gray-700 bg-gray-900 px-1 py-0.5 text-xs text-gray-300 outline-none disabled:opacity-50"
      >
        {state.branches.map(branch => (
          <option key={branch.id} value={branch.id}>
            {branch.id === 'main' ? '🌿 Main' : branch.label}
          </option>
        ))}
      </select>
    </div>
  );
}
