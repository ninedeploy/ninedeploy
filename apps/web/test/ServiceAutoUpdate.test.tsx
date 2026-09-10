import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * The auto-update switch only applies to image-based docker services —
 * it must render for those (remote nodes included: the watch reads the
 * registry, not the node), fire an immediate dedicated PATCH on toggle (not
 * ride the big settings form), and stay hidden for repo-backed services
 * where the server would refuse the flag anyway.
 *
 * Self-contained mocks (no ./helpers.js) — see SettingsTabPrivilege.test.tsx
 * for why: helpers pulls in modules that hang vitest collection here.
 */

const apiMock = vi.hoisted(() => ({
  api: {
    services: { get: vi.fn(), update: vi.fn() },
    limits: { setService: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

import { SettingsTab } from '../src/routes/service/SettingsTab.js';

const imageService = {
  id: 1,
  name: 'img',
  slug: 'img',
  type: 'docker',
  branch: 'main',
  port: 3000,
  repoUrl: null,
  image: 'ghcr.io/acme/web:latest',
  serverId: null,
  autoUpdate: false,
  status: 'running',
  healthPath: '/',
  cpuShares: 0,
  memLimitMb: 0,
  build: { buildPack: 'auto', baseDir: '/', installCmd: '', buildCmd: '', startCmd: '', dockerfilePath: null, preDeployCmd: null, postDeployCmd: null, preStopCmd: null },
};

function renderTab(svc: Record<string, unknown>) {
  // SettingsCard reads the service through its own query, not the prop —
  // keep both views of the row identical.
  apiMock.api.services.get.mockResolvedValue(svc);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SettingsTab serviceId={1} svc={svc as never} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('SettingsTab auto-update switch', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    apiMock.api.services.get.mockResolvedValue(imageService);
    apiMock.api.services.update.mockResolvedValue(imageService);
    apiMock.api.limits.setService.mockResolvedValue({ cpuShares: 0, memLimitMb: 0 });
  });

  it('fires an immediate autoUpdate PATCH when toggled on', async () => {
    renderTab(imageService);
    const toggle = await screen.findByRole('switch', { name: 'Auto-update' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(1, { autoUpdate: true }));
  });

  it('renders the current enabled state', async () => {
    renderTab({ ...imageService, autoUpdate: true });
    const toggle = await screen.findByRole('switch', { name: 'Auto-update' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('stays hidden for repo-backed services', async () => {
    renderTab({ ...imageService, image: null, repoUrl: 'https://github.com/x/y' });
    await screen.findByText('Service settings');
    expect(screen.queryByRole('switch', { name: 'Auto-update' })).not.toBeInTheDocument();
  });

  it('renders for remote-node image services — the watch reads the registry, not the node', async () => {
    renderTab({ ...imageService, serverId: 3 });
    const toggle = await screen.findByRole('switch', { name: 'Auto-update' });
    expect(toggle).toBeInTheDocument();
  });
});
