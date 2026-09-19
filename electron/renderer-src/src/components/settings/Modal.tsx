import { useEffect, type ReactNode } from 'react';

// Card dialog stacked above the maximized settings dialog (settings.py's nested ui.dialog).
// Escape closes ONLY this modal: the listener runs in the capture phase and stops the
// event, so the settings dialog's own Escape handler never sees it.
export function Modal({
  children,
  onClose,
  width = 420,
  tone = 'default',
}: {
  children: ReactNode;
  onClose(): void;
  width?: number;
  tone?: 'default' | 'danger';
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div
        data-testid="oa-modal"
        className="rounded-xl p-4"
        style={{
          width,
          maxWidth: '90vw',
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
