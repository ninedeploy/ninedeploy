import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './web-utils.js';
import { ACCENTS, ThemeProvider, useTheme } from '../src/lib/theme.js';

const THEME_KEY = 'ninedeploy.theme';
const ACCENT_KEY = 'ninedeploy.accent.v2';

function Probe() {
  const { theme, accent, setTheme, setAccent, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="accent">{accent}</span>
      <button type="button" onClick={toggleTheme}>toggle</button>
      <button type="button" onClick={() => setTheme('light')}>set-light</button>
      <button type="button" onClick={() => setTheme('dark')}>set-dark</button>
      <button type="button" onClick={() => setAccent('rose')}>set-rose</button>
    </div>
  );
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-accent');
    vi.restoreAllMocks();
  });

  it('defaults to dark theme and phosphor accent and applies them to <html>', () => {
    renderTheme();
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('accent')).toHaveTextContent('phosphor');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-accent')).toBe('phosphor');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(localStorage.getItem(ACCENT_KEY)).toBe('phosphor');
  });

  it('falls back to defaults and ignores write failures when localStorage throws', () => {
    // Privacy mode / denied storage: every access throws. The provider must
    // still boot with defaults and swallow write failures (deterministic
    // object replacement — Storage.prototype spies do not intercept on every
    // platform).
    const real = window.localStorage;
    const denied = {
      length: 0,
      clear: () => {},
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new Error('denied');
      },
      getItem: () => {
        throw new Error('denied');
      },
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => denied,
    });
    try {
      renderTheme();
      expect(screen.getByTestId('theme')).toHaveTextContent('dark');
      expect(screen.getByTestId('accent')).toHaveTextContent('phosphor');
      // Toggling still works in-memory; the persist write fails silently.
      act(() => screen.getByText('toggle').click());
      expect(screen.getByTestId('theme')).toHaveTextContent('light');
    } finally {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => real,
      });
    }
  });

  it('reads persisted theme and accent from localStorage', () => {
    localStorage.setItem(THEME_KEY, 'light');
    localStorage.setItem(ACCENT_KEY, 'amber');
    renderTheme();
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(screen.getByTestId('accent')).toHaveTextContent('amber');
  });

  it('falls back to dark/phosphor when localStorage reads throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderTheme();
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('accent')).toHaveTextContent('phosphor');
  });

  it('toggles between dark and light', async () => {
    const user = userEvent.setup();
    renderTheme();
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    await user.click(screen.getByText('toggle'));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    await user.click(screen.getByText('toggle'));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('sets the theme explicitly', async () => {
    const user = userEvent.setup();
    renderTheme();
    await user.click(screen.getByText('set-light'));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    await user.click(screen.getByText('set-dark'));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
  });

  it('sets the accent explicitly', async () => {
    const user = userEvent.setup();
    renderTheme();
    await user.click(screen.getByText('set-rose'));
    expect(screen.getByTestId('accent')).toHaveTextContent('rose');
    expect(document.documentElement.getAttribute('data-accent')).toBe('rose');
    expect(localStorage.getItem(ACCENT_KEY)).toBe('rose');
  });

  it('ignores localStorage write failures', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const user = userEvent.setup();
    renderTheme();
    await user.click(screen.getByText('toggle'));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('exposes the accent palette', () => {
    expect(ACCENTS).toHaveLength(7);
    // brand teal leads the list — same color as the marketing website
    expect(ACCENTS[0]).toEqual({ id: 'phosphor', label: 'Phosphor', color: '#4ecdc4' });
    expect(ACCENTS[1]).toEqual({ id: 'indigo', label: 'Indigo', color: '#6366f1' });
  });
});

describe('useTheme', () => {
  it('throws when used outside a ThemeProvider', () => {
    const original = console.error;
    console.error = vi.fn();
    try {
      expect(() => act(() => render(<Probe />))).toThrow(
        'useTheme must be used within ThemeProvider',
      );
    } finally {
      console.error = original;
    }
  });
});

describe('accent tokens (index.css)', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/index.css'), 'utf8');

  it('defines the full token set for the default (phosphor) accent', () => {
    for (const token of [
      '--nd-accent',
      '--nd-accent-strong',
      '--nd-accent-bright',
      '--nd-accent-soft',
      '--nd-accent-ring',
      '--nd-accent-soft-bg',
      '--nd-accent-soft-text',
      '--nd-accent-soft-ring',
    ]) {
      expect(css).toMatch(new RegExp(`^  ${token}:`, 'm'));
    }
  });

  it('defines tokens for every selectable accent', () => {
    for (const a of ACCENTS) {
      if (a.id === 'phosphor') continue; // :root default
      const block = css.match(new RegExp(`\\[data-accent='${a.id}'\\] \\{[^}]*\\}`));
      expect(block, `missing [data-accent='${a.id}'] block`).toBeTruthy();
      expect(block![0]).toContain('--nd-accent:');
      expect(block![0]).toContain('--nd-accent-soft-bg:');
    }
  });

  it('re-tones every accent for the light theme (data-theme + data-accent)', () => {
    for (const a of ACCENTS) {
      const block = css.match(
        new RegExp(`html\\[data-theme='light'\\]\\[data-accent='${a.id}'\\]\\s*\\{[^}]*\\}`),
      );
      expect(block, `missing light-theme override for ${a.id}`).toBeTruthy();
      expect(block![0]).toContain('--nd-accent-soft:');
      expect(block![0]).toContain('--nd-accent-bright:');
    }
  });

  it('routes indigo utilities and page backgrounds through the tokens', () => {
    expect(css).toContain('--color-indigo-500: var(--nd-accent)');
    expect(css).toContain('color-mix(in srgb, var(--nd-accent)');
  });
});
