import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import App from '../src/App.js';
import { api } from '../src/lib/api.js';
import { useAuth } from '../src/lib/auth.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});

// Layout is covered by the components worker — render a thin shell here.
vi.mock('../src/components/Layout.js', async () => {
  const { Outlet } = await import('react-router');
  const Layout = () => (
    <div data-testid="layout">
      <Outlet />
    </div>
  );
  return { Layout };
});

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function authState(user: unknown, loading = false) {
  mockOf(useAuth).mockReturnValue({
    user,
    loading,
    login: vi.fn(),
    setup: vi.fn(),
    logout: vi.fn(),
  } as never);
}

const emptyDash = {
  stats: { services: 0, databases: 0, deployments: 0, domains: 0, webhooks: 0, running: 0, stopped: 0, errored: 0, dbRunning: 0, containers: 0 },
  health: [],
  recentDeploys: [],
};

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a full-screen spinner while auth is loading', () => {
    authState(null, true);
    renderWithProviders(<App />, { route: '/' });
    expect(document.querySelector('.animate-spin')).not.toBeNull();
  });

  it('redirects unauthenticated users to /login with the from path', async () => {
    authState(null);
    renderWithProviders(
      <>
        <App />
        <LocationProbe />
      </>,
      { route: '/databases' },
    );
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
  });

  it('renders the 404 page for unknown paths', async () => {
    authState({ id: 1, email: 'a@b.c' });
    renderWithProviders(<App />, { route: '/does-not-exist' });
    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/');
  });

  it('redirects /dashboard to /', async () => {
    authState({ id: 1, email: 'a@b.c' });
    mockOf(api.dashboard.get).mockResolvedValue(emptyDash as never);
    renderWithProviders(
      <>
        <App />
        <LocationProbe />
      </>,
      { route: '/dashboard' },
    );
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/));
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  });

  it('renders the authenticated shell and the index route', async () => {
    authState({ id: 1, email: 'a@b.c' });
    mockOf(api.dashboard.get).mockResolvedValue(emptyDash as never);
    renderWithProviders(<App />, { route: '/' });
    await screen.findByTestId('layout');
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  });

  it('renders a nested route inside the authenticated shell', async () => {
    authState({ id: 1, email: 'a@b.c' });
    mockOf(api.templates.list).mockResolvedValue([] as never);
    renderWithProviders(<App />, { route: '/hub' });
    await screen.findByTestId('layout');
    expect(await screen.findByText('Hub')).toBeInTheDocument();
  });

  it('renders the activity route inside the authenticated shell', async () => {
    authState({ id: 1, email: 'a@b.c' });
    mockOf(api.activity.list).mockResolvedValue({ entries: [] } as never);
    renderWithProviders(<App />, { route: '/activity' });
    await screen.findByTestId('layout');
    expect(await screen.findByText('Activity & Audit Logs')).toBeInTheDocument();
  });

  it('renders the database detail route inside the authenticated shell', async () => {
    authState({ id: 1, email: 'a@b.c' });
    mockOf(api.databases.get).mockResolvedValue({
      id: 1,
      name: 'pg-app',
      slug: 'pg-app',
      engine: 'postgres',
      version: '16',
      status: 'running',
      host: 'nd-db-pg-app',
      port: 5432,
      username: 'nine',
      database: 'app',
      connectionString: 'postgres://conn',
      attachedServices: [],
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
    } as any);
    mockOf(api.databases.credentials).mockResolvedValue({
      engine: 'postgres',
      username: 'nine',
      password: 'p',
      database: 'app',
      internalHost: 'nd-db-pg-app',
      internalPort: 5432,
      connectionString: 'postgres://conn',
    } as any);
    mockOf(api.backups.list).mockResolvedValue([]);
    renderWithProviders(<App />, { route: '/databases/1' });
    await screen.findByTestId('layout');
    expect(await screen.findByText('pg-app')).toBeInTheDocument();
  });

  it('r358: mounts the domain-transfer accept link the server prints', async () => {
    authState({ id: 2, email: 'bob@example.com' });
    mockOf(api.domains.previewTransfer).mockResolvedValue({
      id: 7,
      status: 'pending',
      hostname: 'shop.example.com',
      sourceEmail: 'alice@example.com',
      targetEmail: 'bob@example.com',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      createdAt: 0,
      acceptedAt: null,
      cancelledAt: null,
      effectivelyExpired: false,
    } as never);
    renderWithProviders(<App />, { route: '/domains/transfers/tok123/accept' });
    await screen.findByTestId('layout');
    expect(await screen.findByText('Domain transfer: shop.example.com')).toBeInTheDocument();
    expect(screen.queryByText('Not found')).toBeNull();
  });

  it('r358: sends a logged-out recipient to /login, remembering the accept link', async () => {
    authState(null);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    function StateProbe() {
      const loc = useLocation();
      return <div data-testid="from">{(loc.state as { from?: string } | null)?.from ?? ''}</div>;
    }
    renderWithProviders(
      <>
        <App />
        <LocationProbe />
        <StateProbe />
      </>,
      { route: '/domains/transfers/tok123/accept' },
    );
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'));
    expect(screen.getByTestId('from')).toHaveTextContent('/domains/transfers/tok123/accept');
  });

  it('renders the login route for unauthenticated users', async () => {
    authState(null);
    mockOf(api.auth.status).mockResolvedValue({ initialized: true } as never);
    renderWithProviders(<App />, { route: '/login' });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });
});
