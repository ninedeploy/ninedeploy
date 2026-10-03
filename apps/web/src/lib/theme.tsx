import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';

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
  { id: 'phosphor', label: 'Phosphor', color: '#4ecdc4' },
  { id: 'indigo', label: 'Indigo', color: '#6366f1' },
  { id: 'blue', label: 'Blue', color: '#3b82f6' },
  { id: 'emerald', label: 'Emerald', color: '#10b981' },
  { id: 'rose', label: 'Rose', color: '#f43f5e' },
  { id: 'amber', label: 'Amber', color: '#f59e0b' },
  { id: 'violet', label: 'Violet', color: '#8b5cf6' },
];

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try { return (localStorage.getItem(THEME_KEY) as Theme) ?? 'dark'; } catch { return 'dark'; }
  });
  const [accent, setAccentState] = useState<Accent>(() => {
    try { return (localStorage.getItem(ACCENT_KEY) as Accent) ?? 'phosphor'; } catch { return 'phosphor'; }
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

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
