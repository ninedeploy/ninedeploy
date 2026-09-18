import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { VolumesTab } from '../src/routes/service/VolumesTab.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

// The browser modal is covered by its own suite; stub it here to observe opens.
vi.mock('../src/components/VolumeBrowser.js', () => ({
  VolumeBrowser: ({ volume, onClose }: { volume: string; onClose: () => void }) => (
    <div data-testid="volume-browser">
      browsing:{volume}
      <button type="button" onClick={onClose}>close browser</button>
    </div>
  ),
}));

function svc(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    projectIds: [],
    workspaceIds: [],
    labelIds: [],
    name: 'api',
    slug: 'api',
    type: 'docker',
    status: 'running',
    repoUrl: null,
    branch: 'main',
    sourceId: null,
    image: null,
    volumeMount: '/app/data',
    composeService: null,
    commitSha: null,
    runtimeId: null,
    healthPath: '/',
    autoUrl: 'api.nd.local',
    port: 3000,
    publishedPort: null,
    cpuShares: 0,
    memLimitMb: 0,
    build: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as never;
}

describe('VolumesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the stateless empty state when no volume is mounted', async () => {
    mockOf(api.volumes.list).mockResolvedValue([] as never);
    mockOf(api.attachments.list).mockResolvedValue([] as never);
    renderWithProviders(<VolumesTab serviceId={1} svc={svc({ volumeMount: null })} />);

    expect(await screen.findByText('No persistent volume mounted for this service')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByText('Stateless container')).toBeInTheDocument();
    expect(screen.getByText('No attached database volumes')).toBeInTheDocument();
    expect(screen.getAllByText('0 B').length).toBe(2);
  });

  it('summarizes the service volume and attached database volumes', async () => {
    mockOf(api.volumes.list).mockResolvedValue([
      { name: 'nd-vol-api', sizeBytes: 2048, owner: { kind: 'service', id: 1, name: 'api' } },
      { name: 'nd-db-main-data', sizeBytes: 4096, owner: { kind: 'database', id: 7, name: 'main', engine: 'postgres' } },
      // Not attached to this service: ignored.
      { name: 'nd-db-other-data', sizeBytes: 8192, owner: { kind: 'database', id: 8, name: 'other', engine: 'redis' } },
    ] as never);
    mockOf(api.attachments.list).mockResolvedValue([{ id: 9, databaseId: 7, envAlias: 'DATABASE_URL' }] as never);
    renderWithProviders(<VolumesTab serviceId={1} svc={svc()} />);

    // Wait for the volumes query: the fallback name renders before data lands.
    await screen.findByText('6.1 KB');
    expect(screen.getByText('nd-vol-api')).toBeInTheDocument();
    expect(screen.getByText('Primary Mount')).toBeInTheDocument();
    expect(screen.getByText(/Mounted at \/app\/data/)).toBeInTheDocument();
    expect(screen.getByText(/Mounted & Active/)).toBeInTheDocument();
    // r215: no fake per-volume toggle — the server's retention policy is shown.
    expect(screen.queryByRole('button', { name: /Protection (On|Off)/i })).not.toBeInTheDocument();
    // Totals: 2 KiB service + 4 KiB attached db (decimal KB units); the db
    // volume's own card also shows 4.1 KB.
    expect(screen.getAllByText('4.1 KB').length).toBe(2);
    // The attached database card links to the database.
    expect(screen.getByRole('link', { name: /main/ })).toHaveAttribute('href', '/databases/7');
    expect(screen.getByText('postgres · nd-db-main-data')).toBeInTheDocument();
    expect(screen.getAllByText('Retained on Delete').length).toBe(2);
    expect(screen.queryByText('nd-db-other-data')).not.toBeInTheDocument();
  });

  it('shows detached status for a stopped service', async () => {
    mockOf(api.volumes.list).mockResolvedValue([
      { name: 'nd-vol-api', sizeBytes: 1024, owner: { kind: 'service', id: 1, name: 'api' } },
    ] as never);
    mockOf(api.attachments.list).mockResolvedValue([] as never);
    renderWithProviders(<VolumesTab serviceId={1} svc={svc({ status: 'stopped' })} />);

    expect(await screen.findByText('nd-vol-api')).toBeInTheDocument();
    expect(screen.getByText(/Detached \(Stopped\)/)).toBeInTheDocument();
    expect(screen.getByText('Retained on Delete')).toBeInTheDocument();
  });

  it('opens the volume browser for the service and database volumes', async () => {
    mockOf(api.volumes.list).mockResolvedValue([
      { name: 'nd-vol-api', sizeBytes: 1024, owner: { kind: 'service', id: 1, name: 'api' } },
      { name: 'nd-db-main-data', sizeBytes: 1024, owner: { kind: 'database', id: 7, name: 'main', engine: 'postgres' } },
    ] as never);
    mockOf(api.attachments.list).mockResolvedValue([{ id: 9, databaseId: 7, envAlias: 'DATABASE_URL' }] as never);
    renderWithProviders(<VolumesTab serviceId={1} svc={svc()} />);

    // Both browsers appear once the attachments query settles.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Browse Files/i })).toHaveLength(2));
    const browseButtons = screen.getAllByRole('button', { name: /Browse Files/i });
    expect(browseButtons.length).toBe(2);

    fireEvent.click(browseButtons[1]!); // database volume browser
    expect(await screen.findByTestId('volume-browser')).toHaveTextContent('browsing:nd-db-main-data');
    fireEvent.click(screen.getByRole('button', { name: 'close browser' }));
    await waitFor(() => expect(screen.queryByTestId('volume-browser')).not.toBeInTheDocument());

    fireEvent.click(browseButtons[0]!); // service volume browser
    expect(await screen.findByTestId('volume-browser')).toHaveTextContent('browsing:nd-vol-api');
  });

  it('falls back to the slug-derived volume name when the owner row is missing', async () => {
    mockOf(api.volumes.list).mockResolvedValue([] as never);
    mockOf(api.attachments.list).mockResolvedValue([] as never);
    renderWithProviders(<VolumesTab serviceId={1} svc={svc()} />);

    expect(await screen.findByText('nd-vol-api')).toBeInTheDocument();
  });
  it('expands and collapses the backups panel of an attached volume', async () => {
    mockOf(api.volumes.list).mockResolvedValue([] as never);
    mockOf(api.attachments.list).mockResolvedValue([] as never);
    mockOf(api.serviceVolumes.list).mockResolvedValue([
      {
        id: 3,
        serviceId: 1,
        volumeName: 'nd-svc-api-uploads',
        containerPath: '/app/uploads',
        readOnly: false,
        sizeBytes: 2048,
        inUse: true,
        sharedWith: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ] as never);
    mockOf(api.volumeBackups.list).mockResolvedValue([] as never);
    renderWithProviders(<VolumesTab serviceId={1} svc={svc()} />);

    const toggle = await screen.findByTestId('backups-toggle-3');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('volume-backups-panel')).toBeInTheDocument();

    // Clicking the same volume again collapses the panel.
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId('volume-backups-panel')).not.toBeInTheDocument());
  });
});
