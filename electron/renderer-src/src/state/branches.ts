import type { BranchInfo } from '../ipc/types';

interface RoleContent {
  role: string;
  content: string;
}

// Same counter as chat.py::_fork_from — forks only, main excluded, so the second fork is always
// "Branche 2" whatever its parent.
export function nextBranchLabel(branches: readonly BranchInfo[]): string {
  return `Branche ${branches.filter(branch => branch.id !== 'main').length + 1}`;
}

// The worker persists every message of a run, so the displayed index is normally the persisted
// one. That is checked rather than assumed: forking cuts the SAVED conversation at `index + 1`,
// and a view that drifted from it (legacy roles, an interrupted save) would silently branch at
// the wrong message.
export function canForkAt(persisted: readonly RoleContent[], view: readonly RoleContent[], index: number): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= view.length || index >= persisted.length) return false;
  const shown = view[index];
  const saved = persisted[index];
  return roleOf(shown.role) === 'user' && roleOf(saved.role) === 'user' && shown.content === saved.content;
}

// BranchSelector's own "🌿 Main" / label rule, extracted so the export menu and the palette's
// "Depuis : <branche>" line read the exact same thing instead of a second copy of the rule. Falls
// back to "🌿 Main" for an id that cannot be found (defensive: never a blank or wrong label).
export function currentBranchLabel(branches: readonly BranchInfo[], currentBranchId: string): string {
  if (currentBranchId === 'main') return '🌿 Main';
  return branches.find(branch => branch.id === currentBranchId)?.label ?? '🌿 Main';
}

function roleOf(role: string): string {
  return role === 'human' ? 'user' : role === 'ai' ? 'assistant' : role;
}
