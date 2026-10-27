import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { msg } from './i18n.js';

type Theme = 'dark' | 'light';
type Accent = 'phosphor' | 'indigo' | 'blue' | 'emerald' | 'rose' | 'amber' | 'violet';

interface ThemeContextValue {
  theme: Theme;
  accent: Accent;
  setTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_KEY = 'ninedeploy.theme';
// v2: renamed so the pre-brand default (indigo) stored by earlier versions is
// ignored once — everyone gets the brand phosphor accent out of the box,
// while explicit choices (incl. indigo) still persist from now on.
const ACCENT_KEY = 'ninedeploy.accent.v2';

export const ACCENTS: Array<{ id: Accent; label: string; color: string }> = [
  // Brand accent — the logo teal used across the marketing website.
  { id: 'phosphor', label: msg('Phosphor'), color: '#4ecdc4' },
  { id: 'indigo', label: msg('Indigo'), color: '#6366f1' },
  { id: 'blue', label: msg('Blue'), color: '#3b82f6' },
  { id: 'emerald', label: msg('Emerald'), color: '#10b981' },
  { id: 'rose', label: msg('Rose'), color: '#f43f5e' },
  { id: 'amber', label: msg('Amber'), color: '#f59e0b' },
  { id: 'violet', label: msg('Violet'), color: '#8b5cf6' },
];

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  const [accent, setAccentState] = useState<Accent>(() => {
    try {
      const stored = localStorage.getItem(ACCENT_KEY);
      return ACCENTS.find((a) => a.id === stored)?.id ?? 'phosphor';
    } catch { return 'phosphor'; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-accent', accent);
    try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* ignore */ }
  }, [accent]);

  const setTheme = (t: Theme) => setThemeState(t);
  const setAccent = (a: Accent) => setAccentState(a);
  const toggleTheme = () => setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));

  return (
    <ThemeContext.Provider value={{ theme, accent, setTheme, setAccent, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** The active theme, or 'dark' outside a ThemeProvider (isolated renders, tests). */
export function useThemeMode(): Theme {
  return useContext(ThemeContext)?.theme ?? 'dark';
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
