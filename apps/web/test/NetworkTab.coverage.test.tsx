import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * Self-contained mocks, as in NetworkTabDns.test.tsx: the shared fake api
 * module has no domains.dnsCheck / domains.verify.
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
      verify: vi.fn(),
      generate: vi.fn(),
    },
    services: {
      update: vi.fn(),
      routing: vi.fn(async () => ({ live: true, liveNote: null, container: null, http: [], ports: [] })),
      hostAddresses: vi.fn(async () => ({ detected: false, addresses: [] })),
    },
  },
  authedFetch: vi.fn(),
}));
vi.mock('../src/lib/api.js', () => apiMock);

const authMock = vi.hoisted(() => ({ user: { id: 1, isOperator: true, email: 'a@test', name: 'A' } }));
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children?: React.ReactNode }) => children, useAuth: () => authMock }));

import { NetworkTab } from '../src/routes/service/NetworkTab.js';

const api = apiMock.api;
const mockOf = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

const service = {
  id: 1,
  name: 'web',
  slug: 'web',
  type: 'docker',
  branch: 'main',
  port: 3000,
  publishedPort: null as number | null,
  repoUrl: null,
  image: 'nginx:latest',
  serverId: null,
  status: 'running',
  healthPath: '/',
};

const row = { id: 9, hostname: 'app.example.com', path: '/', ssl: false, redirectWww: false, status: 'active' };

function renderTab(svc: Partial<typeof service> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <NetworkTab serviceId={1} svc={{ ...service, ...svc } as never} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  for (const fn of [api.services.update, api.domains.list, api.domains.create, api.domains.update, api.domains.remove, api.domains.setSsl, api.domains.dnsCheck, api.domains.generate]) {
    mockOf(fn as never).mockReset();
  }
  mockOf(api.domains.list).mockResolvedValue([] as never);
});

describe('NetworkTab — container port', () => {
  it('saves a new container port and confirms the Traefik update', async () => {
    mockOf(api.services.update).mockResolvedValue({} as never);
    renderTab();
    const input = await screen.findByLabelText('Internal container port');
    expect(input).toHaveValue('3000');
    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByText('Enter a port from 1 to 65535.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Port' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Port' }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { port: 8080 }));
    expect(await screen.findByText('Container port :8080 saved — Traefik routing updated')).toBeInTheDocument();
  });

  it('reports a refused container port change', async () => {
    mockOf(api.services.update).mockRejectedValue(new Error('nope'));
    renderTab();
    fireEvent.change(await screen.findByLabelText('Internal container port'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Port' }));
    expect(await screen.findByText('Could not update the container port')).toBeInTheDocument();
  });
});

describe('NetworkTab — direct host port', () => {
  it('refuses an out-of-range port, then publishes a valid one', async () => {
    mockOf(api.services.update).mockResolvedValue({} as never);
    renderTab();
    const input = await screen.findByPlaceholderText('e.g. 8080 or 3000');
    fireEvent.change(input, { target: { value: '70000' } });
    // The browser's min/max check would block the button; the handler has its own guard.
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText('Please enter a valid port between 1 and 65535')).toBeInTheDocument();
    expect(api.services.update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish Port' }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { publishedPort: 8080 }));
    expect(await screen.findByText('Host port :8080 exposed')).toBeInTheDocument();
  });

  it('changes a published port: the editor opens prefilled and can be cancelled', async () => {
    renderTab({ publishedPort: 9000 });
    expect(await screen.findByText('Published on :9000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change Port' }));
    expect(screen.getByPlaceholderText('e.g. 8080 or 3000')).toHaveValue(9000);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText('e.g. 8080 or 3000')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change Port' })).toBeInTheDocument();
  });

  it('disables the published port, and reports a refusal', async () => {
    mockOf(api.services.update).mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({} as never);
    renderTab({ publishedPort: 9000 });
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Could not update host port mapping')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Direct host port disabled')).toBeInTheDocument();
    expect(api.services.update).toHaveBeenLastCalledWith(1, { publishedPort: null });
  });

  it('a compose stack can only clear a stored host port', async () => {
    mockOf(api.services.update).mockResolvedValue({} as never);
    renderTab({ type: 'compose', publishedPort: 9000 });
    expect(await screen.findByText('A stored host port :9000 is not applied to compose stacks.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish Port' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(api.services.update).toHaveBeenCalledWith(1, { publishedPort: null }));
  });
});

describe('NetworkTab — domain list actions', () => {
  it('turns HTTPS and the www redirect on for a domain, and reports refusals', async () => {
    mockOf(api.domains.list).mockResolvedValue([row] as never);
    mockOf(api.domains.setSsl).mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('acme'));
    mockOf(api.domains.update).mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('nope'));
    renderTab();
    const https = await screen.findByRole('button', { name: 'HTTP' });
    fireEvent.click(https);
    await waitFor(() => expect(api.domains.setSsl).toHaveBeenCalledWith(9, true));
    fireEvent.click(screen.getByRole('button', { name: 'www' }));
    await waitFor(() => expect(api.domains.update).toHaveBeenCalledWith(1, 9, { redirectWww: true }));
    fireEvent.click(screen.getByRole('button', { name: 'HTTP' }));
    expect(await screen.findByText('Could not toggle SSL')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'www' }));
    expect(await screen.findByText('Could not toggle the www redirect')).toBeInTheDocument();
  });

  it('reports a DNS check that could not run', async () => {
    mockOf(api.domains.list).mockResolvedValue([row] as never);
    mockOf(api.domains.dnsCheck).mockRejectedValue(new Error('resolver down'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Check DNS' }));
    expect(await screen.findByText('Could not run the DNS check')).toBeInTheDocument();
    expect(api.domains.dnsCheck).toHaveBeenCalledWith(1, 9);
  });

  it('removes a domain only after confirmation, and reports a refusal', async () => {
    mockOf(api.domains.list).mockResolvedValue([row] as never);
    mockOf(api.domains.remove).mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce(undefined as never);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove app.example.com' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.domains.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove app.example.com' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Could not remove the domain')).toBeInTheDocument();
    expect(api.domains.remove).toHaveBeenCalledWith(1, 9);
  });

  it('a confirmed removal reloads the domain list', async () => {
    mockOf(api.domains.list).mockResolvedValueOnce([row] as never).mockResolvedValue([] as never);
    mockOf(api.domains.remove).mockResolvedValue(undefined as never);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove app.example.com' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.domains.remove).toHaveBeenCalledWith(1, 9));
    expect(await screen.findByText('No domains attached.')).toBeInTheDocument();
  });

  it('says when the automatic URL is already attached', async () => {
    mockOf(api.domains.generate).mockResolvedValue({ id: 3, hostname: 'web.203.0.113.10.sslip.io', created: false } as never);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Generate URL/ }));
    expect(await screen.findByText('web.203.0.113.10.sslip.io is already attached')).toBeInTheDocument();
  });

  it('falls back to a generic message when the add is refused without a reason, and normalises a typed path on blur', async () => {
    mockOf(api.domains.create).mockRejectedValue(new Error(''));
    renderTab();
    const host = await screen.findByLabelText('Domain');
    fireEvent.change(host, { target: { value: 'app.example.com' } });
    const path = screen.getByLabelText('Path');
    fireEvent.change(path, { target: { value: 'api//v1/' } });
    fireEvent.blur(path);
    expect(path).toHaveValue('/api/v1');
    fireEvent.submit(host.closest('form')!);
    await waitFor(() => expect(api.domains.create).toHaveBeenCalledWith(1, { hostname: 'app.example.com', path: '/api/v1' }));
    expect(await screen.findByText('Could not add the domain')).toBeInTheDocument();
  });
});

describe('NetworkTab — changing a hostname', () => {
  it('a no-op edit closes without a call; cancel closes the editor; the path is normalised on blur', async () => {
    mockOf(api.domains.list).mockResolvedValue([row] as never);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit app.example.com' }));
    const host = screen.getByLabelText('New hostname');
    expect(host).toHaveValue('app.example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('New hostname')).not.toBeInTheDocument());
    expect(api.domains.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit app.example.com' }));
    const path = screen.getByLabelText('New path');
    fireEvent.change(path, { target: { value: 'shop/' } });
    fireEvent.blur(path);
    expect(path).toHaveValue('/shop');
    const form = path.closest('form')!;
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('New path')).not.toBeInTheDocument();
  });

  it('carries redirect rules to the new hostname and removes the old one once it is live', async () => {
    const redirects = [{ regex: '^https://app\\.example\\.com/a$', replacement: 'https://app.example.com/b', permanent: true }];
    mockOf(api.domains.list).mockResolvedValue([{ ...row, ssl: true, headers: '[{"name":"X-A","value":"1"}]', redirects }] as never);
    mockOf(api.domains.create).mockResolvedValue({ id: 20, hostname: 'shop.example.com', path: '/api', status: 'active', verification: null } as never);
    mockOf(api.domains.update).mockResolvedValue({} as never);
    mockOf(api.domains.remove).mockResolvedValue(undefined as never);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit app.example.com' }));
    fireEvent.change(screen.getByLabelText('New hostname'), { target: { value: 'https://Shop.example.com/api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.domains.create).toHaveBeenCalledWith(1, {
        hostname: 'shop.example.com', path: '/api', ssl: true, headers: '[{"name":"X-A","value":"1"}]',
        basicAuth: null, ipAllowlist: null, rateLimitAverage: null, rateLimitBurst: null,
      }),
    );
    await waitFor(() => expect(api.domains.update).toHaveBeenCalledWith(1, 20, { redirects }));
    await waitFor(() => expect(api.domains.remove).toHaveBeenCalledWith(1, 9));
    expect(await screen.findByText('app.example.com now routes as shop.example.com/api')).toBeInTheDocument();
  });

  it('keeps the old hostname while a pending replacement shows its TXT record', async () => {
    const verification = { recordName: '_ninedeploy-challenge.theirs.org', recordType: 'TXT', recordValue: 'tok-replace' };
    const created = { id: 21, hostname: 'theirs.org', path: '/', ssl: false, redirectWww: false, status: 'pending' };
    mockOf(api.domains.list).mockResolvedValueOnce([row] as never).mockResolvedValue([row, created] as never);
    mockOf(api.domains.create).mockResolvedValue({ ...created, verification } as never);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit app.example.com' }));
    fireEvent.change(screen.getByLabelText('New hostname'), { target: { value: 'theirs.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('theirs.org added as pending — app.example.com keeps routing until you verify the new one, then remove it')).toBeInTheDocument();
    expect(await screen.findByText('tok-replace')).toBeInTheDocument();
    expect(api.domains.remove).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the new hostname is refused, and removes nothing", async () => {
    mockOf(api.domains.list).mockResolvedValue([row] as never);
    mockOf(api.domains.create).mockRejectedValue(new Error('shop.example.com is taken'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit app.example.com' }));
    fireEvent.change(screen.getByLabelText('New hostname'), { target: { value: 'shop.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('shop.example.com is taken')).toBeInTheDocument();
    expect(api.domains.remove).not.toHaveBeenCalled();
    expect(screen.getByLabelText('New hostname')).toBeInTheDocument();
  });
});

describe('NetworkTab — domain security settings', () => {
  it('saves basic auth, an allowlist and rate limits, then closes the panel', async () => {
    mockOf(api.domains.list).mockResolvedValue([row] as never);
    mockOf(api.domains.update).mockResolvedValue({} as never);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Security/ }));
    fireEvent.change(screen.getByPlaceholderText("admin:password or ['user:hash']"), { target: { value: ' admin:pw ' } });
    fireEvent.change(screen.getByPlaceholderText('192.168.1.0/24, 10.0.0.1'), { target: { value: '10.0.0.0/8' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 50 (0 = disabled)'), { target: { value: '50' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 100'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Security Settings' }));
    await waitFor(() =>
      expect(api.domains.update).toHaveBeenCalledWith(1, 9, { basicAuth: 'admin:pw', ipAllowlist: '10.0.0.0/8', rateLimitAverage: 50, rateLimitBurst: 100 }),
    );
    expect(await screen.findByText('Domain security settings updated')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Security Settings' })).not.toBeInTheDocument();
  });

  it('clears the settings to null, reports a refusal, and can be cancelled', async () => {
    mockOf(api.domains.list).mockResolvedValue([{ ...row, basicAuth: 'a:b', ipAllowlist: '1.2.3.4', rateLimitAverage: 5, rateLimitBurst: 10 }] as never);
    mockOf(api.domains.update).mockRejectedValue(new Error('nope'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Security/ }));
    fireEvent.change(screen.getByPlaceholderText("admin:password or ['user:hash']"), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('192.168.1.0/24, 10.0.0.1'), { target: { value: '  ' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 50 (0 = disabled)'), { target: { value: '' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 100'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Security Settings' }));
    await waitFor(() =>
      expect(api.domains.update).toHaveBeenCalledWith(1, 9, { basicAuth: null, ipAllowlist: null, rateLimitAverage: null, rateLimitBurst: null }),
    );
    expect(await screen.findByText('Could not update domain security settings')).toBeInTheDocument();
    const panel = screen.getByRole('button', { name: 'Save Security Settings' }).parentElement!;
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save Security Settings' })).not.toBeInTheDocument();
  });
});
