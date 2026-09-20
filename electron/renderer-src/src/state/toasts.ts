export type ToastKind = 'positive' | 'warning' | 'negative';

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}

// ui.notify() stacks messages; a burst must not cover the window, so only the newest few stay.
export const MAX_TOASTS = 3;

export function pushToast(list: readonly Toast[], toast: Toast): Toast[] {
  return [...list, toast].slice(-MAX_TOASTS);
}

export function dropToast(list: readonly Toast[], id: number): Toast[] {
  return list.filter(toast => toast.id !== id);
}
