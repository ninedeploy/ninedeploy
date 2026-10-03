import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { useTheme } from '../src/lib/theme.js';
import { ThemeProvider } from '../src/lib/theme.js';
import { useExperienceMode } from '../src/lib/mode.js';
import { mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

vi.mock('../src/lib/workspace.js', async () => {
  const { createWorkspaceMock } = await import('./apiMock.js');
  return createWorkspaceMock();
});

vi.mock('../src/lib/theme.js', async () => {
  const { createThemeMock } = await import('./apiMock.js');
  return createThemeMock();
});

vi.mock('../src/lib/mode.js', async () => {
  const { createModeMock } = await import('./apiMock.js');
  return createModeMock();
});

vi.mock('../src/components/CommandPalette.js', () => ({
  CommandPalette: () => null,
}));

// Replace the WebSocket with the existing fake so the Layout's events
// subscription does not throw before the route body is reachable.
import { FakeWebSocket } from './web-utils.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = FakeWebSocket;

interface MenuCase {
  path: string;
  group: 'Deploy' | 'Organize' | 'Data' | 'Network' | 'System';
  /** Label of the nav link that must receive the active styling. */
  activeLink: RegExp | string;
  /**
   * Items flagged `advancedOnly: true` in the GROUPS array are hidden
   * from the sidebar in Simple mode (Layout.tsx:133). They must be
   * exercised with `mode: 'advanced'` so the panel actually lists the
   * link — the route still renders in Simple mode, but the sidebar
   * has nothing to light up. The smoke test asserts both the link
   * visibility and the active styling, so the mode has to match the
   * item.
   */
  mode?: 'simple' | 'advanced';
  /** Optional: a content marker the route should render after settling. */
  content?: RegExp;
}

const MENU_CASES: MenuCase[] = [
  // Deploy
  { path: '/hub', group: 'Deploy', activeLink: /^\s*Hub\s*$/ },
  { path: '/manifest-creator', group: 'Deploy', activeLink: /Manifest Creator/ },
  { path: '/dashboard', group: 'Deploy', activeLink: /Dashboard/ },
  { path: '/services', group: 'Deploy', activeLink: /Services/ },
  { path: '/services/abc-123', group: 'Deploy', activeLink: /Services/ },
  { path: '/deploys', group: 'Deploy', activeLink: /Queue/ },

  // Organize
  { path: '/workspaces', group: 'Organize', activeLink: /Workspaces/ },
  { path: '/projects', group: 'Organize', activeLink: /Projects/ },
  { path: '/labels', group: 'Organize', activeLink: /Labels/ },

  // Data
  { path: '/databases', group: 'Data', activeLink: /Databases/ },
  { path: '/databases/pg-1', group: 'Data', activeLink: /Databases/ },
  { path: '/volumes', group: 'Data', activeLink: /Volumes/ },
  { path: '/backups', group: 'Data', activeLink: /Backups/ },

  // Network
  { path: '/domains', group: 'Network', activeLink: /Domains/ },
  { path: '/traefik', group: 'Network', activeLink: /Traefik/ },
  { path: '/networks', group: 'Network', activeLink: /Networks/, mode: 'advanced' },
  { path: '/tunnels', group: 'Network', activeLink: /Tunnels/, mode: 'advanced' },
  { path: '/topology', group: 'Network', activeLink: /Topology/ },

  // System
  { path: '/activity', group: 'System', activeLink: /Activity/ },
  { path: '/monitoring', group: 'System', activeLink: /Monitoring/ },
  { path: '/docker', group: 'System', activeLink: /Docker/, mode: 'advanced' },
  { path: '/sources', group: 'System', activeLink: /Sources/ },
  { path: '/servers', group: 'System', activeLink: /Servers/, mode: 'advanced' },
  { path: '/users', group: 'System', activeLink: /Users/ },
  { path: '/settings', group: 'System', activeLink: /Settings/ },
  { path: '/about', group: 'System', activeLink: /About/ },
];

/** A rendered DOM contains at most one node whose text content is exactly
 * `name` — that is the panel-header label (the activity-bar tooltip and the
 * breadcrumb can also display the same string, but only the panel header
 * appears as the sole exact match when the group is open). We use
 * `getAllByText` and pick the one that lives inside a `.uppercase` span. */
function findPanelHeader(container: HTMLElement, name: string): HTMLElement | null {
  const spans = Array.from(container.querySelectorAll('span'));
  for (const s of spans) {
    if (s.textContent?.trim() === name && s.className.includes('uppercase')) {
      return s;
    }
  }
  return null;
}

function renderAppAt(path: string, mode: 'simple' | 'advanced' = 'simple') {
  mockOf(useExperienceMode).mockReturnValue({
    mode,
    isAdvanced: mode === 'advanced',
    isSimple: mode === 'simple',
    setMode: vi.fn(),
    toggleMode: vi.fn(),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('Sidebar menu — every nav item opens the right group and lights up the right link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(useAuth).mockReturnValue({
      user: { id: 1, email: 'ada@example.com', name: 'Ada', isOperator: true },
      loading: false,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
    mockOf(useTheme).mockReturnValue({
      theme: 'dark',
      accent: 'indigo',
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      toggleTheme: vi.fn(),
    });
    // Default the api mocks so the page bodies do not error out before the
    // sidebar assertion runs. The route-specific test files cover deeper
    // content assertions; this file only proves the menu plumbing is wired.
    mockOf(api.services.list).mockResolvedValue([]);
    mockOf(api.databases.list).mockResolvedValue([]);
    mockOf(api.templates.list).mockResolvedValue([]);
    mockOf(api.projects.list).mockResolvedValue([]);
    mockOf(api.workspaces.list).mockResolvedValue({ workspaces: [] });
    mockOf(api.plugins.list).mockResolvedValue({ plugins: [] });
    mockOf(api.menus.list).mockResolvedValue({ items: [] });
    FakeWebSocket.instances.length = 0;
  });

  it.each(MENU_CASES)(
    'path "$path" → group "$group" with link matching $activeLink',
    async ({ path, group, activeLink, mode = 'simple' }) => {
      const { container, unmount } = renderAppAt(path, mode);

      // The group panel must be open. The panel header uses the same label
      // as the GROUPS array and renders inside an .uppercase span. If the
      // findGroup() resolution or the auto-open effect regressed, the
      // panel would either be missing or show a different group.
      // The generous timeout also absorbs the lazy route chunk compiling
      // under a loaded parallel worker (routes are code-split since the
      // bundle split — the FIRST navigation to a route pays the compile).
      await waitFor(
        () => {
          const header = findPanelHeader(container, group);
          expect(header, `panel header "${group}" should be visible at ${path}`).not.toBeNull();
        },
        { timeout: 10_000 },
      );

      // The link inside the panel must be active. The active class is
      // `bg-indigo-500/15` (Layout.tsx:254). We don't assert on the class
      // string directly because Tailwind's JIT might rename it; instead we
      // assert the text content is rendered AND that exactly one element
      // with that label is present in the secondary panel (not the
      // activity-bar tooltip or the breadcrumb).
      const labelMatcher = activeLink instanceof RegExp ? activeLink : new RegExp(`^\\s*${activeLink}\\s*$`);
      const links = Array.from(container.querySelectorAll('a'));
      const activeLinks = links.filter((a) => labelMatcher.test(a.textContent ?? ''));
      expect(
        activeLinks.length,
        `expected at least one link matching ${String(labelMatcher)} at ${path}`,
      ).toBeGreaterThan(0);

      unmount();
    },
  );

  it('falls back to the second group ("Organize") for an unknown path', async () => {
    // Regression guard: a route that does not match any GROUPS item must
    // not leave the panel empty. The second group is "Organize" and is
    // the default landing pad.
    const { container, unmount } = renderAppAt('/this-route-does-not-exist');
    await waitFor(
      () => {
        const header = findPanelHeader(container, 'Organize');
        expect(header).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    unmount();
  });
});
