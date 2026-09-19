import { useTheme } from '../../theme/ThemeProvider';
import { Group, Row, Section } from './parts';

// Mirrors settings.py's Apparence tab: two theme buttons and a color input. Both apply
// immediately and persist through ThemeProvider (no need to press Enregistrer), exactly
// like the NiceGUI original (_set_theme / normalize_accent write straight away).
export function AppearanceTab() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  const themeButton = (id: string, name: 'dark' | 'light', label: string) => (
    <button
      id={id}
      onClick={() => setTheme(name)}
      className="rounded-lg px-3 py-1.5 text-xs"
      style={{
        background: theme === name ? 'var(--accent)' : '#1f2937',
        color: theme === name ? '#fff' : '#d1d5db',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Apparence" badge="GLOBAL" />
        <Group>
          <Row label="Thème" hint="Sombre ou clair, appliqué immédiatement">
            <div className="flex gap-2">
              {themeButton('oa-theme-dark-btn', 'dark', '🌙 Sombre')}
              {themeButton('oa-theme-light-btn', 'light', '☀️ Clair')}
            </div>
          </Row>
          <Row label="Couleur d’accent" hint="Format #RRGGBB" last>
            <input
              id="oa-accent-input"
              type="color"
              value={accent}
              onChange={event => setAccent(event.target.value)}
              className="h-7 w-12 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </Row>
        </Group>
      </div>
    </div>
  );
}
