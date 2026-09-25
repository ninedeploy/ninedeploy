import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from './web-utils.js';

const authMock = vi.hoisted(() => ({ useAuth: vi.fn() }));
const themeMock = vi.hoisted(() => ({ useTheme: vi.fn() }));
const modeMock = vi.hoisted(() => ({
  useExperienceMode: vi.fn(() => ({
    mode: 'simple' as 'simple' | 'advanced',
    isAdvanced: false,
    isSimple: true,
    setMode: vi.fn(),
    toggleMode: vi.fn(),
  })),
}));
const workspaceMock = vi.hoisted(() => ({
  useWorkspace: vi.fn(() => ({
    workspaces: [],
    currentWorkspace: null,
    isLoading: false,
    switchWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
  })),
}));
const apiMock = vi.hoisted(() => ({
  getToken: vi.fn((): string | null => 'tok'),
  api: {
    services: { list: vi.fn() },
    databases: { list: vi.fn() },
    templates: { list: vi.fn() },
    projects: { list: vi.fn() },
    labels: { list: vi.fn(), create: vi.fn() },
    workspaces: { list: vi.fn() },
    plugins: { list: vi.fn() },
    menus: { list: vi.fn() },
    branding: { get: vi.fn() },
  },
}));

vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: authMock.useAuth }));
vi.mock('../src/lib/theme.js', () => ({ useTheme: themeMock.useTheme }));
vi.mock('../src/lib/mode.js', () => ({ useExperienceMode: modeMock.useExperienceMode }));
vi.mock('../src/lib/workspace.js', () => ({ useWorkspace: workspaceMock.useWorkspace }));
vi.mock('../src/lib/api.js', () => apiMock);

import { Layout } from '../src/components/Layout.js';
import { ProjectScopeProvider, TagScopeProvider } from '../src/lib/projects.js';

function renderLayout(path = '/databases') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ProjectScopeProvider>
      {/* Mirrors App.tsx: TopBarFilters reads and writes the chip scope. */}
      <TagScopeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="*" element={<div data-testid="outlet">page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
      </TagScopeProvider>
      </ProjectScopeProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.useAuth.mockReturnValue({
      user: { id: 1, email: 'ada@example.com', name: 'Ada', isOperator: true },
      logout: vi.fn(),
      loading: false,
    });
    themeMock.useTheme.mockReturnValue({
      theme: 'dark',
      accent: 'indigo',
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      toggleTheme: vi.fn(),
    });
    apiMock.getToken.mockReturnValue('tok');
    apiMock.api.services.list.mockResolvedValue([]);
    apiMock.api.databases.list.mockResolvedValue([]);
    apiMock.api.templates.list.mockResolvedValue([]);
    apiMock.api.projects.list.mockResolvedValue([]);
    apiMock.api.plugins.list.mockResolvedValue({ plugins: [] });
    apiMock.api.menus.list.mockResolvedValue({ items: [] });
    apiMock.api.branding.get.mockResolvedValue({ logoUrl: null, primaryColor: null, supportEmail: null, footerHtml: null });
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the activity bar, groups and the user avatar', () => {
    renderLayout();
    // brand mark is the SVG logo now (aria-hidden) — assert the rail renders it
    expect(document.querySelector('.flex.w-12 svg')).toBeInTheDocument();
    for (const g of ['Deploy', 'Data', 'Network', 'System']) {
      expect(screen.getAllByText(g).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('A')).toBeInTheDocument(); // avatar initial
    expect(screen.getByText('ada@example.com · Sign out')).toBeInTheDocument();
  });

  it('r360: applies the instance branding — logo and support contact', async () => {
    apiMock.api.branding.get.mockResolvedValue({
      logoUrl: 'https://cdn.example.com/acme.png',
      primaryColor: '#ff0000',
      supportEmail: 'help@acme.test',
      footerHtml: '<b>x</b>',
    });
    renderLayout();
    const logo = await screen.findByRole('img', { name: 'Logo' });
    expect(logo).toHaveAttribute('src', 'https://cdn.example.com/acme.png');
    expect(screen.getByRole('link', { name: 'Contact support (help@acme.test)' })).toHaveAttribute(
      'href',
      'mailto:help@acme.test',
    );
  });

  it('r360: refuses an unsafe logo URL and a malformed support address, keeping the defaults', async () => {
    apiMock.api.branding.get.mockResolvedValue({
      logoUrl: 'javascript:alert(1)',
      primaryColor: null,
      supportEmail: 'x@y.z?cc=evil@z.z',
      footerHtml: null,
    });
    renderLayout();
    await waitFor(() => expect(apiMock.api.branding.get).toHaveBeenCalled());
    expect(screen.queryByRole('img', { name: 'Logo' })).toBeNull();
    expect(document.querySelector('.flex.w-12 svg')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Contact support/ })).toBeNull();
  });

  it('r360: keeps the stock mark when branding cannot be read', async () => {
    apiMock.api.branding.get.mockRejectedValue(new Error('404'));
    renderLayout();
    await waitFor(() => expect(apiMock.api.branding.get).toHaveBeenCalled());
    expect(screen.queryByRole('img', { name: 'Logo' })).toBeNull();
    expect(document.querySelector('.flex.w-12 svg')).toBeInTheDocument();
  });

  it('shows the Doctor sidebar link to instance operators', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(screen.getByRole('link', { name: 'Doctor' })).toBeInTheDocument();
  });

  it('hides the Doctor sidebar link from non-operators', () => {
    authMock.useAuth.mockReturnValue({
      user: { id: 2, email: 'member@example.com', name: 'Mem', isOperator: false },
      logout: vi.fn(),
      loading: false,
    });
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(screen.queryByRole('link', { name: 'Doctor' })).not.toBeInTheDocument();
  });

  it('opens the group panel and marks the matching link active', () => {
    renderLayout('/databases');
    expect(screen.getAllByText('Data').length).toBeGreaterThan(0);
    const link = screen.getByRole('link', { name: /Databases/ });
    expect(link.className).toContain('bg-indigo-500/15');
    expect(screen.getByText('/')).toBeInTheDocument(); // breadcrumb separator
  });

  it('falls back to the second group ("Organize") with the panel open for unknown paths', () => {
    // Unknown paths must still show a useful secondary panel instead of an
    // empty rail. The second group is "Organize" (Workspaces / Projects /
    // Labels) — discoverable, never advancedOnly, and the right default
    // landing pad for a fresh load that has not picked a destination yet.
    renderLayout('/nowhere');
    // The activity-bar tooltip, the secondary-panel header, and the
    // breadcrumb all spell "Organize" — assert at least one match.
    expect(screen.getAllByText('Organize').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Workspaces/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Projects/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Labels/ })).toBeInTheDocument();
    expect(screen.getByText('Collapse')).toBeInTheDocument();
  });

  it('keeps the second group open after a navigation between two unknown paths', () => {
    // The auto-open effect runs on every pathname change. If neither path
    // matches a group, the second group must stay open across navigations
    // (and not flicker to null) — otherwise the rail briefly closes and
    // the breadcrumb area collapses.
    renderLayout('/nowhere');
    expect(screen.getAllByText('Organize').length).toBeGreaterThan(0);
    // The auto-open effect runs on every pathname change, but with no
    // route group matching, it must keep the second group as the
    // fallback rather than re-render to null.
    expect(screen.getByText('Collapse')).toBeInTheDocument();
  });

  it('still opens the matching group when the path lands on a known route', () => {
    // Regression guard: the default-to-second-group behavior must NOT
    // override a path that already maps to a different group.
    renderLayout('/databases');
    expect(screen.getAllByText('Data').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Databases/ })).toBeInTheDocument();
  });

  it('prefers the longer (more specific) prefix when two groups could match', async () => {
    // Plugin-contributed menu items register routes like
    // /settings/extensions/<plugin-id>. The static System group also
    // owns /settings, so a naive "first match wins" lookup would
    // route the click into System and the user would land in the
    // wrong panel. findGroup() must pick the longer prefix so the
    // extensions panel stays open and the plugin's own link is the
    // one marked active.
    apiMock.api.menus.list.mockResolvedValue({
      items: [
        {
          id: 'plugin-foo',
          pluginId: 'plugin-foo',
          slot: 'sidebar:secondary',
          label: 'Plugin Foo',
          route: '/settings/extensions/plugin-foo',
          icon: 'globe',
        },
      ],
    } as never);
    renderLayout('/settings/extensions/plugin-foo');
    // The plugin's link is rendered and active (bg-indigo-500/15).
    // Wait for it: the menus query has to settle before the
    // extensions group is appended to the sidebar.
    const pluginLink = await screen.findByRole('link', { name: /Plugin Foo/ });
    expect(pluginLink.className).toContain('bg-indigo-500/15');
    // The "Extensions" group header is now visible (it appears in
    // the activity-bar tooltip, the panel header, and the
    // breadcrumb — at least one match is enough).
    expect(screen.getAllByText('Extensions').length).toBeGreaterThan(0);
    // The built-in Settings link is NOT in the panel — the user is in
    // the Extensions group now, not the System group.
    expect(screen.queryByRole('link', { name: /^Settings$/ })).not.toBeInTheDocument();
  });

  it('does not leak command:palette items into the Extensions sidebar group', async () => {
    // A plugin that ships only `command:palette` entries (the dominant
    // shape for built-in plugins like Build Cache, Webhook Out, …)
    // must NOT show those entries in the secondary sidebar. They
    // belong in the Cmd+K palette only; putting them in the rail
    // duplicates the entry point and clutters the activity bar.
    apiMock.api.menus.list.mockResolvedValue({
      items: [
        {
          id: 'build-cache-command',
          pluginId: 'build-cache',
          slot: 'command:palette',
          label: 'Build Cache',
          route: '/settings?section=plugins',
          icon: 'layers',
        },
        {
          id: 'webhook-out-command',
          pluginId: 'webhook-out',
          slot: 'command:palette',
          label: 'Outbound Webhook',
          route: '/settings?section=plugins',
          icon: 'webhook',
        },
      ],
    } as never);
    renderLayout('/');
    // Wait for the menus query to settle so the sidebar has had a
    // chance to mount any extensions.
    await waitFor(() => {
      expect(apiMock.api.menus.list).toHaveBeenCalled();
    });
    // No `Extensions` group header is rendered — both items are
    // command:palette only, so the filter drops them all.
    expect(screen.queryByText('Extensions')).not.toBeInTheDocument();
    // The palette entries do not appear in the rail either.
    expect(screen.queryByRole('link', { name: /Build Cache/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Outbound Webhook/ })).not.toBeInTheDocument();
  });

  it('marks the Services link active on /services', () => {
    renderLayout('/services');
    const link = screen.getByRole('link', { name: /Services/ });
    expect(link.className).toContain('bg-indigo-500/15');
  });

  it('does not mark Services active when another Deploy item is active', () => {
    renderLayout('/dashboard');
    const services = screen.getByRole('link', { name: /Services/ });
    expect(services.className).not.toContain('bg-indigo-500/15');
    const dashboard = screen.getByRole('link', { name: /Dashboard/ });
    expect(dashboard.className).toContain('bg-indigo-500/15');
  });

  it('toggles groups from the activity bar', async () => {
    const user = userEvent.setup();
    renderLayout('/databases');
    expect(screen.getByText('Collapse')).toBeInTheDocument();
    // close the "data" group via its icon button
    const buttons = screen.getAllByRole('button');
    const dataBtn = buttons.find((b) => b.textContent === 'Data') as HTMLButtonElement;
    await user.click(dataBtn);
    expect(screen.queryByText('Collapse')).not.toBeInTheDocument();
    await user.click(dataBtn);
    expect(screen.getByText('Collapse')).toBeInTheDocument();
  });

  it('collapses the panel via the collapse button', async () => {
    const user = userEvent.setup();
    renderLayout('/databases');
    await user.click(screen.getByText('Collapse'));
    expect(screen.queryByText('Collapse')).not.toBeInTheDocument();
    expect(screen.getByText('NineDeploy')).toBeInTheDocument();
  });

  it('updates the active group on navigation', async () => {
    const user = userEvent.setup();
    renderLayout('/databases');
    expect(screen.getAllByText('Data').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('link', { name: /Volumes/ }));
    expect(screen.getAllByText('Data').length).toBeGreaterThan(0);
    // Switch to the Deploy group via the activity bar, then click Hub.
    const deployBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent === 'Deploy') as HTMLButtonElement;
    await user.click(deployBtn);
    await user.click(screen.getByRole('link', { name: /Hub/ }));
    expect(screen.getAllByText('Deploy').length).toBeGreaterThan(0);
  });

  it('toggles the theme from the header', async () => {
    const toggleTheme = vi.fn();
    themeMock.useTheme.mockReturnValue({
      theme: 'dark',
      accent: 'indigo',
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      toggleTheme,
    });
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Light mode'));
    expect(toggleTheme).toHaveBeenCalled();
  });

  it('shows the moon icon when the theme is light', () => {
    themeMock.useTheme.mockReturnValue({
      theme: 'light',
      accent: 'indigo',
      setTheme: vi.fn(),
      setAccent: vi.fn(),
      toggleTheme: vi.fn(),
    });
    renderLayout();
    expect(screen.getByTitle('Dark mode')).toBeInTheDocument();
  });

  it('opens the command palette with the search button and closes it', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Search (⌘K)'));
    expect(screen.getByPlaceholderText(/Search services/)).toBeInTheDocument();
    await user.click(screen.getByText('Hub'));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/Search services/)).not.toBeInTheDocument(),
    );
  });

  it('toggles the command palette with Cmd+K / Ctrl+K', async () => {
    renderLayout();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByPlaceholderText(/Search services/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.queryByPlaceholderText(/Search services/)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'x', metaKey: true });
    expect(screen.queryByPlaceholderText(/Search services/)).not.toBeInTheDocument();
  });

  it('renders the activity drawer with live events from the socket', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Activity'));
    expect(screen.getByText('Events')).toBeInTheDocument();
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://localhost/v1/events');
    expect(ws?.protocols).toEqual(['ninedeploy.bearer.tok']);

    const now = Date.now();
    const payload = [
      JSON.stringify({ id: 1, action: 'deploy.start', entity: 'api', ts: new Date(now - 1000).toISOString() }),
      JSON.stringify({ id: 2, action: 'database.delete', entity: 'pg', ts: new Date(now - 5 * 60000).toISOString() }),
      JSON.stringify({ id: 3, action: 'weird.thing', entity: null, ts: new Date(now - 2 * 3600000).toISOString() }),
    ].join('\n');
    actSocket(ws, payload);

    expect(screen.getByText('deploy start')).toBeInTheDocument();
    expect(screen.getByText('just now')).toBeInTheDocument();
    expect(screen.getByText('database delete')).toBeInTheDocument();
    expect(screen.getByText('5m ago')).toBeInTheDocument();
    expect(screen.getByText('weird thing')).toBeInTheDocument();
  });

  it('connects the events socket with an empty token when none is stored', async () => {
    apiMock.getToken.mockReturnValue(null);
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Activity'));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://localhost/v1/events');
  });

  it('uses wss when the page is served over https', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: new URL('https://example.com/databases'),
      configurable: true,
    });
    try {
      const user = userEvent.setup();
      renderLayout();
      await user.click(screen.getByTitle('Activity'));
      expect(FakeWebSocket.instances[0]?.url).toBe('wss://example.com/v1/events');
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });

  it('omits the token when none is stored', async () => {
    apiMock.getToken.mockReturnValueOnce(null);
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Activity'));
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://localhost/v1/events');
  });

  it('ignores malformed socket payloads', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Activity'));
    const ws = FakeWebSocket.instances[0];
    actSocket(ws, 'not-json\nalso-not-json');
    expect(screen.getByText('No events yet.')).toBeInTheDocument();
  });

  it('filters drawer events by action prefix', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Activity'));
    const ws = FakeWebSocket.instances[0];
    const now = new Date().toISOString();
    actSocket(ws, [JSON.stringify({ id: 1, action: 'deploy.start', entity: null, ts: now }), JSON.stringify({ id: 2, action: 'database.create', entity: null, ts: now })].join('\n'));

    await user.click(screen.getByRole('button', { name: 'deploy' }));
    expect(screen.getByText('deploy start')).toBeInTheDocument();
    expect(screen.queryByText('database create')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByText('database create')).toBeInTheDocument();
  });

  it('r209: a reconnect backlog replay does not duplicate drawer events', async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Activity'));
    const ws = FakeWebSocket.instances[0];
    const now = new Date().toISOString();
    const backlog = [JSON.stringify({ id: 1, action: 'deploy.start', entity: null, ts: now }), JSON.stringify({ id: 2, action: 'database.create', entity: null, ts: now })].join('\n');
    actSocket(ws, backlog);
    actSocket(ws, backlog); // the replay a reconnect delivers
    expect(screen.getAllByText('deploy start')).toHaveLength(1);
    expect(screen.getAllByText('database create')).toHaveLength(1);
  });

  it('closes the drawer via the X button and the backdrop', async () => {
    const user = userEvent.setup();
    const { container } = renderLayout();
    await user.click(screen.getByTitle('Activity'));
    expect(screen.getByText('Events')).toBeInTheDocument();
    // The drawer's header close button has a distinctive class signature
    // ("rounded-lg p-1 text-slate-500 ...") unique to it.
    const drawerClose = container.querySelector(
      'button.rounded-lg.p-1.text-slate-500',
    ) as HTMLButtonElement;
    expect(drawerClose).not.toBeNull();
    await user.click(drawerClose);
    expect(screen.queryByText('Events')).not.toBeInTheDocument();

    // Backdrop close: the backdrop sits inside the drawer's `.fixed`
    // wrapper as the first child (`absolute inset-0 bg-black/40`).
    await user.click(screen.getByTitle('Activity'));
    expect(screen.getByText('View Full Audit Ledger')).toBeInTheDocument();
    const backdrop = container.querySelector('div.fixed > button.absolute') as HTMLElement;
    await user.click(backdrop);
    expect(screen.queryByText('Events')).not.toBeInTheDocument();

    // Clicking View Full Audit Ledger navigates and closes drawer
    await user.click(screen.getByTitle('Activity'));
    const ledgerLink = screen.getByRole('link', { name: /View Full Audit Ledger/i });
    await user.click(ledgerLink);
    expect(screen.queryByText('Events')).not.toBeInTheDocument();
  });

  it('logs out from the avatar button', async () => {
    const logout = vi.fn();
    authMock.useAuth.mockReturnValue({ user: { id: 1, email: 'a@b.c', name: null, isOperator: true }, logout, loading: false });
    const user = userEvent.setup();
    renderLayout();
    await user.click(screen.getByTitle('Sign out'));
    expect(logout).toHaveBeenCalled();
  });

  it('shows a question mark avatar when there is no user', () => {
    authMock.useAuth.mockReturnValue({ user: null, logout: vi.fn(), loading: false });
    renderLayout();
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('renders the outlet content', () => {
    renderLayout();
    expect(screen.getByTestId('outlet')).toHaveTextContent('page');
  });

  it('scopes on a filter chip and persists the selection', async () => {
    // The single-select "Project scope" <select> was replaced by the chip-based
    // TopBarFilters (workspace / project / label, multi-select). The selection
    // is persisted under `ninedeploy.tagScope`, not the legacy `projectId` key.
    localStorage.removeItem('ninedeploy.tagScope');
    const switchWorkspace = vi.fn();
    workspaceMock.useWorkspace.mockReturnValue({
      workspaces: [{ id: 7, name: 'Acme', slug: 'acme', role: 'owner' }],
      currentWorkspace: null,
      isLoading: false,
      switchWorkspace,
      createWorkspace: vi.fn(),
      refreshWorkspaces: vi.fn(),
    } as never);
    renderLayout();

    // Closed state: the chip reports no active workspace filter.
    const chip = await screen.findByRole('button', { name: /Workspace\s*All/ });
    await act(async () => { fireEvent.click(chip); });

    // Picking a workspace switches the active one and adds it to the scope.
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Acme/ })); });
    expect(switchWorkspace).toHaveBeenCalledWith(7);
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('ninedeploy.tagScope') ?? '{}').workspaceIds).toEqual([7]);
    });

    // Clearing the group removes the persisted scope entirely.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear' })); });
    await waitFor(() => expect(localStorage.getItem('ninedeploy.tagScope')).toBeNull());
    localStorage.removeItem('ninedeploy.tagScope');
  });

  it('colors delete and create actions with their dedicated tones', async () => {
    const user = userEvent.setup();
    const { container } = renderLayout();
    await user.click(screen.getByTitle('Activity'));
    const ws = FakeWebSocket.instances[0];
    const now = new Date().toISOString();
    actSocket(
      ws,
      [
        JSON.stringify({ id: 1, action: 'service.delete', entity: null, ts: now }),
        JSON.stringify({ id: 2, action: 'service.create', entity: null, ts: now }),
        JSON.stringify({ id: 3, action: 'unicorn.prance', entity: null, ts: now }),
      ].join('\n'),
    );
    // Each row renders its action label with the matching tone class:
    // rose for delete, emerald for create, slate as the fallback.
    await waitFor(() => {
      expect(container.querySelector('.text-rose-300')).not.toBeNull();
      expect(container.querySelector('.text-emerald-300')).not.toBeNull();
      expect(container.querySelector('.text-slate-300')).not.toBeNull();
    });
  });

  it('renders dynamic extension items registered by plugins with custom and fallback icons', async () => {
    apiMock.api.menus.list.mockResolvedValue({
      items: [
        {
          id: 'datadog-dash',
          label: 'Datadog APM',
          route: '/datadog',
          icon: 'activity',
          slot: 'sidebar:secondary',
        },
        {
          id: 'custom-tool',
          label: 'Custom Tool',
          route: '/custom',
          icon: 'unknown_icon',
          slot: 'sidebar:secondary',
        },
      ],
    });

    renderLayout('/databases');
    await waitFor(() => {
      expect(screen.getAllByText('Extensions').length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Extensions' }));
    expect(await screen.findByText('Datadog APM')).toBeInTheDocument();
    expect(screen.getByText('Custom Tool')).toBeInTheDocument();
  });

  it('gracefully falls back when menus query rejects', async () => {
    apiMock.api.menus.list.mockRejectedValue(new Error('menus unavailable'));
    renderLayout('/databases');
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Databases/ })).toBeInTheDocument();
    });
  });

  it('shows advanced-only navigation items only in advanced mode', async () => {
    // Simple mode (default): the System group hides advanced-only entries.
    const simple = renderLayout('/databases');
    await waitFor(() => expect(screen.getByRole('link', { name: /Databases/ })).toBeInTheDocument());
    // Let the menus query settle BEFORE clicking: its resolution re-runs the
    // auto-open effect, which would otherwise reset the clicked group.
    await waitFor(() => expect(simple.queryClient.getQueryState(['menus'])?.status).toBe('success'));
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    await waitFor(() => expect(screen.getByRole('link', { name: /Settings/ })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Docker/ })).not.toBeInTheDocument();

    // Advanced mode keeps every navigation entry. (mockReturnValue, not Once:
    // the menus query triggers re-renders that would otherwise fall back to
    // the simple default mid-test.)
    modeMock.useExperienceMode.mockReturnValue({
      mode: 'advanced',
      isAdvanced: true,
      isSimple: false,
      setMode: vi.fn(),
      toggleMode: vi.fn(),
    });
    cleanup();
    const advanced = renderLayout('/databases');
    await waitFor(() => expect(advanced.queryClient.getQueryState(['menus'])?.status).toBe('success'));
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    await waitFor(() => expect(screen.getByRole('link', { name: /Docker/ })).toBeInTheDocument());
    modeMock.useExperienceMode.mockReturnValue({
      mode: 'simple',
      isAdvanced: false,
      isSimple: true,
      setMode: vi.fn(),
      toggleMode: vi.fn(),
    });
  });

  it('activity drawer reconnects after a drop and never lies about live state', async () => {
    const user = userEvent.setup();
    renderLayout();

    // Open the drawer: the socket connects and the drawer reports live.
    await user.click(screen.getByTitle('Activity'));
    const first = FakeWebSocket.instances.at(-1)!;
    first.open();
    expect(await screen.findByText(/● live/)).toBeInTheDocument();

    // A drop schedules a reconnect (2s backoff on the first retry) and the
    // badge says reconnecting instead of claiming a dead feed is live.
    first.closeFromServer();
    expect(await screen.findByText(/● reconnecting/)).toBeInTheDocument();

    // The backoff fires: a NEW socket is created; when it opens, live returns.
    await vi.waitFor(
      () => {
        expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
      },
      { timeout: 4000 },
    );
    FakeWebSocket.instances.at(-1)!.open();
    expect(await screen.findByText(/● live/)).toBeInTheDocument();
  });
});

/** Simulate the socket receiving a payload and flush React updates. */
function actSocket(ws: FakeWebSocket | undefined, data: string): void {
  act(() => ws?.message(data));
}
