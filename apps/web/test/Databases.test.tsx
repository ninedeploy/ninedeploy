import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Databases } from '../src/routes/Databases.js';
import { api } from '../src/lib/api.js';
import { TagScopeProvider } from '../src/lib/projects.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/components/DatabaseWizard.js', () => ({
  DatabaseWizard: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="db-wizard">
      wizard
      <button type="button" onClick={onClose}>close wizard</button>
    </div>
  ),
}));

const databases = [
  {
    id: 1,
    name: 'main-db',
    engine: 'postgres',
    version: '16',
    status: 'running',
    connectionString: 'postgres://user:pass@localhost:5432/main',
  },
  {
    id: 2,
    name: 'cache',
    engine: 'unknown-engine',
    version: null,
    status: 'stopped',
    connectionString: null,
  },
];

describe('Databases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('shows skeleton cards while loading', () => {
    mockOf(api.databases.list).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Databases />);
    expect(document.querySelectorAll('.animate-pulse').length).toBe(6);
  });

  it('shows empty state when there are no databases', async () => {
    mockOf(api.databases.list).mockResolvedValue([] as never);
    renderWithProviders(<Databases />);
    await screen.findByText('No databases');
  });

  it('renders database cards with engine labels, connection strings and gauges', async () => {
    mockOf(api.databases.list).mockResolvedValue(databases as never);
    mockOf(api.backups.storage).mockResolvedValue({ sizeBytes: 200 * 1024 * 1024 } as never);
    renderWithProviders(<Databases />);
    await screen.findByText('main-db');
    // known engine label + version
    expect(screen.getByText('PostgreSQL 16')).toBeInTheDocument();
    // unknown engine falls back to raw value, no version
    expect(screen.getByText('unknown-engine')).toBeInTheDocument();
    // status badges
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('stopped')).toBeInTheDocument();
    // connection string button for running db
    expect(screen.getByText('postgres://user:pass@localhost:5432/main')).toBeInTheDocument();
    // 'Not running' for the stopped one
    expect(screen.getByText('Not running')).toBeInTheDocument();
    // StorageGauge rendered for running db (Volume label)
    await screen.findByText('Volume');
  });

  it('copies a connection string and shows the check state', async () => {
    mockOf(api.databases.list).mockResolvedValue(databases as never);
    mockOf(api.backups.storage).mockResolvedValue({ sizeBytes: 10 * 1024 * 1024 } as never);
    renderWithProviders(<Databases />);
    const copyButton = await screen.findByTitle('Copy connection string');
    await userEvent.click(copyButton);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(databases[0]!.connectionString));
    // the copied indicator (Check icon) resets after the 1500ms timeout
    await waitFor(() => expect(copyButton.querySelector('.lucide-check')).toBeNull(), { timeout: 2500 });
  });

  it('ignores clipboard failure', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
      configurable: true,
    });
    mockOf(api.databases.list).mockResolvedValue(databases as never);
    mockOf(api.backups.storage).mockResolvedValue({ sizeBytes: 10 * 1024 * 1024 } as never);
    renderWithProviders(<Databases />);
    const copyButton = await screen.findByTitle('Copy connection string');
    await userEvent.click(copyButton);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  });

  it('triggers a backup and removes a database', async () => {
    mockOf(api.databases.list).mockResolvedValue(databases as never);
    mockOf(api.backups.storage).mockResolvedValue({ sizeBytes: 10 * 1024 * 1024 } as never);
    mockOf(api.backups.backupNow).mockResolvedValue({ id: 9 } as never);
    mockOf(api.databases.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Databases />);
    await screen.findByText('main-db');
    const backupButtons = screen.getAllByRole('button', { name: /Backup/ });
    fireEvent.click(backupButtons[0]!);
    await waitFor(() => expect(api.backups.backupNow).toHaveBeenCalledWith(1));
    const removeButton = screen.getAllByRole('button', { name: /Remove/ })[0]!;
    fireEvent.click(removeButton);
    // Removal is confirmed through the shared dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.databases.remove).toHaveBeenCalledWith(1, { force: false }));
  });

  it('toasts on backup and removal failures', async () => {
    mockOf(api.databases.list).mockResolvedValue(databases as never);
    mockOf(api.backups.storage).mockResolvedValue({ sizeBytes: 10 * 1024 * 1024 } as never);
    mockOf(api.backups.backupNow).mockRejectedValue(new Error('dump') as never);
    mockOf(api.databases.remove).mockRejectedValue(new Error('busy') as never);
    renderWithProviders(<Databases />);
    await screen.findByText('main-db');
    fireEvent.click(screen.getAllByRole('button', { name: /Backup/ })[0]!);
    await waitFor(() => expect(api.backups.backupNow).toHaveBeenCalledWith(1));
    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.databases.remove).toHaveBeenCalledWith(1, { force: false }));
  });

  it('warns when deleting an in-use attached database and passes force=true', async () => {
    mockOf(api.databases.list).mockResolvedValue([
      {
        id: 1,
        name: 'locked-db',
        engine: 'postgres',
        version: '16',
        status: 'running',
        connectionString: 'postgres://...',
        attachedServices: [{ id: 10, name: 'web-app', slug: 'web-app' }],
      },
    ] as never);
    mockOf(api.databases.remove).mockResolvedValue(undefined as never);
    renderWithProviders(<Databases />);
    expect(await screen.findByText('1 linked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(screen.getByText(/Dependency warning/)).toBeInTheDocument();
    expect(screen.getByText(/web-app/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Force Delete' }));
    await waitFor(() => expect(api.databases.remove).toHaveBeenCalledWith(1, { force: true }));
  });

  it('cancels a removal without deleting and shows an error card on query failure', async () => {
    mockOf(api.databases.list).mockResolvedValue(databases as never);
    mockOf(api.backups.storage).mockResolvedValue({ sizeBytes: 10 * 1024 * 1024 } as never);
    renderWithProviders(<Databases />);
    await screen.findByText('main-db');
    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.databases.remove).not.toHaveBeenCalled();

    mockOf(api.databases.list).mockRejectedValue(new Error('db down') as never);
    const { unmount } = renderWithProviders(<Databases />);
    expect(await screen.findAllByText("Couldn't load databases")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]!);
    await waitFor(() => expect(api.databases.list).toHaveBeenCalledTimes(3)); // 2 renders + retry
    unmount();
  });

  it('opens and closes the database wizard', async () => {
    const user = userEvent.setup();
    mockOf(api.databases.list).mockResolvedValue([] as never);
    renderWithProviders(<Databases />);
    await user.click(await screen.findByRole('button', { name: /New database/ }));
    expect(screen.getByTestId('db-wizard')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close wizard' }));
    expect(screen.queryByTestId('db-wizard')).not.toBeInTheDocument();
  });

  it('scopes the list to the selected project', async () => {
    // The project filter now lives in the chip-based tag scope
    // (`ninedeploy.tagScope`), not the legacy single-project key.
    localStorage.setItem('ninedeploy.tagScope', JSON.stringify({ projectIds: [3] }));
    mockOf(api.databases.list).mockResolvedValue([] as never);
    renderWithProviders(
      <TagScopeProvider>
        <Databases />
      </TagScopeProvider>,
    );
    await screen.findByText(/No databases/i);
    expect(api.databases.list).toHaveBeenCalledWith('?projectId=3');
    localStorage.removeItem('ninedeploy.tagScope');
  });
});
