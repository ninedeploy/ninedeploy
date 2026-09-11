import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * The DNS chip on a custom-domain row calls the per-domain dnsCheck endpoint
 * and renders the resolved status. Self-contained mocks (no ./helpers.js) —
 * see SettingsTabPrivilege.test.tsx for why.
 */

const apiMock = vi.hoisted(() => ({
  api: {
    domains: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      setSsl: vi.fn(),
      update: vi.fn(),
      dnsCheck: vi.fn(),
    },
    ports: { list: vi.fn() },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

import { NetworkTab } from '../src/routes/service/NetworkTab.js';

const service = {
  id: 1,
  name: 'web',
  slug: 'web',
  type: 'docker',
  branch: 'main',
  port: 3000,
  repoUrl: null,
  image: 'nginx:latest',
  serverId: null,
  status: 'running',
  healthPath: '/',
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <NetworkTab serviceId={1} svc={service as never} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('NetworkTab DNS chip', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.domains.list.mockResolvedValue([
      { id: 9, hostname: 'app.example.com', path: '/', ssl: false, redirectWww: false },
    ]);
    apiMock.api.domains.dnsCheck.mockResolvedValue({
      hostname: 'app.example.com',
      status: 'ok',
      addresses: { a: ['203.0.113.5'], aaaa: [] },
      expected: ['203.0.113.5'],
    });
    apiMock.api.ports.list.mockResolvedValue([]);
  });

  it('runs the DNS check and shows the resolved status', async () => {
    renderTab();
    const chip = await screen.findByText('Check DNS');
    fireEvent.click(chip);
    await waitFor(() => expect(apiMock.api.domains.dnsCheck).toHaveBeenCalledWith(1, 9));
    await screen.findByText('DNS: ok');
  });
});
