import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Traefik } from '../src/routes/Traefik.js';
import { renderWithProviders } from './helpers.js';

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const userState = { user: { id: 1, email: 'admin@nine.local', isOperator: true } };
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => userState,
}));

const authedFetchMock = vi.fn();
vi.mock('../src/lib/api.js', () => ({
  authedFetch: (...args: unknown[]) => authedFetchMock(...args),
}));

const mockInfo = {
  status: {
    running: true,
    version: '3.0.0',
    uptime: '5d 2h',
    ports: { http: 80, https: 443 },
    configDir: '/data/traefik',
  },
  certificates: [
    { domain: 'app.example.com', expiresAt: '2026-10-01T00:00:00Z', daysUntilExpiry: 45, issuer: "Let's Encrypt" },
    { domain: 'expiring.example.com', expiresAt: '2026-08-30T00:00:00Z', daysUntilExpiry: 13, issuer: "Let's Encrypt" },
    { domain: 'critical.example.com', expiresAt: '2026-08-20T00:00:00Z', daysUntilExpiry: 3, issuer: "Let's Encrypt" },
    { domain: 'null-days.example.com', expiresAt: null, daysUntilExpiry: null, issuer: "Let's Encrypt" },
  ],
  routers: [
    { name: 'app-router', rule: 'Host(`app.example.com`)', service: 'app-service', entryPoints: ['websecure'], tls: true, middleware: ['gzip'] },
    { name: 'http-router', rule: 'Host(`http.example.com`)', service: 'http-service', entryPoints: ['web'], tls: false, middleware: [] },
  ],
  services: [
    { name: 'app-service', url: 'http://10.0.0.2:3000', loadBalancer: 'roundRobin' },
  ],
  middlewares: [
    { name: 'gzip', type: 'compress', config: {} },
  ],
};

describe('Traefik route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userState.user = { id: 1, email: 'admin@nine.local', isOperator: true };
    authedFetchMock.mockImplementation((url: string) => {
      if (url.includes('/v1/traefik/logs')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ logs: ['level=info msg="started"', 'level=warn msg="slow"', 'level=error msg="failed"'] }),
        });
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockInfo),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
  });

  it('renders loading skeleton and then status banner with all tabs', async () => {
    renderWithProviders(<Traefik />);
    expect(screen.getByText('Traefik')).toBeInTheDocument();
    expect(await screen.findByText('Traefik Running')).toBeInTheDocument();
    expect(screen.getByText('v3.0.0')).toBeInTheDocument();
    expect(screen.getByText('Uptime: 5d 2h')).toBeInTheDocument();
    expect(screen.getByText(':80 / :443')).toBeInTheDocument();

    // Overview Tab
    expect(screen.getByText('2 valid')).toBeInTheDocument();
    expect(screen.getByText('1 expiring')).toBeInTheDocument();
    expect(screen.getByText('1 critical')).toBeInTheDocument();
    expect(screen.getByText('1 with TLS')).toBeInTheDocument();
  });

  it('renders stopped state when Traefik is not running', async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (url === '/v1/traefik') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ...mockInfo,
            status: { ...mockInfo.status, running: false, uptime: null, version: null },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });
    renderWithProviders(<Traefik />);
    expect(await screen.findByText('Traefik Stopped')).toBeInTheDocument();
    expect(screen.getByText(/Traefik is not running. Domain routing will be unavailable./)).toBeInTheDocument();
  });

  it('switches to Certificates tab and renders table with expiration badges', async () => {
    renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: /Certificates/ }));

    expect(await screen.findByText('app.example.com')).toBeInTheDocument();
    expect(screen.getByText('expiring.example.com')).toBeInTheDocument();
    expect(screen.getByText('critical.example.com')).toBeInTheDocument();
    expect(screen.getByText('13d')).toBeInTheDocument();
    expect(screen.getByText('3d')).toBeInTheDocument();
  });

  it('renders empty state when certificates list is empty', async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (url === '/v1/traefik') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...mockInfo, certificates: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });
    renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: /^Certificates$/ }));
    expect(await screen.findByText('No SSL certificates configured.')).toBeInTheDocument();
  });

  it('switches to Routers tab and renders routers and backend services', async () => {
    renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: /Routers/ }));

    expect(await screen.findByText('app-router')).toBeInTheDocument();
    expect(screen.getByText('Host(`app.example.com`)')).toBeInTheDocument();
    expect(screen.getByText('websecure')).toBeInTheDocument();
    expect(screen.getByText('→ app-service')).toBeInTheDocument();

    // Backend Services
    expect(screen.getByText('Backend Services')).toBeInTheDocument();
    expect(screen.getByText('http://10.0.0.2:3000')).toBeInTheDocument();
  });

  it('renders empty state when routers list is empty', async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (url === '/v1/traefik') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...mockInfo, routers: [], services: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });
    renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: /^Routers$/ }));
    expect(await screen.findByText('No routers configured.')).toBeInTheDocument();
  });

  it('switches to Logs tab and renders log entries with colored styling', async () => {
    renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));

    expect(await screen.findByText('Recent Logs')).toBeInTheDocument();
    expect(screen.getByText('level=info msg="started"')).toBeInTheDocument();
    expect(screen.getByText('level=warn msg="slow"')).toBeInTheDocument();
    expect(screen.getByText('level=error msg="failed"')).toBeInTheDocument();
  });

  it('renders empty state in Logs tab when logs array is empty', async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (url.includes('/v1/traefik/logs')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockInfo) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
    renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(await screen.findByText('No logs available.')).toBeInTheDocument();
  });

  it('renders loading skeleton in Logs tab while logs are loading', async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (url.includes('/v1/traefik/logs')) {
        return new Promise(() => {}); // never resolves -> isLoading: true
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockInfo) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
    const { container } = renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('restarts Traefik via restart button mutation', async () => {
    renderWithProviders(<Traefik />);
    expect(await screen.findByText('Traefik Running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }));
    await waitFor(() => expect(authedFetchMock).toHaveBeenCalledWith('/v1/traefik/restart', { method: 'POST' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Traefik restarted successfully', 'success'));
  });

  it('handles restart failure gracefully', async () => {
    authedFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === '/v1/traefik/restart' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false });
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockInfo) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });
    renderWithProviders(<Traefik />);
    expect(await screen.findByText('Traefik Running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Failed to restart Traefik', 'error'));
  });

  it('backs up certificates via backup button mutation', async () => {
    renderWithProviders(<Traefik />);
    expect(await screen.findByText('Traefik Running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Backup Certs/ }));
    await waitFor(() => expect(authedFetchMock).toHaveBeenCalledWith('/v1/traefik/backup-certs', { method: 'POST' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Certificates backed up successfully', 'success'));
  });

  it('handles backup failure gracefully', async () => {
    authedFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === '/v1/traefik/backup-certs' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false });
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockInfo) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });
    renderWithProviders(<Traefik />);
    expect(await screen.findByText('Traefik Running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Backup Certs/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Failed to backup certificates', 'error'));
  });

  it('shows pending labels when restart and backup are in flight', async () => {
    let resolveRestart: (val: unknown) => void = () => {};
    let resolveBackup: (val: unknown) => void = () => {};
    authedFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === '/v1/traefik/restart' && opts?.method === 'POST') {
        return new Promise((res) => { resolveRestart = res; });
      }
      if (url === '/v1/traefik/backup-certs' && opts?.method === 'POST') {
        return new Promise((res) => { resolveBackup = res; });
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockInfo) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });
    renderWithProviders(<Traefik />);
    expect(await screen.findByText('Traefik Running')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Restart/ }));
    expect(await screen.findByText('Restarting…')).toBeInTheDocument();
    resolveRestart({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await screen.findByText('Restart');

    fireEvent.click(screen.getByRole('button', { name: /Backup Certs/ }));
    expect(await screen.findByText('Backing up…')).toBeInTheDocument();
    resolveBackup({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await screen.findByText('Backup Certs');
  });

  it('handles logs query error gracefully', async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (url.includes('/v1/traefik/logs')) return Promise.resolve({ ok: false });
      if (url === '/v1/traefik') return Promise.resolve({ ok: true, json: () => Promise.resolve(mockInfo) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
    renderWithProviders(<Traefik />);
    await screen.findByText('Traefik Running');
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(await screen.findByText('No logs available.')).toBeInTheDocument();
  });

  it('renders error card when info query fails and allows retry', async () => {
    authedFetchMock.mockImplementation((url: string) => {
      if (url === '/v1/traefik') return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });
    renderWithProviders(<Traefik />);
    expect(await screen.findByText("Couldn't load Traefik status")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
  });

  it('hides admin buttons when user is non-admin', async () => {
    userState.user = { id: 2, email: 'user@nine.local', isOperator: false };
    renderWithProviders(<Traefik />);
    expect(await screen.findByText('Traefik Running')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Backup Certs/ })).toBeNull();
  });

  it('renders update button when outdated and handles update mutation and in-flight state', async () => {
    let resolveUpdate: (val: unknown) => void = () => {};
    authedFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === '/v1/traefik/update' && opts?.method === 'POST') {
        return new Promise((res) => { resolveUpdate = res; });
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ...mockInfo,
            status: {
              ...mockInfo.status,
              outdated: true,
              versionLatest: '3.1.0',
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });

    renderWithProviders(<Traefik />);
    expect(await screen.findByText('→ v3.1.0')).toBeInTheDocument();
    const updateBtn = screen.getByRole('button', { name: /Update to v3.1.0/ });
    fireEvent.click(updateBtn);
    expect(await screen.findByText('Updating…')).toBeInTheDocument();
    resolveUpdate({ ok: true, json: () => Promise.resolve({ ok: true, newVersion: '3.1.0' }) });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Traefik updated to v3.1.0', 'success'));

    // r346: an unknown new version (registry lookup failed) never reads "vnull".
    fireEvent.click(await screen.findByRole('button', { name: /Update to v3.1.0/ }));
    await screen.findByText('Updating…');
    resolveUpdate({ ok: true, json: () => Promise.resolve({ ok: true, newVersion: null }) });
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Traefik updated to the latest image', 'success'));
    expect(toastSpy.toast).not.toHaveBeenCalledWith('Traefik updated to vnull', 'success');
  });

  it('handles Traefik update error gracefully', async () => {
    authedFetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === '/v1/traefik/update' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false });
      }
      if (url === '/v1/traefik') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ...mockInfo,
            status: {
              ...mockInfo.status,
              outdated: true,
              versionLatest: '3.1.0',
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ logs: [] }) });
    });

    renderWithProviders(<Traefik />);
    const updateBtn = await screen.findByRole('button', { name: /Update to v3.1.0/ });
    fireEvent.click(updateBtn);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Failed to update Traefik: Failed to update Traefik', 'error'));
  });
});
