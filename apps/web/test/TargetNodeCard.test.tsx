import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * r037 — the "Target node" card.
 *
 * The API had accepted `serverId` on service create and update since the fleet
 * feature shipped and the panel offered no way to set it, so multi-node was
 * reachable only from the CLI or a raw API call. Now that a docker service
 * pinned to a node is genuinely built and started there, the field needs a home
 * in the UI — otherwise the feature is written, tested and unreachable, which is
 * the defect this codebase keeps repeating.
 *
 * Deliberately self-contained (no `./helpers.js`): every web test file that
 * pulls helpers in currently hangs vitest collection in this repo, which is a
 * pre-existing problem unrelated to this change.
 */

const apiMock = vi.hoisted(() => ({
  api: {
    services: { get: vi.fn(), update: vi.fn() },
    limits: { setService: vi.fn() },
    servers: { list: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => children,
  useAuth: () => authMock,
}));

import { SettingsTab } from '../src/routes/service/SettingsTab.js';

const baseService = {
  id: 1,
  name: 'api',
  slug: 'api',
  type: 'docker',
  branch: 'main',
  port: 3000,
  repoUrl: 'https://github.com/x/y',
  status: 'running',
  healthPath: '/',
  cpuShares: 0,
  memLimitMb: 0,
  serverId: null as number | null,
  build: {
    buildPack: 'auto',
    baseDir: '/',
    installCmd: 'npm ci',
    buildCmd: 'npm run build',
    startCmd: 'npm start',
    dockerfilePath: null,
    preDeployCmd: null,
    postDeployCmd: null,
    preStopCmd: null,
  },
};

function renderTab(over: Record<string, unknown> = {}) {
  const svc = { ...baseService, ...over };
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

const TIMEOUT = 30_000;

describe('SettingsTab target node', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.user = { id: 1, isOperator: true, email: 'a@test', name: 'A' };
    apiMock.api.services.update.mockResolvedValue(baseService);
    apiMock.api.limits.setService.mockResolvedValue({ cpuShares: 0, memLimitMb: 0 });
    apiMock.api.servers.list.mockResolvedValue([
      { id: 4, name: 'eu-west-1', host: '10.0.0.4', port: 4600, status: 'online', lastSeenAt: null },
      { id: 5, name: 'spare', host: '10.0.0.5', port: 4600, status: 'offline', lastSeenAt: null },
    ]);
  });

  it('offers every registered node plus the panel host', async () => {
    renderTab();
    await screen.findByText('Target node');
    await waitFor(() => expect(apiMock.api.servers.list).toHaveBeenCalled(), { timeout: TIMEOUT });

    expect(screen.getByRole('option', { name: 'This panel host' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /eu-west-1/ })).toBeInTheDocument();
    // A node that is not online is still offerable — the operator may be
    // staging the move before bringing it up.
    expect(screen.getByRole('option', { name: /spare.*offline/ })).toBeInTheDocument();
  }, TIMEOUT);

  it('sends the chosen node id', async () => {
    renderTab();
    await screen.findByText('Target node');
    await waitFor(() => expect(apiMock.api.servers.list).toHaveBeenCalled(), { timeout: TIMEOUT });

    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /Save target/ }));

    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(1, { serverId: 4 }), {
      timeout: TIMEOUT,
    });
  }, TIMEOUT);

  it('sends null when the service is moved back to the panel host', async () => {
    renderTab({ serverId: 4 });
    await screen.findByText('Target node');
    await waitFor(() => expect(apiMock.api.servers.list).toHaveBeenCalled(), { timeout: TIMEOUT });

    fireEvent.change(screen.getByLabelText('Runs on'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save target/ }));

    // `null` is what clears the pin; an empty string would fail schema validation.
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(1, { serverId: null }), {
      timeout: TIMEOUT,
    });
  }, TIMEOUT);

  it('reports a failed save instead of leaving the operator guessing', async () => {
    apiMock.api.services.update.mockRejectedValue(new Error('nope'));
    renderTab();
    await screen.findByText('Target node');
    await waitFor(() => expect(apiMock.api.servers.list).toHaveBeenCalled(), { timeout: TIMEOUT });

    fireEvent.click(screen.getByRole('button', { name: /Save target/ }));
    expect(await screen.findByText('Could not save the target node', {}, { timeout: TIMEOUT })).toBeInTheDocument();
  }, TIMEOUT);

  it('explains the limit for a pm2 service instead of offering a choice that would fail', async () => {
    renderTab({ type: 'pm2' });
    await screen.findByText('Target node');

    expect(screen.queryByLabelText('Runs on')).not.toBeInTheDocument();
    expect(screen.getByText(/PM2 services run on this panel host/)).toBeInTheDocument();
    // Never ask an operator-only endpoint for a card that offers no choice.
    expect(apiMock.api.servers.list).not.toHaveBeenCalled();
  }, TIMEOUT);

  it('offers a node to a compose stack — most templates are compose-shaped', async () => {
    renderTab({ type: 'compose' });
    await screen.findByText('Target node');
    await waitFor(() => expect(apiMock.api.servers.list).toHaveBeenCalled(), { timeout: TIMEOUT });
    expect(screen.getByLabelText('Runs on')).toBeInTheDocument();
  }, TIMEOUT);

  it('shows a member the current target read-only and never lists nodes', async () => {
    authMock.user = { id: 2, isOperator: false, email: 'm@test', name: 'M' } as never;
    renderTab({ serverId: 4 });
    await screen.findByText('Target node');

    // The node listing is operator-only; a select here would 403 on load.
    expect(apiMock.api.servers.list).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Runs on')).not.toBeInTheDocument();
    expect(screen.getByText(/Only an instance operator/)).toBeInTheDocument();
    expect(screen.getByText('node #4')).toBeInTheDocument();
  }, TIMEOUT);
});
