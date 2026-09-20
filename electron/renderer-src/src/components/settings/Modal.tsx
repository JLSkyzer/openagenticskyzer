import { useEffect, useRef, type ReactNode } from 'react';

// Open modals, oldest first: with a confirmation stacked on top of another modal, Escape
// must close the one on top only.
const openModals: object[] = [];

// Card dialog stacked above the maximized settings dialog (settings.py's nested ui.dialog).
// Escape closes ONLY the topmost modal: the listener runs in the capture phase and stops
// the event, so neither the modal below nor the settings dialog's own handler sees it.
export function Modal({
  children,
  onClose,
  width = 420,
  tone = 'default',
  dismissOnBackdrop = false,
}: {
  children: ReactNode;
  onClose(): void;
  width?: number;
  tone?: 'default' | 'danger';
  // A click on the dark backdrop closes it (NiceGUI's ui.dialog does). Off by default: confirmations
  // stacked on the settings dialog must not vanish on a stray click.
  dismissOnBackdrop?: boolean;
}) {
  const identity = useRef({});

  useEffect(() => {
    const me = identity.current;
    openModals.push(me);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || openModals[openModals.length - 1] !== me) return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      openModals.splice(openModals.indexOf(me), 1);
    };
  }, [onClose]);

  return (
    <div
      data-testid="oa-modal-backdrop"
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      // Only a press on the backdrop itself: one that starts inside the card and ends outside (a text
      // selection) must not close it.
      onMouseDown={dismissOnBackdrop ? event => { if (event.target === event.currentTarget) onClose(); } : undefined}
    >
      <div
        data-testid="oa-modal"
        className="rounded-xl p-4"
        style={{
          width,
          maxWidth: '90vw',
          maxHeight: '85vh',
          overflowY: 'auto',
          color: '#e0e0e0',
          background: tone === 'danger' ? '#1a0a0a' : '#111',
          border: tone === 'danger' ? '1px solid #7f1d1d' : '1px solid #2a2a2a',
        }}
      >
        {children}
      </div>
    </div>
  );
}
