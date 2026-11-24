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
});
