import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MigrationDomainCutover } from '../src/components/MigrationDomainCutover.js';
import { MigrationReadiness } from '../src/components/MigrationReadiness.js';
import { api } from '../src/lib/api.js';
import type { PreparedImportService } from '../src/lib/prepareImportResources.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return { ...createFakeApiModule(), getApiSessionGeneration: () => 0 };
});

const pg = { id: 9, name: 'App DB', slug: 'app-db', engine: 'postgres' as const };
const prepared = (bindings: PreparedImportService['bindings'] = []): PreparedImportService => ({
  id: 41, name: 'Web', slug: 'web', bindings,
  service: {
    ref: 'web', name: 'Web', kind: 'image', create: { type: 'docker', name: 'Web', image: 'nginx' },
    domains: [], env: [{ key: 'API_KEY' }, { key: 'DATABASE_URL' }], volumes: [], issues: [],
  },
});
const connection = { alias: 'DATABASE_URL', databaseId: 9, slug: 'app-db', engine: 'postgres', running: true };
const snapshot = {
  id: 41, slug: 'web', type: 'docker' as const, status: 'idle' as const, hasSource: true,
  bindings: [] as Array<{ alias: string; databaseId: number; slug: string; engine: string; running: boolean }>,
  environmentKeys: [] as string[], managedDatabaseKeys: [] as string[], secretReferenceKeys: [] as string[],
  deploymentPending: false, databaseImportsPending: false, volumeImportsPending: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  // A queued answer must not leak from one test into the next.
  for (const method of [api.deploys.migrationReadiness, api.domains.cutoverCheck, api.domains.cutover]) mockOf(method).mockReset();
  mockOf(api.services.routing).mockReset().mockResolvedValue({ live: true, liveNote: null, container: null, http: [], ports: [] });
});

describe('MigrationReadiness', () => {
  it('reports a prepared resource that changed or was removed', async () => {
    mockOf(api.deploys.migrationReadiness).mockResolvedValue({ ...snapshot, slug: 'renamed' });
    renderWithProviders(<MigrationReadiness target={prepared()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check deployment readiness' }));
    expect(await screen.findByText('Previously prepared resource changed or was removed. Review the target.')).toBeVisible();
    expect(screen.queryByText('Configure a repository or image for this service.')).not.toBeInTheDocument();
  });

  it('lists everything the deployment still needs, one check at a time', async () => {
    const binding = { alias: 'DATABASE_URL', databaseName: 'App DB', database: pg };
    mockOf(api.deploys.migrationReadiness)
      .mockResolvedValueOnce({ ...snapshot, hasSource: false })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: [] })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: ['API_KEY'], bindings: [{ ...connection, databaseId: 99, slug: 'other' }], managedDatabaseKeys: ['DATABASE_URL'] })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: ['API_KEY'], volumeImportsPending: true })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: ['API_KEY'], databaseImportsPending: true })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: ['API_KEY'], deploymentPending: true })
      .mockResolvedValueOnce({ ...snapshot, environmentKeys: ['API_KEY'], status: 'deploying' });
    renderWithProviders(<MigrationReadiness target={prepared([binding])} />);
    const readiness = screen.getByRole('region', { name: 'Deployment readiness for Web' });
    const check = () => within(readiness).getByRole('button', { name: 'Check deployment readiness' });

    fireEvent.click(check());
    expect(await within(readiness).findByText('Configure a repository or image for this service.')).toBeVisible();
    fireEvent.click(check());
    expect(await within(readiness).findByText('Planned environment keys missing on the target')).toBeVisible();
    // Only the key that is not a planned connection is listed as missing.
    const missingKeys = within(readiness).getByText((_, element) => element?.tagName === 'LI' && (element.textContent ?? '').startsWith('Planned environment keys missing'));
    expect(missingKeys.querySelector('code')).toHaveTextContent(/^API_KEY$/);
    fireEvent.click(check());
    expect(await within(readiness).findByText('Planned database connections to review')).toBeVisible();
    expect(within(readiness).getByText('DATABASE_URL')).toBeVisible();
    fireEvent.click(check());
    expect(await within(readiness).findByText('Finish or cancel pending data imports before deploying.')).toBeVisible();
    fireEvent.click(check());
    expect(await within(readiness).findByText('Finish or cancel pending data imports before deploying.')).toBeVisible();
    fireEvent.click(check());
    expect(await within(readiness).findByText('A deployment is already queued, waiting or running.')).toBeVisible();
    fireEvent.click(check());
    expect(await within(readiness).findByText('A deployment is already queued, waiting or running.')).toBeVisible();
    expect(within(readiness).queryByRole('link', { name: 'Open deployments' })).not.toBeInTheDocument();
  });

  it('says when the check itself failed', async () => {
    mockOf(api.deploys.migrationReadiness).mockRejectedValue(new Error('panel unreachable'));
    renderWithProviders(<MigrationReadiness target={prepared()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check deployment readiness' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check deployment readiness. Try again.');
  });

  it('shows the latest transfer for planned targets while keeping empty targets deployable', async () => {
    const planned = { alias: 'DATABASE_URL', databaseName: 'App DB', database: pg };
    const target = prepared([planned, planned]);
    target.service.create.volumeMount = '/data';
    target.service.volumes = [{ mountPath: '/data', source: 'volume', name: 'app-data' }];
    const configured = { ...snapshot, environmentKeys: ['API_KEY'], managedDatabaseKeys: ['DATABASE_URL'] };
    mockOf(api.deploys.migrationReadiness).mockResolvedValueOnce({
      ...configured, primaryVolume: { mountPath: '/data', latestImportStatus: 'failed' },
      bindings: [
        { ...connection, latestImportStatus: null },
        { ...connection, alias: 'EXTRA_DATABASE', latestImportStatus: 'expired' },
      ],
    }).mockResolvedValueOnce({
      ...configured, primaryVolume: { mountPath: '/elsewhere', latestImportStatus: 'completed' },
      bindings: [{ ...connection, databaseId: 81, latestImportStatus: 'completed' }],
    });
    renderWithProviders(<MigrationReadiness target={target} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check deployment readiness' }));
    const transfers = within(await screen.findByRole('region', { name: 'Data transfer on the target' }));
    expect(transfers.getByText('DATABASE_URL')).toBeVisible();
    expect(transfers.getByText('No data import recorded.')).toBeVisible();
    expect(transfers.getByText('/data')).toBeVisible();
    expect(transfers.getByText('Failed')).toBeVisible();
    expect(transfers.queryByText('EXTRA_DATABASE')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open deployments' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check deployment readiness' }));
    await screen.findByText('Planned database connections to review');
    expect(screen.queryByRole('region', { name: 'Data transfer on the target' })).not.toBeInTheDocument();
  });

  it('opens the deployments of a service whose planned configuration is complete', async () => {
    const binding = { alias: 'DATABASE_URL', databaseName: 'App DB', database: pg };
    mockOf(api.deploys.migrationReadiness).mockResolvedValue({
      ...snapshot, environmentKeys: ['API_KEY'], bindings: [connection], managedDatabaseKeys: ['DATABASE_URL'], secretReferenceKeys: ['API_KEY', 'UNRELATED'],
    });
    renderWithProviders(<MigrationReadiness target={prepared([binding])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check deployment readiness' }));
    const readiness = screen.getByRole('region', { name: 'Deployment readiness for Web' });
    expect(await within(readiness).findByText('Planned configuration is ready for deployment.')).toBeVisible();
    expect(within(readiness).getByRole('link', { name: 'Open deployments' })).toHaveAttribute('href', '/services/41?tab=deploys');
    expect(within(readiness).getByText('Secret references are resolved during deployment.')).toBeVisible();
    await waitFor(() => expect(within(readiness).getByRole('button', { name: 'Check deployment readiness' })).toBeEnabled());
  });
});

describe('MigrationDomainCutover', () => {
  const host = 'shop.example.test';
  const renderCutover = () => {
    renderWithProviders(<MigrationDomainCutover serviceId={41} serviceName="Web" host={host} https={false} />);
    return screen.getByRole('region', { name: `Cutover for ${host}` });
  };

  it('lets the operator step back from a cutover before it is made', async () => {
    mockOf(api.domains.cutoverCheck).mockResolvedValue({ hostname: host, status: 'ready' });
    const cutover = renderCutover();
    expect(within(cutover).getByText('Web · HTTP')).toBeVisible();
    fireEvent.click(within(cutover).getByRole('button', { name: 'Check cutover' }));
    fireEvent.click(await within(cutover).findByRole('button', { name: 'Attach domain' }));
    expect(await within(cutover).findByText(`Confirm HTTP routing for ${host} to Web. DNS records are managed separately.`)).toBeVisible();
    fireEvent.click(within(cutover).getByRole('button', { name: 'Cancel' }));
    expect(await within(cutover).findByRole('button', { name: 'Check cutover' })).toBeVisible();
    expect(api.domains.cutover).not.toHaveBeenCalled();
  });

  it('shows why a check could not be completed', async () => {
    mockOf(api.domains.cutoverCheck).mockRejectedValue(new Error('The DNS lookup could not be run.'));
    const cutover = renderCutover();
    fireEvent.click(within(cutover).getByRole('button', { name: 'Check cutover' }));
    expect(await within(cutover).findByRole('alert')).toHaveTextContent('The DNS lookup could not be run.');
    expect(within(cutover).queryByRole('button', { name: 'Attach domain' })).not.toBeInTheDocument();
  });

  it('shows the protocol conflict without offering to attach or verify the existing route', async () => {
    mockOf(api.domains.cutoverCheck).mockResolvedValue({ hostname: host, status: 'route_conflict', existingSsl: true });
    const cutover = within(renderCutover());
    fireEvent.click(cutover.getByRole('button', { name: 'Check cutover' }));
    expect(await cutover.findByText('The existing route uses HTTPS. The plan requires HTTP. Review it in Domains.')).toBeVisible();
    expect(api.domains.cutoverCheck).toHaveBeenCalledWith(41, host, false);
    expect(cutover.queryByRole('button', { name: 'Attach domain' })).not.toBeInTheDocument();
    expect(cutover.queryByRole('button', { name: 'Verify ownership' })).not.toBeInTheDocument();
    expect(api.domains.cutover).not.toHaveBeenCalled();
  });

  it('keeps an attached route visible while showing DNS drift and recovery', async () => {
    mockOf(api.domains.cutoverCheck)
      .mockResolvedValueOnce({ hostname: host, status: 'active', dnsStatus: 'dns_mismatch',
        expected: ['203.0.113.5'], resolved: ['198.51.100.5'] })
      .mockResolvedValueOnce({ hostname: host, status: 'active', dnsStatus: 'ready',
        expected: ['203.0.113.5'], resolved: ['203.0.113.5'] });
    const cutover = within(renderCutover());
    const check = cutover.getByRole('button', { name: 'Check cutover' });
    fireEvent.click(check);
    expect(await cutover.findByText('At least one DNS address differs from the configured destination.')).toBeVisible();
    expect(cutover.getByText('Domain is attached.')).toBeVisible();
    expect(cutover.getByText('198.51.100.5')).toBeVisible();
    expect(cutover.queryByRole('button', { name: 'Attach domain' })).not.toBeInTheDocument();
    fireEvent.click(check);
    expect(await cutover.findByText('DNS addresses match the configured destination.')).toBeVisible();
    expect(cutover.queryByText('198.51.100.5')).not.toBeInTheDocument();
    expect(api.domains.cutover).not.toHaveBeenCalled();
  });

  it('checks the matching root route and keeps attachment and DNS results if the view fails', async () => {
    mockOf(api.domains.cutoverCheck).mockResolvedValue({ hostname: host, status: 'active', dnsStatus: 'ready' });
    const view = { live: true, liveNote: null, container: null, ports: [] };
    const route = { domainId: 3, hostname: host, path: '/', ssl: false, router: 'web_3', upstreams: [], note: '', verdict: 'ok' as const };
    mockOf(api.services.routing)
      .mockResolvedValueOnce({ ...view, http: [{ ...route, ssl: true }, { ...route, path: '/other' },
        { ...route, verdict: 'error', note: 'The router has no upstream' }] })
      .mockRejectedValueOnce(new Error('routing unavailable'))
      .mockResolvedValueOnce({ ...view, http: [route] });
    const cutover = within(renderCutover());
    const check = cutover.getByRole('button', { name: 'Check cutover' });
    expect(api.services.routing).not.toHaveBeenCalled();
    fireEvent.click(check);
    expect(await cutover.findByText('The proxy reports a routing problem.')).toBeVisible();
    expect(cutover.getByText('The router has no upstream')).toBeVisible();
    fireEvent.click(check);
    expect(await cutover.findByText('Could not verify the proxy configuration.')).toBeVisible();
    expect(cutover.getByText('Domain is attached.')).toBeVisible();
    expect(cutover.getByText('DNS addresses match the configured destination.')).toBeVisible();
    fireEvent.click(check);
    expect(await cutover.findByText('The proxy configuration has a matching route.')).toBeVisible();
    expect(cutover.getByRole('link', { name: 'Open routing details' })).toHaveAttribute('href', '/services/41?tab=network');
    expect(api.services.routing).toHaveBeenLastCalledWith(41);
    expect(api.domains.cutover).not.toHaveBeenCalled();
  });
});
