import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, deferred, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    databases: { create: vi.fn() },
    volumes: { list: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

const modeMock = vi.hoisted(() => ({
  useExperienceMode: vi.fn(() => ({
    mode: 'simple' as 'simple' | 'advanced',
    isAdvanced: false,
    isSimple: true,
    setMode: vi.fn(),
    toggleMode: vi.fn(),
  })),
}));
vi.mock('../src/lib/mode.js', () => ({ useExperienceMode: modeMock.useExperienceMode }));

import { DatabaseWizard } from '../src/components/DatabaseWizard.js';
import { ToastProvider } from '../src/components/Toast.js';

function renderWizard(onClose = vi.fn()) {
  return {
    onClose,
    ...renderWithProviders(<DatabaseWizard onClose={onClose} />, {
      queryClient: createQueryClient(),
    }),
  };
}

describe('DatabaseWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.databases.create.mockResolvedValue({ id: 1 });
    apiMock.api.volumes.list.mockResolvedValue([]);
  });

  it('starts on the engine step with all four engines', () => {
    renderWizard();
    expect(screen.getByText('New database')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('MySQL')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
    expect(screen.getByText('MongoDB')).toBeInTheDocument();
  });

  it('requires an engine before continuing', async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.click(screen.getByText('PostgreSQL'));
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('moves to the details step and requires a name', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByPlaceholderText('my-database')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByPlaceholderText('my-database'), 'prod');
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('r211: surfaces a create failure instead of swallowing it', async () => {
    apiMock.api.databases.create.mockRejectedValueOnce(new Error("slug 'postgres-db' is taken"));
    const user = userEvent.setup();
    renderWithProviders(<DatabaseWizard onClose={vi.fn()} />, {
      queryClient: createQueryClient(),
      wrapper: (children) => <ToastProvider>{children}</ToastProvider>,
    });
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: 'Create Now' }));
    expect(await screen.findByText("slug 'postgres-db' is taken")).toBeInTheDocument();
  });

  it('creates immediately from the quick-mode button once an engine is picked', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: 'Create Now' }));
    await waitFor(() =>
      expect(apiMock.api.databases.create).toHaveBeenCalledWith(expect.objectContaining({ engine: 'postgres' })));
  });

  it('reviews and creates the database without a version', async () => {
    const { onClose } = renderWizard();
    const user = userEvent.setup();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'prod');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText('nd-db-prod-data')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create database/i }));
    await waitFor(() =>
      expect(apiMock.api.databases.create).toHaveBeenCalledWith({
        name: 'prod',
        engine: 'postgres',
        version: undefined,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('creates with an explicit version', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Redis'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'cache');
    await user.type(screen.getByPlaceholderText(/16 \(default/i), '7.2');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('7.2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create database/i }));
    await waitFor(() =>
      expect(apiMock.api.databases.create).toHaveBeenCalledWith({
        name: 'cache',
        engine: 'redis',
        version: '7.2',
      }),
    );
  });

  it('shows the creating label while pending and disables submit', async () => {
    const d = deferred();
    apiMock.api.databases.create.mockReturnValue(d.promise);
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('MongoDB'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'm1');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /create database/i }));
    expect(screen.getByText('Creating…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled();
    d.resolve({ id: 2 });
  });

  it('goes back to the previous step', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'prod');
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
  });

  it('hides the back button on the first step', () => {
    renderWizard();
    const back = screen.getByRole('button', { name: /back/i });
    expect(back.className).toContain('invisible');
  });

  it('is announced as a labelled modal dialog and closes on Escape (r294)', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();
    const dialog = screen.getByRole('dialog', { name: 'New database' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via the X button and the backdrop', async () => {
    const user = userEvent.setup();
    const { container, onClose } = renderWizard();
    const headerClose = container.querySelector('h2 + button') as HTMLButtonElement;
    await user.click(headerClose);
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText('New database').closest('.fixed')!.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('marks completed steps with a check icon', async () => {
    const user = userEvent.setup();
    const { container } = renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // After advancing, step 0 is "completed" — its circle uses the emerald
    // background and contains the Check lucide icon (rendered as <svg>).
    expect(container.querySelector('.bg-emerald-500')).not.toBeNull();
  });

  it('renders the engine summary row using the selected engine emoji and label', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('Redis'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'cache');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // The review row combines the engine emoji and label via `ENGINES.find(...)`
    // — covers the `?? ''` and `?? ''` nullish fallbacks.
    expect(screen.getByText(/⚡ Redis/)).toBeInTheDocument();
  });

  it('selects, changes and attaches an existing retained volume or toggles back to fresh volume', async () => {
    apiMock.api.volumes.list.mockResolvedValueOnce([
      { name: 'nd-db-old-postgres-data', sizeBytes: 50 * 1024 * 1024, owner: null, inUse: false },
      { name: 'nd-db-second-postgres-data', sizeBytes: 120 * 1024 * 1024, owner: null, inUse: false },
    ]);
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'restored-db');
    expect(await screen.findByText(/Re-attach retained volume/i)).toBeInTheDocument();
    await user.click(screen.getByText(/Re-attach retained volume/i));
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    await user.selectOptions(select, 'nd-db-second-postgres-data');
    await user.click(screen.getByText(/Create fresh volume/i));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByText(/Re-attach retained volume/i));
    await user.selectOptions(screen.getByRole('combobox'), 'nd-db-second-postgres-data');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText(/Re-attach \(nd-db-second-postgres-data\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create database/i }));
    await waitFor(() =>
      expect(apiMock.api.databases.create).toHaveBeenCalledWith({
        name: 'restored-db',
        engine: 'postgres',
        version: undefined,
        existingVolume: 'nd-db-second-postgres-data',
      }),
    );
  });

  it('creates postgres with pgvector extension enabled', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'vector-db');

    const pgvectorCheck = screen.getByRole('checkbox');
    expect(pgvectorCheck).toBeInTheDocument();
    await user.click(pgvectorCheck);

    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /create database/i }));
    await waitFor(() =>
      expect(apiMock.api.databases.create).toHaveBeenCalledWith({
        name: 'vector-db',
        engine: 'postgres',
        version: undefined,
        existingVolume: undefined,
        extensions: ['pgvector'],
      }),
    );
  });

  it('creates databases with extended engines (Valkey, ClickHouse, Meilisearch, RabbitMQ)', async () => {
    const user = userEvent.setup();
    renderWizard();
    expect(screen.getByText('Valkey')).toBeInTheDocument();
    expect(screen.getByText('ClickHouse')).toBeInTheDocument();
    expect(screen.getByText('Meilisearch')).toBeInTheDocument();
    expect(screen.getByText('RabbitMQ')).toBeInTheDocument();

    await user.click(screen.getByText('ClickHouse'));
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.type(screen.getByPlaceholderText('my-database'), 'analytics');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await user.click(screen.getByRole('button', { name: /create database/i }));
    await waitFor(() =>
      expect(apiMock.api.databases.create).toHaveBeenCalledWith({
        name: 'analytics',
        engine: 'clickhouse',
        version: undefined,
      }),
    );
  });

  it('derives the default name from the engine on quick create', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: 'Create Now' }));
    await waitFor(() =>
      expect(apiMock.api.databases.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'postgres-db', engine: 'postgres' }),
      ),
    );
  });

  it('shows the pending state on the quick-mode button', async () => {
    const user = userEvent.setup();
    const hold = deferred();
    apiMock.api.databases.create.mockReturnValue(hold.promise);
    renderWizard();
    await user.click(screen.getByText('PostgreSQL'));
    await user.click(screen.getByRole('button', { name: 'Create Now' }));
    expect(screen.getByText('Creating…')).toBeInTheDocument();
    hold.resolve({ id: 1 });
    await waitFor(() =>
      expect(screen.queryByText('Creating…')).not.toBeInTheDocument());
  });

  it('renders the DevOps Pro badge in advanced mode', async () => {
    modeMock.useExperienceMode.mockReturnValue({
      mode: 'advanced',
      isAdvanced: true,
      isSimple: false,
      setMode: vi.fn(),
      toggleMode: vi.fn(),
    });
    const user = userEvent.setup();
    renderWizard();
    expect(screen.getByText('DevOps Pro')).toBeInTheDocument();
    // Advanced mode drops the 1-click quick-create block.
    await user.click(screen.getByText('PostgreSQL'));
    expect(screen.queryByRole('button', { name: 'Create Now' })).not.toBeInTheDocument();
  });
});
