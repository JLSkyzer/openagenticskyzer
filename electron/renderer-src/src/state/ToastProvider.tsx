import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { dropToast, pushToast, type Toast, type ToastKind } from './toasts';

const TOAST_MS = 3500;

interface ToastApi {
  notify(text: string, kind?: ToastKind): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_CLASS: Record<ToastKind, string> = {
  positive: 'bg-green-700',
  warning: 'bg-yellow-700',
  negative: 'bg-red-700',
};

// ui.notify(): a short message that goes away by itself. Application-wide, unlike the notice of the chat, so
// it survives a chat that is remounted (clearing the history rebuilds it, and "Historique effacé." must still show).
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const notify = useCallback((text: string, kind: ToastKind = 'positive') => {
    const id = ++nextId.current;
    setToasts(list => pushToast(list, { id, text, kind }));
    setTimeout(() => setToasts(list => dropToast(list, id)), TOAST_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div data-testid="oa-toast-host" className="pointer-events-none fixed right-4 top-12 z-[80] flex flex-col gap-2">
        {toasts.map(toast => (
          <div
            key={toast.id}
            role="status"
            data-testid="oa-toast"
            data-kind={toast.kind}
            className={`rounded px-3 py-2 text-xs text-white shadow-lg ${KIND_CLASS[toast.kind]}`}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast doit être utilisé à l’intérieur de ToastProvider');
  return api;
}
