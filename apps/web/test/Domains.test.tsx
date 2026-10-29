import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { Domains } from '../src/routes/Domains.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const domains = [
  { id: 1, hostname: 'app.example.com', path: '/', serviceId: 5, serviceName: 'app', port: 3000, container: 'nd-app', ssl: true, status: 'active', certExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
  { id: 2, hostname: 'blog.example.com', path: '/blog', serviceId: null, serviceName: null, port: null, container: null, ssl: false, status: 'idle' },
  { id: 3, hostname: 'api.example.com', path: '/', serviceId: 9, serviceName: 'api', port: null, container: 'nd-api', ssl: false, status: 'deploying' },
];

describe('Domains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows certificate expiry badges with a warning under 14 days', async () => {
    mockOf(api.domains.all).mockResolvedValueOnce([
      { ...domains[0]!, certExpiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
      { ...domains[1]!, ssl: true, certExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() },
    ] as never);
    renderWithProviders(<Domains />);
    expect(await screen.findByText(/cert 5d/)).toBeInTheDocument();
    expect(screen.getByText(/cert 90d/)).toBeInTheDocument();
  });

  it('shows skeleton while loading', () => {
    mockOf(api.domains.all).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Domains />);
    expect(document.querySelector('.nd-shimmer, .animate-pulse')).not.toBeNull();
  });

  it('shows empty state when there are no domains', async () => {
    mockOf(api.domains.all).mockResolvedValue([] as never);
    renderWithProviders(<Domains />);
    await screen.findByText('No domains');
  });

  it('renders the routing table with ssl toggle and status badge', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.setSsl).mockResolvedValue({ id: 1, ssl: false } as never);
    renderWithProviders(<Domains />);
    await screen.findByText('app.example.com');
    // ssl on -> https link
    const link = screen.getByRole('link', { name: 'app.example.com' });
    expect(link).toHaveAttribute('href', 'https://app.example.com');
    // ssl off -> http link
    expect(screen.getByRole('link', { name: 'blog.example.com' })).toHaveAttribute('href', 'http://blog.example.com');
    // path shown only when !== '/'
    expect(screen.getByText('/blog')).toBeInTheDocument();
    // service link and port
    expect(screen.getByRole('link', { name: /app :3000/ })).toHaveAttribute('href', '/services/5');
    // port fallback when serviceName exists but port is null
    expect(screen.getByRole('link', { name: /api :\?/ })).toHaveAttribute('href', '/services/9');
    // missing service -> dash
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // container fallback
    expect(screen.getByText('nd-app')).toBeInTheDocument();
    // status badge: the domain's own status
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
    expect(screen.getByText('deploying')).toBeInTheDocument();
  });

  it('shows an unverified domain as pending even with HTTPS on (r345)', async () => {
    mockOf(api.domains.all).mockResolvedValue([
      { id: 4, hostname: 'claimed.example.org', path: '/', serviceId: 5, serviceName: 'app', port: 3000, container: 'nd-app', ssl: true, status: 'pending', certExpiresAt: null },
    ] as never);
    renderWithProviders(<Domains />);
    await screen.findByText('claimed.example.org');
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.queryByText('active')).not.toBeInTheDocument();
  });

  it('toggles ssl on click and invalidates the list', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.setSsl).mockResolvedValue({ id: 2, ssl: true } as never);
    renderWithProviders(<Domains />);
    const toggles = await screen.findAllByRole('switch');
    // second row has ssl false -> click toggles to true
    fireEvent.click(toggles[1]!);
    await waitFor(() => expect(api.domains.setSsl).toHaveBeenCalledWith(2, true));
    // first row has ssl true -> click toggles to false (disable branch)
    fireEvent.click(toggles[0]!);
    await waitFor(() => expect(api.domains.setSsl).toHaveBeenCalledWith(1, false));
  });

  it('surfaces ssl toggle failures', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.setSsl).mockRejectedValue(new Error('acme') as never);
    renderWithProviders(<Domains />);
    const toggles = await screen.findAllByRole('switch');
    fireEvent.click(toggles[1]!);
    await waitFor(() => expect(api.domains.setSsl).toHaveBeenCalledWith(2, true));
    await screen.findByText(/Could not update the SSL setting/);
  });

  it('adds a domain to the chosen service from the routing map', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.services.list).mockResolvedValue([{ id: 5, name: 'app' }, { id: 9, name: 'api' }] as never);
    mockOf(api.domains.create).mockResolvedValue({ id: 7, hostname: 'new.example.com', path: '/api', status: 'active', verification: null } as never);
    renderWithProviders(<Domains />);
    await screen.findByText('app.example.com');
    const add = screen.getByRole('button', { name: /^Add$/ });
    // No service chosen yet: nothing to attach the domain to.
    expect(add).toBeDisabled();
    await screen.findByRole('option', { name: 'api' });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: '9' } });
    // A pasted URL keeps its path.
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'https://New.example.com/api/' } });
    fireEvent.click(add);
    await waitFor(() => expect(api.domains.create).toHaveBeenCalledWith(9, { hostname: 'new.example.com', path: '/api' }));
  });

  it('shows the TXT challenge for a pending add and generates the automatic URL', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.services.list).mockResolvedValue([{ id: 5, name: 'app' }] as never);
    mockOf(api.domains.create).mockResolvedValue({
      id: 8, hostname: 'theirs.org', path: '/', status: 'pending',
      verification: { recordName: '_ninedeploy-challenge.theirs.org', recordType: 'TXT', recordValue: 'tok-123' },
    } as never);
    mockOf(api.domains.generate).mockResolvedValue({ id: 9, hostname: 'app.1-2-3-4.sslip.io', created: true } as never);
    renderWithProviders(<Domains />);
    await screen.findByRole('option', { name: 'app' });
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'theirs.org' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText('tok-123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Generate URL/ }));
    await waitFor(() => expect(api.domains.generate).toHaveBeenCalledWith(5));
  });

  it('removes a domain after confirmation', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Domains />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove app.example.com' }));
    // A row without a service has no actions.
    expect(screen.queryByRole('button', { name: 'Remove blog.example.com' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));
    await waitFor(() => expect(api.domains.remove).toHaveBeenCalledWith(5, 1));
  });

  it('reports a refused domain removal while retaining the routing row', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.remove).mockRejectedValue(new Error('Domain is protected') as never);
    renderWithProviders(<Domains />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove app.example.com' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));
    expect(await screen.findByText('Domain is protected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'app.example.com' })).toHaveAttribute('href', 'https://app.example.com');
  });

  it('offers a retry when loading the selected domain fails', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.list).mockRejectedValue(new Error('Domain lookup failed') as never);
    renderWithProviders(<Domains />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit app.example.com' }));
    expect(await screen.findByText("Couldn't load this domain")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.domains.list).toHaveBeenCalledTimes(2));
    expect(api.domains.create).not.toHaveBeenCalled();
    expect(api.domains.remove).not.toHaveBeenCalled();
  });

  it('changes a hostname by adding the new one with the same settings, then removing the old', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.list).mockResolvedValue([
      { id: 1, serviceId: 5, hostname: 'app.example.com', path: '/', ssl: true, redirectWww: true, headers: '[]', basicAuth: null, ipAllowlist: '10.0.0.0/8', rateLimitAverage: 5, rateLimitBurst: 10, redirects: [], status: 'active' },
    ] as never);
    mockOf(api.domains.create).mockResolvedValue({ id: 11, hostname: 'shop.example.com', path: '/', status: 'active', verification: null } as never);
    mockOf(api.domains.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Domains />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit app.example.com' }));
    const host = await screen.findByLabelText('New hostname');
    fireEvent.change(host, { target: { value: 'shop.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.domains.create).toHaveBeenCalledWith(5, {
        hostname: 'shop.example.com', path: '/', ssl: true, redirectWww: true,
        basicAuth: null, ipAllowlist: '10.0.0.0/8', rateLimitAverage: 5, rateLimitBurst: 10,
      }),
    );
    await waitFor(() => expect(api.domains.remove).toHaveBeenCalledWith(5, 1));
  });

  it('keeps the old hostname routing while its replacement is pending', async () => {
    mockOf(api.domains.all).mockResolvedValue(domains as never);
    mockOf(api.domains.list).mockResolvedValue([
      { id: 1, serviceId: 5, hostname: 'app.example.com', path: '/', ssl: true, redirectWww: false, headers: '[]', status: 'active' },
    ] as never);
    mockOf(api.domains.create).mockResolvedValue({
      id: 12, hostname: 'theirs.org', path: '/', status: 'pending',
      verification: { recordName: '_ninedeploy-challenge.theirs.org', recordType: 'TXT', recordValue: 'tok' },
    } as never);
    renderWithProviders(<Domains />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit app.example.com' }));
    fireEvent.change(await screen.findByLabelText('New hostname'), { target: { value: 'theirs.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/keeps routing until you verify/);
    expect(api.domains.remove).not.toHaveBeenCalled();
  });

  it('shows an error card with retry when the domains query fails', async () => {
    mockOf(api.domains.all).mockRejectedValue(new Error('no dns') as never);
    renderWithProviders(<Domains />);
    expect(await screen.findByText("Couldn't load domains")).toBeInTheDocument();
    expect(screen.getByText('no dns')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.domains.all).toHaveBeenCalledTimes(2));
  });
});
