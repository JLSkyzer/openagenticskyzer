import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getGlobalSettings, saveGlobalSettings } from '../ipc/bridge';
import './theme.css';

type ThemeName = 'dark' | 'light';

// Matches theme.py::_HEX_COLOR / _DEFAULT_ACCENT exactly.
const ACCENT_HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_ACCENT = '#3b82f6';

interface ThemeState {
  theme: ThemeName;
  accent: string;
  setTheme(theme: ThemeName): void;
  setAccent(accent: string): void;
  reload(): Promise<void>;
}

const ThemeContext = createContext<ThemeState | null>(null);

function applyToDocument(theme: ThemeName, accent: string) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.setProperty('--accent', ACCENT_HEX.test(accent) ? accent : DEFAULT_ACCENT);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>('dark');
  const [accent, setAccentState] = useState(DEFAULT_ACCENT);

  // (Re)load the persisted theme — global-settings is already served by
  // worker.mjs/SettingsService. Also used after the global settings were reset.
  const reload = useCallback(async () => {
    try {
      const settings = await getGlobalSettings();
      const nextTheme: ThemeName = settings.theme === 'light' ? 'light' : 'dark';
      const nextAccent = ACCENT_HEX.test(settings.accent_color) ? settings.accent_color : DEFAULT_ACCENT;
      setThemeState(nextTheme);
      setAccentState(nextAccent);
      applyToDocument(nextTheme, nextAccent);
    } catch {
      // Keep the dark/default-accent initial state — no settings backend available
      // yet is not a reason to crash with an unhandled rejection.
      applyToDocument('dark', DEFAULT_ACCENT);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setTheme = useCallback(
    (next: ThemeName) => {
      setThemeState(next);
      applyToDocument(next, accent);
      void saveGlobalSettings({ theme: next });
    },
    [accent],
  );

  const setAccent = useCallback(
    (next: string) => {
      if (!ACCENT_HEX.test(next)) return;
      setAccentState(next);
      applyToDocument(theme, next);
      void saveGlobalSettings({ accent_color: next });
    },
    [theme],
  );

  return <ThemeContext.Provider value={{ theme, accent, setTheme, setAccent, reload }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme doit être utilisé à l’intérieur de ThemeProvider');
  return ctx;
}
