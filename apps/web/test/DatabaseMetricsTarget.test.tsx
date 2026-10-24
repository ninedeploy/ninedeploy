import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DatabaseDetail } from '../src/routes/DatabaseDetail.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderRoute } from './helpers.js';
vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());
vi.mock('../src/lib/auth.js', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>, useAuth: () => ({ user: { id: 7, isOperator: false }, loading: false }) }));
const database = { id: 13, projectId: null, name: 'orders', slug: 'orders', engine: 'postgres', version: '18', status: 'running', serverId: 8, host: 'nd-db-orders', port: 5432, username: 'nine', database: 'app', connectionString: null, containerName: 'nd-db-orders', volumeName: 'nd-db-orders-data', cpuShares: 0, memLimitMb: 0, webGuiEnabled: false, webGuiPort: null, attachedServices: [], extensions: [] };
beforeEach(() => { vi.clearAllMocks(); mockOf(api.databases.get).mockResolvedValue(database as never); mockOf(api.databases.credentials).mockResolvedValue({} as never); });
describe('database metrics target and unavailable states', () => {
  it('offers a real snapshot retry after an HTTP error and then shows its fresh sample', async () => {
    mockOf(api.stats.snapshot).mockRejectedValueOnce(Error('temporarily offline')).mockResolvedValue({ host: null, resource: { kind: 'database', id: 13, serverId: 8, state: 'live', sampledAt: Date.now() }, containers: [{ name: 'nd-db-orders', kind: 'database', refId: 13, refName: 'orders', cpuPct: 0, memMb: 0, memLimitMb: 0 }] });
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/13' });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry metrics' }));
    expect(await screen.findByText('0.0%')).toBeInTheDocument(); expect(api.stats.snapshot).toHaveBeenCalledTimes(2);
  });
  it('requests a resource-scoped snapshot and shows only its fresh sample', async () => {
    mockOf(api.stats.snapshot).mockResolvedValue({ host: null, resource: { kind: 'database', id: 13, serverId: 8, state: 'live', sampledAt: Date.now() }, containers: [{ name: 'nd-db-orders', kind: 'database', refId: 13, refName: 'orders', cpuPct: 12.5, memMb: 4, memLimitMb: 0 }] });
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/13' });
    expect(await screen.findByText('12.5%')).toBeInTheDocument();
    await waitFor(() => expect(api.stats.snapshot).toHaveBeenCalledWith({ databaseId: 13 }));
  });
  it.each(['pending', 'unavailable', 'stale'] as const)('does not label %s metrics as live or tell a running database to start', async state => {
    mockOf(api.stats.snapshot).mockResolvedValue({ host: null, containers: [], resource: { kind: 'database', id: 13, serverId: 8, state, sampledAt: null } });
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/13' });
    const heading = await screen.findByText('Live Resources');
    await waitFor(() => expect(within(heading.parentElement!).queryByText(/^live$/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/start the database to see/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Database is stopped/)).not.toBeInTheDocument();
  });
});
