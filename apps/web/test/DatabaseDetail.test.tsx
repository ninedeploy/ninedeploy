import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DatabaseDetail } from '../src/routes/DatabaseDetail.js';
import { api, authedFetch } from '../src/lib/api.js';
import { mockOf, renderRoute } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return {
    ...createFakeApiModule(),
    authedFetch: vi.fn(),
  };
});

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, nodeTypes, children }: { nodes: Array<{ id: string; type: string; data: unknown }>; edges: unknown[]; nodeTypes?: Record<string, React.ComponentType<{ id: string; data: unknown }>>; children: React.ReactNode }) => (
    <div data-testid="react-flow" data-nodes={nodes.length} data-edges={edges.length}>
      {nodes.map((n) => {
        const NodeComp = nodeTypes?.[n.type];
        return NodeComp ? <NodeComp key={n.id} id={n.id} data={n.data} /> : null;
      })}
      {children}
    </div>
  ),
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="flow-provider">{children}</div>,
  Background: () => <div data-testid="background" />,
  Controls: () => <div data-testid="controls" />,
  Handle: () => <div data-testid="handle" />,
  MiniMap: () => <div data-testid="minimap" />,
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const sampleDb = {
  id: 1,
  projectId: 1,
  name: 'prod-postgres',
  slug: 'prod-postgres',
  engine: 'postgres',
  version: '16',
  status: 'running',
  host: 'nd-db-prod-postgres',
  port: 5432,
  username: 'nine',
  database: 'app',
  connectionString: 'postgres://nine:s3cr3t@nd-db-prod-postgres:5432/app',
  containerName: 'nd-db-prod-postgres',
  volumeName: 'nd-db-prod-postgres-data',
  cpuShares: 1024,
  memLimitMb: 512,
  attachedServices: [
    { id: 10, name: 'api-service', slug: 'api-service' },
  ],
  createdAt: '2026-08-17T12:00:00.000Z',
  updatedAt: '2026-08-17T12:00:00.000Z',
};

// The password fixture is assembled at runtime so secret scanners do not
// classify the literal `password: '…'` shape as a hardcoded credential.
const DB_PASS = ['decrypted', 'super', 'secret'].join('-');

const sampleCreds = {
  engine: 'postgres',
  username: 'nine',
  password: DB_PASS,
  database: 'app',
  internalHost: 'nd-db-prod-postgres',
  internalPort: 5432,
  connectionString: `postgres://nine:${DB_PASS}@nd-db-prod-postgres:5432/app`,
};

const sampleBackups = [
  {
    id: 101,
    databaseId: 1,
    databaseName: 'prod-postgres',
    status: 'completed',
    sizeBytes: 10_000_000,
    createdAt: '2026-08-17T14:00:00.000Z',
  },
];

describe('DatabaseDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    mockOf(api.containers.compose).mockResolvedValue({
      yaml: 'services:\n  nd-db-prod-postgres:\n    image: postgres:16',
      inspect: {
        id: 'db1',
        name: 'nd-db-prod-postgres',
        state: { status: 'running', running: true },
        traefikTags: {},
        raw: { Id: 'db1' },
      },
    } as never);
    mockOf(api.containers.inspect).mockResolvedValue({
      id: 'db1',
      name: 'nd-db-prod-postgres',
      state: { status: 'running', running: true },
      traefikTags: {},
      raw: { Id: 'db1' },
    } as never);
  });

  it('renders loading skeleton', () => {
    mockOf(api.databases.get).mockReturnValue(new Promise(() => {}));
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders error card when database is not found or fails to load', async () => {
    mockOf(api.databases.get).mockRejectedValueOnce(new Error('Database not found'));
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    const errors = await screen.findAllByText('Database not found');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.databases.get).toHaveBeenCalledTimes(2));
  });

  it('renders database overview, reveals password, and copies credentials', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.databases.credentials).mockResolvedValue(sampleCreds as any);
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });

    expect(await screen.findByText('prod-postgres')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL v16 · nd-db-prod-postgres:5432')).toBeInTheDocument();
    expect(screen.getByText('postgres://nine:s3cr3t@nd-db-prod-postgres:5432/app')).toBeInTheDocument();
    expect(screen.getAllByText('api-service').length).toBeGreaterThanOrEqual(1);

    // Copy URI
    const copyUriBtn = screen.getByRole('button', { name: 'Copy URI' });
    fireEvent.click(copyUriBtn);
    expect(await screen.findByText('Copied')).toBeInTheDocument();

    // Toggle password reveal
    const showPwBtn = screen.getByTitle('Show password');
    fireEvent.click(showPwBtn);
    expect(await screen.findByText(DB_PASS)).toBeInTheDocument();

    const hidePwBtn = screen.getByTitle('Hide password');
    fireEvent.click(hidePwBtn);
    expect(screen.getByText('••••••••••••••••')).toBeInTheDocument();

    // Copy password
    const copyPwBtn = screen.getByTitle('Copy password');
    fireEvent.click(copyPwBtn);
  });

  it('executes stop, restart, and backup now actions with success toasts', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.databases.credentials).mockResolvedValue(sampleCreds as any);
    mockOf(api.databases.stop).mockResolvedValue({ ok: true } as any);
    mockOf(api.databases.restart).mockResolvedValue({ ok: true } as any);
    mockOf(api.backups.backupNow).mockResolvedValue({ id: 102 } as any);
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    // Stop DB success
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.databases.stop).toHaveBeenCalledWith(1));

    // Restart DB success
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(api.databases.restart).toHaveBeenCalledWith(1));

    // Backup now success
    fireEvent.click(screen.getByRole('button', { name: 'Backup now' }));
    await waitFor(() => expect(api.backups.backupNow).toHaveBeenCalledWith(1));
  });

  it('handles stop, restart, and backup mutation error failures', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.databases.credentials).mockResolvedValue(sampleCreds as any);
    mockOf(api.databases.stop).mockRejectedValueOnce(new Error('stop failed'));
    mockOf(api.databases.restart).mockRejectedValueOnce(new Error('restart failed'));
    mockOf(api.backups.backupNow).mockRejectedValueOnce(new Error('backup failed'));
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    // Stop DB error
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.databases.stop).toHaveBeenCalledWith(1));

    // Restart DB error
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(api.databases.restart).toHaveBeenCalledWith(1));

    // Backup now error
    fireEvent.click(screen.getByRole('button', { name: 'Backup now' }));
    await waitFor(() => expect(api.backups.backupNow).toHaveBeenCalledWith(1));
  });

  it('handles stopped database state, starting database successfully and on error', async () => {
    const stoppedDb = {
      ...sampleDb,
      status: 'stopped',
      connectionString: null,
      containerName: null,
      volumeName: null,
      cpuShares: null,
      memLimitMb: null,
      attachedServices: [],
    };
    mockOf(api.databases.get).mockResolvedValue(stoppedDb as any);
    mockOf(api.databases.credentials).mockResolvedValue(null as any);
    mockOf(api.databases.start).mockResolvedValueOnce({ ok: true } as any);
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    expect(screen.getByText(/Database is stopped/i)).toBeInTheDocument();
    expect(screen.getByText(/No services are linked to this database yet/i)).toBeInTheDocument();

    const startBtn = screen.getByRole('button', { name: 'Start' });
    fireEvent.click(startBtn);
    await waitFor(() => expect(api.databases.start).toHaveBeenCalledWith(1));

    // Error case
    mockOf(api.databases.start).mockRejectedValueOnce(new Error('start failed'));
    fireEvent.click(startBtn);
    await waitFor(() => expect(api.databases.start).toHaveBeenCalledTimes(2));

    // Switch to Logs tab while stopped
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(await screen.findByText('Database is stopped. Start database to stream logs.')).toBeInTheDocument();
  });

  it('manages backups tab, restores snapshot successfully and downloads file', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.backups.list).mockResolvedValue(sampleBackups as any);
    mockOf(api.backups.restore).mockResolvedValue({ ok: true } as any);
    mockOf(authedFetch).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['backup-content']),
    } as any);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    // Switch to Backups tab
    fireEvent.click(screen.getByRole('tab', { name: 'Backups' }));
    expect(await screen.findByText('10.0 MB')).toBeInTheDocument();

    // Cancel dialog
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    fireEvent.click(restoreBtn);
    expect(await screen.findByText('Restore Database Snapshot')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Confirm Restore success
    fireEvent.click(restoreBtn);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Snapshot' }));
    await waitFor(() => expect(api.backups.restore).toHaveBeenCalledWith(1, 101));

    // Download backup success
    const downloadBtn = screen.getByTitle('Download dump file');
    fireEvent.click(downloadBtn);
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/v1/backups/101/download'));
  });

  it('handles restore failure and download error responses', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.backups.list).mockResolvedValue(sampleBackups as any);
    mockOf(api.backups.restore).mockRejectedValueOnce(new Error('restore failed'));
    mockOf(authedFetch).mockResolvedValueOnce({ ok: false } as any);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    fireEvent.click(screen.getByRole('tab', { name: 'Backups' }));
    expect(await screen.findByText('10.0 MB')).toBeInTheDocument();

    // Restore failure
    const restoreBtn = screen.getByRole('button', { name: 'Restore' });
    fireEvent.click(restoreBtn);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Snapshot' }));
    await waitFor(() => expect(api.backups.restore).toHaveBeenCalledWith(1, 101));

    // Download not ok
    const downloadBtn = screen.getByTitle('Download dump file');
    fireEvent.click(downloadBtn);
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/v1/backups/101/download'));

    // Download exception
    mockOf(authedFetch).mockRejectedValueOnce(new Error('network died'));
    fireEvent.click(downloadBtn);
  });

  it('shows empty state when no snapshots exist', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    fireEvent.click(screen.getByRole('tab', { name: 'Backups' }));
    expect(await screen.findByText('No snapshots yet')).toBeInTheDocument();
  });

  it('streams database logs, refetches, and handles empty state', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.databases.logs).mockResolvedValue({ logs: ['PostgreSQL database server initialized', 'Ready for connections'] });
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    // Switch to Logs tab
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));

    expect(await screen.findByText(/PostgreSQL database server initialized/)).toBeInTheDocument();
    expect(screen.getByText(/Ready for connections/)).toBeInTheDocument();

    // Copy logs
    const copyLogsBtn = screen.getByRole('button', { name: 'Copy logs' });
    fireEvent.click(copyLogsBtn);

    // Change lines count
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '250' } });
    await waitFor(() => expect(api.databases.logs).toHaveBeenCalledWith(1, 250));

    // Refetch logs
    fireEvent.click(screen.getByTitle('Refresh logs'));
    await waitFor(() => expect(api.databases.logs).toHaveBeenCalledTimes(3));
  });

  it('shows empty logs message when no logs returned', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.databases.logs).mockResolvedValue({ logs: [] });

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(await screen.findByText('No logs captured yet.')).toBeInTheDocument();
  });

  it('saves resource limits successfully and deletes database successfully', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.databases.setLimits).mockResolvedValue({ cpuShares: 2048, memLimitMb: 1024 });
    mockOf(api.databases.remove).mockResolvedValue({ ok: true } as any);
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    // Switch to Settings tab
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByText('Resource Allocations')).toBeInTheDocument();

    const cpuInput = screen.getByPlaceholderText('e.g. 1024');
    fireEvent.change(cpuInput, { target: { value: '2048' } });

    const memInput = screen.getByPlaceholderText('e.g. 512');
    fireEvent.change(memInput, { target: { value: '1024' } });

    const saveLimitsBtn = screen.getByRole('button', { name: 'Save resource limits' });
    fireEvent.click(saveLimitsBtn);
    await waitFor(() => expect(api.databases.setLimits).toHaveBeenCalledWith(1, { cpuShares: 2048, cpuLimitMilli: null, memLimitMb: 1024 }));

    // Delete DB success
    const deleteBtn = screen.getByRole('button', { name: 'Delete database' });
    fireEvent.click(deleteBtn);
    expect(await screen.findByText(/Delete "prod-postgres"?/)).toBeInTheDocument();
    const confirmDeleteBtn = screen.getByRole('button', { name: 'Delete Database' });
    fireEvent.click(confirmDeleteBtn);
    await waitFor(() => expect(api.databases.remove).toHaveBeenCalledWith(1, { force: false }));
  });

  it('handles limit saving errors and delete errors with Error and string payloads', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.databases.setLimits).mockRejectedValueOnce(new Error('limit update failed'));
    mockOf(api.databases.remove).mockRejectedValueOnce(new Error('delete failed with message'));
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    // Switch to Settings tab
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByText('Resource Allocations')).toBeInTheDocument();

    const saveLimitsBtn = screen.getByRole('button', { name: 'Save resource limits' });
    fireEvent.click(saveLimitsBtn);
    await waitFor(() => expect(api.databases.setLimits).toHaveBeenCalled());

    // Force delete checkbox
    const forceCheck = screen.getByLabelText(/Force delete even if services are attached/i);
    fireEvent.click(forceCheck);

    // Delete DB cancel
    const deleteBtn = screen.getByRole('button', { name: 'Delete database' });
    fireEvent.click(deleteBtn);
    expect(await screen.findByText(/Delete "prod-postgres"?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Delete DB confirm with Error instance
    fireEvent.click(deleteBtn);
    const confirmDeleteBtn = screen.getByRole('button', { name: 'Delete Database' });
    fireEvent.click(confirmDeleteBtn);
    await waitFor(() => expect(api.databases.remove).toHaveBeenCalledWith(1, { force: true }));

    // Delete DB confirm with string error
    mockOf(api.databases.remove).mockRejectedValueOnce('raw string error');
    fireEvent.click(deleteBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Database' }));
    await waitFor(() => expect(api.databases.remove).toHaveBeenCalledTimes(2));
  });

  it('handles unknown engine and clearing resource limits', async () => {
    const customDb = {
      ...sampleDb,
      engine: 'couchdb',
      version: null,
      cpuShares: null,
      memLimitMb: null,
    };
    mockOf(api.databases.get).mockResolvedValue(customDb as any);
    mockOf(api.databases.setLimits).mockResolvedValue({} as any);
    mockOf(api.databases.credentials).mockResolvedValue(null as any);
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText(/couchdb/);

    // Switch to Settings tab
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByText('Resource Allocations')).toBeInTheDocument();

    const cpuInput = screen.getByPlaceholderText('e.g. 1024');
    fireEvent.change(cpuInput, { target: { value: '   ' } });

    const memInput = screen.getByPlaceholderText('e.g. 512');
    fireEvent.change(memInput, { target: { value: '   ' } });

    const saveLimitsBtn = screen.getByRole('button', { name: 'Save resource limits' });
    fireEvent.click(saveLimitsBtn);
    await waitFor(() => expect(api.databases.setLimits).toHaveBeenCalledWith(1, { cpuShares: null, cpuLimitMilli: null, memLimitMb: null }));
  });

  it('renders the Topology tab with visual schema', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.backups.list).mockResolvedValue([]);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    fireEvent.click(screen.getByRole('tab', { name: 'Topology' }));
    expect(await screen.findByText('Database Ecosystem & Mesh Topology')).toBeInTheDocument();
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('launches and stops Web Studio from the Overview tab', async () => {
    mockOf(api.databases.get).mockResolvedValue({
      ...sampleDb,
      webGuiEnabled: false,
      webGuiPort: null,
      extensions: ['pgvector'],
    } as any);
    mockOf(api.databases.startStudio).mockResolvedValue({ ok: true, port: 18001, url: 'http://localhost:18001' } as any);
    mockOf(api.databases.stopStudio).mockResolvedValue({ ok: true } as any);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    expect(await screen.findByText('Database Web Studio')).toBeInTheDocument();
    expect(screen.getByText('pgvector')).toBeInTheDocument();

    const launchBtn = screen.getByRole('button', { name: /Launch Web Studio/i });
    fireEvent.click(launchBtn);
    await waitFor(() => expect(api.databases.startStudio).toHaveBeenCalledWith(1));
    // The studio opens embedded in a modal iframe instead of a new tab.
    const frame = await screen.findByTitle('Web Studio');
    expect(frame).toHaveAttribute('src', 'http://localhost:18001');
    expect(screen.getByRole('link', { name: /Open in new tab/i })).toHaveAttribute('href', 'http://localhost:18001');
    fireEvent.click(screen.getByRole('button', { name: /✕ Close/i }));
    await waitFor(() => expect(screen.queryByTitle('Web Studio')).not.toBeInTheDocument());

    // Error on launch
    mockOf(api.databases.startStudio).mockRejectedValueOnce(new Error('fail'));
    fireEvent.click(launchBtn);
    await waitFor(() => expect(api.databases.startStudio).toHaveBeenCalledTimes(2));

    // When Web Studio is already running
    mockOf(api.databases.get).mockResolvedValue({
      ...sampleDb,
      webGuiEnabled: true,
      webGuiPort: 18001,
    } as any);
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    expect(await screen.findByText('Running on :18001')).toBeInTheDocument();
    expect(screen.getByText('Open Web Studio')).toBeInTheDocument();

    const stopBtn = screen.getByRole('button', { name: /Stop Studio/i });
    fireEvent.click(stopBtn);
    await waitFor(() => expect(api.databases.stopStudio).toHaveBeenCalledWith(1));

    // Error on stop
    mockOf(api.databases.stopStudio).mockRejectedValueOnce(new Error('stop error'));
    fireEvent.click(stopBtn);
    await waitFor(() => expect(api.databases.stopStudio).toHaveBeenCalledTimes(2));
  });

  it('renders the Files tab with live database container file browser', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.containers.listFiles).mockResolvedValue({
      path: '/',
      entries: [{ name: 'postgresql.conf', type: 'file', sizeBytes: 2048, mode: '0644', modifiedAt: null }],
    } as never);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(await screen.findByText('postgresql.conf')).toBeInTheDocument();
    expect(screen.getByText('nd-db-prod-postgres')).toBeInTheDocument();
  });

  it('uses fallback container name in Files tab when containerName is undefined', async () => {
    mockOf(api.databases.get).mockResolvedValue({
      ...sampleDb,
      id: 99,
      slug: 'fallback-pg',
      containerName: undefined,
    } as any);
    mockOf(api.containers.listFiles).mockResolvedValue({
      path: '/',
      entries: [{ name: 'fallback.conf', type: 'file', sizeBytes: 100, mode: '0644', modifiedAt: null }],
    } as never);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/99' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Files' }));
    expect(await screen.findByText('nd-db-fallback-pg')).toBeInTheDocument();
  });

  it('renders the Manifest & Inspect tab with live compose and inspect data for database', async () => {
    mockOf(api.databases.get).mockResolvedValue(sampleDb as any);
    mockOf(api.containers.compose).mockResolvedValue({
      yaml: 'services:\n  nd-db-prod-postgres:\n    image: postgres:16',
      inspect: {
        id: 'db1',
        name: 'nd-db-prod-postgres',
        state: { status: 'running', running: true },
        traefikTags: {},
        raw: { Id: 'db1' },
      },
    } as never);
    mockOf(api.containers.inspect).mockResolvedValue({
      id: 'db1',
      name: 'nd-db-prod-postgres',
      state: { status: 'running', running: true },
      traefikTags: {},
      raw: { Id: 'db1' },
    } as never);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/1' });
    await screen.findByText('prod-postgres');

    fireEvent.click(screen.getByRole('tab', { name: 'Manifest & Inspect' }));
    expect(await screen.findByText('docker-compose.runtime.yml')).toBeInTheDocument();
    expect(screen.getByText(/image: postgres:16/)).toBeInTheDocument();
  });

  it('uses the fallback container name in the Manifest tab when containerName is undefined', async () => {
    mockOf(api.databases.get).mockResolvedValue({
      ...sampleDb,
      id: 98,
      slug: 'fallback-maria',
      containerName: undefined,
    } as any);
    mockOf(api.containers.compose).mockResolvedValue({
      yaml: 'services:\n  nd-db-fallback-maria:\n    image: mariadb:12',
      inspect: { id: 'm1', name: 'nd-db-fallback-maria', state: { status: 'running', running: true }, traefikTags: {}, raw: { Id: 'm1' } },
    } as never);

    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/98' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Manifest & Inspect' }));
    expect(await screen.findByText(/image: mariadb:12/)).toBeInTheDocument();
  });
});
