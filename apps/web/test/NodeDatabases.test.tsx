import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { DatabaseWizard } from '../src/components/DatabaseWizard.js';
import { Databases } from '../src/routes/Databases.js';
import { DatabaseDetail } from '../src/routes/DatabaseDetail.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderRoute, renderWithProviders } from './helpers.js';

/**
 * Multi-node databases: the wizard's host select (panel host, or nodes whose
 * agent can host databases), the node badge with the reachability state on
 * the list and the detail page, and the Studio / PgBouncer / public-access
 * cards shown disabled with the reason for a node database.
 */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/lib/mode.js', async () => (await import('./apiMock.js')).createModeMock());

const authState = vi.hoisted(() => ({ user: { id: 1, isOperator: true } as { id: number; isOperator: boolean } }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: authState.user, loading: false })),
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: () => <div data-testid="react-flow" />,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const DB_FEATURES = { nixpacks: true, railpack: true, privateClones: true, volumes: true, databases: true, imageTransfer: true, swarm: true };
const NODES = [
  { id: 3, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: null, features: DB_FEATURES },
  { id: 4, name: 'edge-2', host: '10.0.0.6', port: 4600, status: 'offline', lastSeenAt: null, features: DB_FEATURES },
  { id: 5, name: 'edge-old', host: '10.0.0.7', port: 4600, status: 'online', lastSeenAt: null, features: { ...DB_FEATURES, databases: false } },
  { id: 6, name: 'edge-legacy', host: '10.0.0.8', port: 4600, status: 'online', lastSeenAt: null },
];

async function toDetails() {
  fireEvent.click(screen.getByText('PostgreSQL'));
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
  fireEvent.change(await screen.findByPlaceholderText('my-database'), { target: { value: 'orders' } });
}

describe('DatabaseWizard — host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, isOperator: true };
    mockOf(api.servers.list).mockResolvedValue(NODES as never);
    mockOf(api.volumes.list).mockResolvedValue([{ name: 'nd-db-old-data', sizeBytes: 10, owner: null, inUse: false }] as never);
    mockOf(api.databases.create).mockResolvedValue({ id: 9 } as never);
  });

  it('offers the panel host and the nodes whose agent can host databases, and creates on the chosen node', async () => {
    const onClose = vi.fn();
    renderWithProviders(<DatabaseWizard onClose={onClose} />);
    await toDetails();
    const host = await screen.findByLabelText('Database host');
    expect(within(host).getAllByRole('option').map((o) => o.textContent)).toEqual(['Panel host', 'edge-1', 'edge-2 — offline']);
    // Panel host: the retained volume can be re-attached.
    expect(screen.getByText(/Re-attach retained volume/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Re-attach retained volume/));
    fireEvent.change(host, { target: { value: '3' } });
    expect(screen.getByText(/stays on this node for its whole life/)).toBeInTheDocument();
    expect(screen.queryByText(/Re-attach retained volume/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Host')).toBeInTheDocument();
    expect(screen.getByText('edge-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create database' }));
    await waitFor(() =>
      expect(api.databases.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'orders', engine: 'postgres', serverId: 3, existingVolume: undefined })),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('the panel host stays the default and sends no serverId', async () => {
    renderWithProviders(<DatabaseWizard onClose={vi.fn()} />);
    await toDetails();
    const host = await screen.findByLabelText('Database host');
    fireEvent.change(host, { target: { value: '3' } });
    fireEvent.change(host, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText('Panel host')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create database' }));
    await waitFor(() => expect(api.databases.create).toHaveBeenCalled());
    expect(mockOf(api.databases.create).mock.calls[0]![0]).not.toHaveProperty('serverId');
  });

  it('no host select without a database-capable node, and none for a member', async () => {
    mockOf(api.servers.list).mockResolvedValue([NODES[2], NODES[3]] as never);
    renderWithProviders(<DatabaseWizard onClose={vi.fn()} />);
    await toDetails();
    await waitFor(() => expect(api.servers.list).toHaveBeenCalled());
    expect(screen.queryByLabelText('Database host')).toBeNull();

    authState.user = { id: 2, isOperator: false };
    mockOf(api.servers.list).mockClear();
    renderWithProviders(<DatabaseWizard onClose={vi.fn()} />);
    expect(api.servers.list).not.toHaveBeenCalled();
  });
});

describe('Databases list — node badge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the node and its reachability; a panel-host database has no badge', async () => {
    mockOf(api.databases.list).mockResolvedValue([
      { id: 1, name: 'on-node', engine: 'postgres', version: '16', status: 'running', connectionString: null, serverId: 3, serverName: 'edge-1', reachable: true },
      { id: 2, name: 'lost', engine: 'redis', version: null, status: 'running', connectionString: null, serverId: 4, serverName: null, reachable: false },
      { id: 3, name: 'new', engine: 'redis', version: null, status: 'creating', connectionString: null, serverId: 5, serverName: 'edge-3', reachable: null },
      { id: 4, name: 'local', engine: 'mysql', version: null, status: 'stopped', connectionString: null, serverId: null, serverName: null, reachable: null },
    ] as never);
    renderWithProviders(<Databases />);
    expect(await screen.findByText('edge-1')).toBeInTheDocument();
    expect(screen.getByText('reachable')).toBeInTheDocument();
    expect(screen.getByText('node #4')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    expect(screen.getByText('not probed yet')).toBeInTheDocument();
    expect(screen.getAllByText(/reachable|not probed yet/)).toHaveLength(3);
  });
});

const nodeDb = {
  id: 7,
  projectId: null,
  name: 'orders',
  slug: 'orders',
  engine: 'postgres',
  version: '16',
  status: 'running',
  host: 'nd-db-orders',
  port: 5432,
  username: 'nine',
  database: 'app',
  connectionString: null,
  containerName: 'nd-db-orders',
  volumeName: 'nd-db-orders-data',
  attachedServices: [],
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
  serverId: 3,
  serverName: 'edge-1',
  reachable: false,
};

describe('DatabaseDetail — node database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.databases.get).mockResolvedValue(nodeDb as never);
    mockOf(api.databases.credentials).mockReturnValue(new Promise(() => {}) as never);
  });

  it('shows the node badge and a disabled Web Studio card with the reason', async () => {
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/7' });
    expect(await screen.findByText('edge-1')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
    const card = screen.getByTestId('node-unavailable');
    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(within(card).getByText('Database Web Studio')).toBeInTheDocument();
    expect(within(card).getByText(/Not available for a database on a node \(edge-1\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Launch Web Studio/ })).toBeNull();
  });

  it('settings: public access and PgBouncer are disabled with the reason, and the public-access status is never asked', async () => {
    mockOf(api.databases.get).mockResolvedValue({ ...nodeDb, serverName: null } as never);
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/7?tab=settings' });
    expect(await screen.findByText('Public access')).toBeInTheDocument();
    expect(screen.getByText('PgBouncer connection pooling')).toBeInTheDocument();
    expect(screen.getAllByText(/Not available for a database on a node \(node #3\)/)).toHaveLength(2);
    expect(api.databases.publicAccess.get).not.toHaveBeenCalled();
  });

  it('a panel-host database keeps the Studio and public-access cards', async () => {
    mockOf(api.databases.get).mockResolvedValue({ ...nodeDb, serverId: null, serverName: null, reachable: null } as never);
    renderRoute(<DatabaseDetail />, { path: '/databases/:id', route: '/databases/7' });
    expect(await screen.findByRole('button', { name: /Launch Web Studio/ })).toBeInTheDocument();
    expect(screen.queryByTestId('node-unavailable')).toBeNull();
  });
});
