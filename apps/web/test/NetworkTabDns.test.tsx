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
      verify: vi.fn(),
      generate: vi.fn(),
    },
    ports: { list: vi.fn() },
    services: { routing: vi.fn(async () => ({ live: true, liveNote: null, container: null, http: [], ports: [] })) },
  },
  authedFetch: vi.fn(),
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

describe('NetworkTab domain ownership (r345)', () => {
  afterEach(cleanup);

  const challenge = { recordName: '_ninedeploy-challenge.claimed.example.org', recordType: 'TXT', recordValue: 'nd-verify-abc123' };
  const pendingRow = { id: 5, hostname: 'claimed.example.org', path: '/', ssl: true, redirectWww: false, status: 'pending' };

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.ports.list.mockResolvedValue([]);
    apiMock.api.domains.list.mockResolvedValue([]);
  });

  it('shows the TXT challenge from the create response for a pending domain', async () => {
    apiMock.api.domains.create.mockResolvedValue({ ...pendingRow, verification: challenge });
    renderTab();
    const input = await screen.findByPlaceholderText('app.example.com');
    apiMock.api.domains.list.mockResolvedValue([pendingRow]);
    fireEvent.change(input, { target: { value: 'claimed.example.org' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText(challenge.recordName)).toBeInTheDocument();
    expect(screen.getByText(challenge.recordValue)).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('verifies a pending domain through the SDK verify method (r563)', async () => {
    apiMock.api.domains.list.mockResolvedValue([pendingRow]);
    apiMock.api.domains.verify
      .mockResolvedValueOnce({ verified: false, error: 'TXT record not found', verification: challenge })
      .mockResolvedValueOnce({ verified: true, verification: null });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(apiMock.api.domains.verify).toHaveBeenCalledWith(1, 5));
    expect(apiMock.authedFetch).not.toHaveBeenCalled();
    // A failed check still hands back the record to publish.
    expect(await screen.findByText(challenge.recordValue)).toBeInTheDocument();
    apiMock.api.domains.list.mockResolvedValue([{ ...pendingRow, status: 'active' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument());
  });

  it('surfaces a refused verification', async () => {
    apiMock.api.domains.list.mockResolvedValue([pendingRow]);
    apiMock.api.domains.verify.mockRejectedValueOnce(new Error('nope'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});

describe('NetworkTab Generate URL (0.16.1)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.domains.list.mockResolvedValue([]);
    apiMock.api.ports.list.mockResolvedValue([]);
  });

  it('adds the automatic URL and refreshes the list', async () => {
    apiMock.api.domains.generate.mockResolvedValue({ id: 3, hostname: 'web.203.0.113.10.sslip.io', created: true });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Generate URL/ }));
    await waitFor(() => expect(apiMock.api.domains.generate).toHaveBeenCalledWith(1));
    expect(await screen.findByText('web.203.0.113.10.sslip.io is routed to this service')).toBeInTheDocument();
    await waitFor(() => expect(apiMock.api.domains.list.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows the server's reason when automatic URLs are off", async () => {
    apiMock.api.domains.generate.mockRejectedValue(new Error('Automatic URLs are off. An operator turns them on under Settings → Automatic URLs.'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Generate URL/ }));
    expect(await screen.findByText(/Automatic URLs are off/)).toBeInTheDocument();
  });
});

describe('NetworkTab path routing (0.16.1)', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.domains.list.mockResolvedValue([]);
    apiMock.api.ports.list.mockResolvedValue([]);
    apiMock.api.domains.create.mockResolvedValue({ id: 9, hostname: 'app.example.com', path: '/api', status: 'active' });
  });

  it('sends a typed path, normalised', async () => {
    renderTab();
    const host = await screen.findByLabelText('Domain');
    fireEvent.change(host, { target: { value: 'app.example.com' } });
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: 'api/v1/?x=1' } });
    fireEvent.submit(host.closest('form')!);
    await waitFor(() => expect(apiMock.api.domains.create).toHaveBeenCalledWith(1, { hostname: 'app.example.com', path: '/api/v1' }));
  });

  it("moves a pasted URL's path into the path field", async () => {
    renderTab();
    const host = await screen.findByLabelText('Domain');
    fireEvent.change(host, { target: { value: 'https://App.Example.com/api/' } });
    fireEvent.blur(host);
    expect(host).toHaveValue('app.example.com');
    expect(screen.getByLabelText('Path')).toHaveValue('/api');
    fireEvent.submit(host.closest('form')!);
    await waitFor(() => expect(apiMock.api.domains.create).toHaveBeenCalledWith(1, { hostname: 'app.example.com', path: '/api' }));
  });

  it('a bare host routes the whole host, sent exactly as before', async () => {
    renderTab();
    const host = await screen.findByLabelText('Domain');
    fireEvent.change(host, { target: { value: 'app.example.com' } });
    fireEvent.submit(host.closest('form')!);
    await waitFor(() => expect(apiMock.api.domains.create).toHaveBeenCalledWith(1, { hostname: 'app.example.com' }));
  });

  it("shows the server's reason when the add is refused", async () => {
    apiMock.api.domains.create.mockRejectedValue(new Error('That hostname is already routed to another service'));
    renderTab();
    const host = await screen.findByLabelText('Domain');
    fireEvent.change(host, { target: { value: 'taken.example.com' } });
    fireEvent.submit(host.closest('form')!);
    expect(await screen.findByText(/already routed to another service/)).toBeInTheDocument();
  });
});

describe('NetworkTab domain redirects (0.16.1)', () => {
  /** Traefik's first-capture placeholder, spelled so it is not read as a template string. */
  const CAPTURE_1 = '\u0024{1}';
  afterEach(cleanup);
  const row = { id: 7, hostname: 'example.com', path: '/', ssl: true, redirectWww: false, status: 'active', redirects: [] as unknown[] };
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.ports.list.mockResolvedValue([]);
    apiMock.api.domains.update.mockResolvedValue({});
  });

  it('adds a moved-path rule, edits it and saves the list', async () => {
    apiMock.api.domains.list.mockResolvedValue([row]);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Security/ }));
    expect(screen.getByText('No redirect rules.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Moved path/ }));
    expect(screen.getByLabelText('Redirect 1 pattern')).toHaveValue('^https?://example\\.com/old/(.*)');
    expect(screen.getByLabelText('Redirect 1 target')).toHaveValue(`https://example.com/new/${CAPTURE_1}`);
    expect(screen.getByLabelText('Redirect 1 permanent')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /^Rule$/ }));
    fireEvent.change(screen.getByLabelText('Redirect 2 pattern'), { target: { value: '^https://example\\.com/x$' } });
    fireEvent.change(screen.getByLabelText('Redirect 2 target'), { target: { value: 'https://example.com/y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save redirects' }));
    await waitFor(() =>
      expect(apiMock.api.domains.update).toHaveBeenCalledWith(1, 7, {
        redirects: [
          { regex: '^https?://example\\.com/old/(.*)', replacement: `https://example.com/new/${CAPTURE_1}`, permanent: true },
          { regex: '^https://example\\.com/x$', replacement: 'https://example.com/y', permanent: false },
        ],
      }),
    );
    expect(await screen.findByText('2 redirect rules saved')).toBeInTheDocument();
  });

  it('flags a pattern Traefik cannot run and blocks saving; removing the rule clears it', async () => {
    apiMock.api.domains.list.mockResolvedValue([{ ...row, redirects: [{ regex: '^a$', replacement: 'https://b/', permanent: false }] }]);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Security/ }));
    fireEvent.change(screen.getByLabelText('Redirect 1 pattern'), { target: { value: '^https://a/(?!keep)' } });
    expect(screen.getByText(/lookahead \/ lookbehind are not supported/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save redirects' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Redirect 1 target'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove redirect 1' }));
    expect(screen.getByRole('button', { name: 'Save redirects' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save redirects' }));
    await waitFor(() => expect(apiMock.api.domains.update).toHaveBeenCalledWith(1, 7, { redirects: [] }));
    expect(await screen.findByText('Redirect rules removed')).toBeInTheDocument();
  });

  it("shows the server's refusal, and is absent on a panel without the field", async () => {
    apiMock.api.domains.list.mockResolvedValue([row]);
    apiMock.api.domains.update.mockRejectedValue(new Error('redirects.0.regex: not a valid regular expression'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Security/ }));
    fireEvent.click(screen.getByRole('button', { name: /Moved path/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save redirects' }));
    expect(await screen.findByText(/not a valid regular expression/)).toBeInTheDocument();
    cleanup();
    const { redirects: _r, ...older } = row;
    apiMock.api.domains.list.mockResolvedValue([older]);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Security/ }));
    expect(screen.queryByRole('button', { name: 'Save redirects' })).not.toBeInTheDocument();
  });
});
