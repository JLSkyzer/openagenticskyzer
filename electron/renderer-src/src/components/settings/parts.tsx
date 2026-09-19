import type { ReactNode } from 'react';

// Building blocks copied from settings.py (_section / _group / row pattern) so every tab
// renders the same visual grammar.

export function Section({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="mb-1 flex items-center">
      <span style={{ fontSize: 15, fontWeight: 700, color: '#e0e0e0' }}>{title}</span>
      {badge && (
        <span
          style={{
            background: '#1e1e2e',
            color: '#8b5cf6',
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 3,
            fontWeight: 600,
            marginLeft: 6,
          }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-800" style={{ background: '#111' }}>
      {children}
    </div>
  );
}

export function Row({
  label,
  hint,
  children,
  last,
  labelTestId,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
  last?: boolean;
  labelTestId?: string;
}) {
  return (
    <div className={'flex items-center gap-3 px-4 py-3 ' + (last ? '' : 'border-b border-gray-900')}>
      <div className="flex flex-1 flex-col">
        <span data-testid={labelTestId} className="text-xs font-medium text-gray-300">{label}</span>
        {hint && <span className="text-xs text-gray-600">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// settings.py's ui.switch: a boolean control identified by data-setting for the tests.
export function Toggle({ setting, checked, onChange }: { setting: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <input
      type="checkbox"
      data-setting={setting}
      checked={checked}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 cursor-pointer accent-purple-500"
    />
  );
}

export function Placeholder({ text }: { text: string }) {
  return <div className="text-xs text-gray-600">{text}</div>;
}
