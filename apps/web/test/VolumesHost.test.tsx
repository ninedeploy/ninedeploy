import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Volumes } from '../src/routes/Volumes.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/**
 * Multi-node, Volumes page: the host switcher lists a node's managed volumes
 * through its agent (`?serverId=`), deletes and creates there, and hides the
 * panel-host-only actions (file browser, snapshots, prune). With no node
 * registered the page is exactly the 0.15 inventory.
 */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useAuth: vi.fn(() => ({ user: { id: 1, isOperator: true }, loading: false })),
}));

const NODES = [
  { id: 3, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', lastSeenAt: null, features: { volumes: true } },
  { id: 4, name: 'edge-old', host: '10.0.0.6', port: 4600, status: 'online', lastSeenAt: null, features: { volumes: false } },
  { id: 5, name: 'edge-down', host: '10.0.0.7', port: 4600, status: 'offline', lastSeenAt: null },
  { id: 6, name: 'announced', host: '10.0.0.8', port: 4600, status: 'pending', lastSeenAt: null },
];

const panelVolumes = [{ name: 'nd-old', sizeBytes: 100, owner: null, inUse: false }];
const nodeVolumes = [{ name: 'nd-svc-api-data', sizeBytes: 2048, owner: null, inUse: false, serverId: 3 }];

describe('Volumes — host switcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.servers.list).mockResolvedValue(NODES as never);
    mockOf(api.volumes.list).mockImplementation((async (opts?: { serverId?: number }) => (opts?.serverId ? nodeVolumes : panelVolumes)) as never);
    mockOf(api.system.resources).mockResolvedValue({ network: 'nd', containers: 1, volumes: 1, imagesSummary: null } as never);
  });

  it('lists the panel host by default, then a node through its agent', async () => {
    renderWithProviders(<Volumes />);
    const host = await screen.findByLabelText('Volume host');
    expect(api.volumes.list).toHaveBeenCalledWith();
    const options = within(host).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Panel host', 'edge-1', 'edge-old (update the agent)', 'edge-down — offline']);
    expect(within(host).getByText('edge-old (update the agent)')).toBeDisabled();
    expect(await screen.findByLabelText('Snapshots for nd-old')).toBeInTheDocument();

    fireEvent.change(host, { target: { value: '3' } });
    await waitFor(() => expect(api.volumes.list).toHaveBeenCalledWith({ serverId: 3 }));
    expect(await screen.findByText(/Volumes on/)).toHaveTextContent('Volumes on edge-1, through its agent.');
    // Node volumes: no file browser, no snapshots, no prune.
    expect(screen.queryByTitle('Browse files in this volume')).toBeNull();
    expect(screen.queryByLabelText(/Snapshots for/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Prune retained/ })).toBeNull();

    fireEvent.click(screen.getByTitle('Delete volume (destructive)'));
    const confirm = screen.getByRole('dialog');
    fireEvent.change(within(confirm).getByRole('textbox'), { target: { value: 'nd-svc-api-data' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.volumes.remove).toHaveBeenCalledWith('nd-svc-api-data', { serverId: 3 }));
  });

  it('creates a managed volume on the selected host, and refuses a name that is not managed', async () => {
    mockOf(api.volumes.create).mockResolvedValue({ ok: true, name: 'nd-svc-new', serverId: 3 } as never);
    renderWithProviders(<Volumes />);
    const name = await screen.findByLabelText('New volume name');
    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.change(name, { target: { value: 'my-volume' } });
    expect(create).toBeDisabled();
    fireEvent.submit(name.closest('form')!);
    expect(api.volumes.create).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: 'nd-svc-new' } });
    fireEvent.click(create);
    await waitFor(() => expect(api.volumes.create).toHaveBeenCalledWith({ name: 'nd-svc-new' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Volume nd-svc-new created', 'success'));

    fireEvent.change(await screen.findByLabelText('Volume host'), { target: { value: '3' } });
    fireEvent.change(name, { target: { value: 'nd-db-x-data' } });
    expect(create).toHaveAttribute('title', 'Create a managed volume on the edge-1');
    mockOf(api.volumes.create).mockRejectedValueOnce(Object.assign(new Error('Volume nd-db-x-data already exists on edge-1'), { code: 'node_volume_exists' }) as never);
    fireEvent.click(create);
    await waitFor(() => expect(api.volumes.create).toHaveBeenLastCalledWith({ name: 'nd-db-x-data', serverId: 3 }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Volume nd-db-x-data already exists on edge-1', 'error'));
  });

  it('an outdated agent answers with a clear error card; no node registered means no switcher', async () => {
    mockOf(api.volumes.list).mockImplementation((async (opts?: { serverId?: number }) => {
      if (opts?.serverId) throw new Error('The agent on node edge-down predates node volumes: update the agent.');
      return panelVolumes;
    }) as never);
    renderWithProviders(<Volumes />);
    fireEvent.change(await screen.findByLabelText('Volume host'), { target: { value: '5' } });
    expect(await screen.findByText(/predates node volumes/)).toBeInTheDocument();

    mockOf(api.servers.list).mockResolvedValue([] as never);
    const second = renderWithProviders(<Volumes />);
    await second.findAllByText('Persistent volumes');
    expect(second.queryAllByLabelText('Volume host')).toHaveLength(1); // only the first render's
  });
});
