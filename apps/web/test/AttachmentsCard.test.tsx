import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../src/components/Toast.js';
import { createQueryClient, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    attachments: {
      list: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
    databases: { list: vi.fn(), logs: vi.fn() },
  },
}));

vi.mock('../src/lib/api.js', () => apiMock);

import { AttachmentsCard } from '../src/components/AttachmentsCard.js';

const DATABASES = [
  { id: 1, name: 'pg-main', engine: 'postgres', status: 'running' },
  { id: 2, name: 'cache', engine: 'redis', status: 'running' },
  { id: 3, name: 'old-db', engine: 'mysql', status: 'stopped' },
];

const ATTACHMENTS = [
  {
    id: 10,
    databaseId: 1,
    envAlias: 'DATABASE_URL',
    database: { name: 'pg-main', engine: 'postgres', status: 'running' },
  },
  { id: 11, databaseId: 4, envAlias: 'X_URL', database: null },
];

function renderCard() {
  return renderWithProviders(<AttachmentsCard serviceId={5} />, {
    queryClient: createQueryClient(),
  });
}

/** Renders with the toast outlet mounted so toast assertions can query text. */
function renderCardWithToasts() {
  return renderWithProviders(<AttachmentsCard serviceId={5} />, {
    queryClient: createQueryClient(),
    wrapper: (children) => <ToastProvider>{children}</ToastProvider>,
  });
}

describe('AttachmentsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.attachments.list.mockResolvedValue(ATTACHMENTS);
    apiMock.api.databases.list.mockResolvedValue(DATABASES);
    apiMock.api.attachments.create.mockResolvedValue(ATTACHMENTS[0]);
    apiMock.api.attachments.remove.mockResolvedValue(undefined);
  });

  it('shows a skeleton while loading', () => {
    apiMock.api.attachments.list.mockReturnValue(new Promise(() => {}));
    const { container } = renderCard();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('shows an empty state when no databases are attached', async () => {
    apiMock.api.attachments.list.mockResolvedValue([]);
    renderCard();
    await waitFor(() =>
      expect(screen.getByText('No databases attached.')).toBeInTheDocument(),
    );
  });

  it('lists running databases in the select and hides non-running ones', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('pg-main (postgres)')).toBeInTheDocument());
    expect(screen.getByText('cache (redis)')).toBeInTheDocument();
    expect(screen.queryByText('old-db (mysql)')).not.toBeInTheDocument();
  });

  it('renders attachments with database details and badges', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('pg-main')).toBeInTheDocument());
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
  });

  it('falls back to a generic name when the database is gone', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('database')).toBeInTheDocument());
    expect(screen.getByText('X_URL')).toBeInTheDocument();
  });

  it('attaches a database with an alias', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('pg-main (postgres)')).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox'), '1');
    await user.type(screen.getByPlaceholderText('DATABASE_URL'), 'PG_URL');
    await user.click(screen.getByRole('button', { name: /attach/i }));
    await waitFor(() =>
      expect(apiMock.api.attachments.create).toHaveBeenCalledWith(5, {
        databaseId: 1,
        envAlias: 'PG_URL',
      }),
    );
  });

  it('r211: shows the server refusal when an attach fails', async () => {
    apiMock.api.attachments.create.mockRejectedValueOnce(new Error('Admin role on the database required'));
    const user = userEvent.setup();
    renderCardWithToasts();
    await waitFor(() => expect(screen.getByText('pg-main (postgres)')).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox'), '1');
    await user.click(screen.getByRole('button', { name: /attach/i }));
    expect(await screen.findByText('Admin role on the database required')).toBeInTheDocument();
  });

  it('attaches a redis database using the REDIS_URL alias placeholder', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('pg-main (postgres)')).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox'), '2');
    expect(screen.getByPlaceholderText('REDIS_URL')).toBeInTheDocument();
  });

  it('attaches without an alias when none is typed', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('pg-main (postgres)')).toBeInTheDocument());
    await user.selectOptions(screen.getByRole('combobox'), '1');
    await user.click(screen.getByRole('button', { name: /attach/i }));
    await waitFor(() =>
      expect(apiMock.api.attachments.create).toHaveBeenCalledWith(5, {
        databaseId: 1,
        envAlias: undefined,
      }),
    );
  });

  it('disables Attach until a database is selected', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('pg-main (postgres)')).toBeInTheDocument());
    const attach = screen.getByRole('button', { name: /attach/i });
    expect(attach).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox'), '1');
    expect(screen.getByRole('button', { name: /attach/i })).toBeEnabled();
  });

  it('detaches an attachment', async () => {
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText('pg-main')).toBeInTheDocument());
    const row = screen.getByText('pg-main').closest('div')?.parentElement as HTMLElement;
    await user.click(row.querySelector('button[title="Detach"]') as HTMLButtonElement);
    await waitFor(() => expect(apiMock.api.attachments.remove).toHaveBeenCalledWith(5, 10));
  });

  it('probes attachment connectivity and reports both outcomes', async () => {
    const user = userEvent.setup();
    apiMock.api.databases.logs.mockResolvedValueOnce('log-line');
    renderCardWithToasts();
    await waitFor(() => expect(screen.getByText('pg-main')).toBeInTheDocument());

    // Each attachment row has a probe: the linked db and the dangling one.
    await user.click(screen.getAllByTitle('Test database connectivity')[0]!);
    await waitFor(() => expect(apiMock.api.databases.logs).toHaveBeenCalledWith(1));
    await user.click(screen.getAllByTitle('Test database connectivity')[1]!);
    await waitFor(() => expect(apiMock.api.databases.logs).toHaveBeenCalledWith(4));

    // A failing probe is caught (no unhandled rejection) and falls back.
    apiMock.api.databases.logs.mockRejectedValueOnce('nope' as never);
    await user.click(screen.getAllByTitle('Test database connectivity')[0]!);
    await waitFor(() =>
      expect(apiMock.api.databases.logs).toHaveBeenCalledTimes(3));

    // An Error rejection surfaces the message inside the failure toast.
    apiMock.api.databases.logs.mockRejectedValueOnce(new Error('container down'));
    await user.click(screen.getAllByTitle('Test database connectivity')[0]!);
    await waitFor(() =>
      expect(screen.getByText(/Could not reach pg-main: container down/)).toBeInTheDocument());
  });

  it('falls back to DATABASE_URL when the selected database has no engine', async () => {
    const user = userEvent.setup();
    apiMock.api.databases.list.mockResolvedValueOnce([
      { id: 7, name: 'mystery', status: 'running' },
    ]);
    renderCardWithToasts();
    const option = await screen.findByRole('option', { name: /mystery/ });
    await user.selectOptions(screen.getByRole('combobox'), option);
    expect(screen.getByPlaceholderText('DATABASE_URL')).toBeInTheDocument();
  });

  it('suggests the conventional env alias for every database engine', async () => {
    const user = userEvent.setup();
    apiMock.api.databases.list.mockResolvedValueOnce([
      { id: 21, name: 'docs', engine: 'mongodb', status: 'running' },
      { id: 22, name: 'maria', engine: 'mariadb', status: 'running' },
      { id: 23, name: 'events', engine: 'clickhouse', status: 'running' },
      { id: 24, name: 'search', engine: 'meilisearch', status: 'running' },
      { id: 25, name: 'queue', engine: 'rabbitmq', status: 'running' },
      { id: 26, name: 'weird', engine: 'cockroach', status: 'running' },
      { id: 27, name: 'kv', engine: 'valkey', status: 'running' },
      { id: 28, name: 'raw', engine: 'mongo', status: 'running' },
      { id: 29, name: 'sql', engine: 'mysql', status: 'running' },
    ]);
    renderCard();
    await waitFor(() => expect(screen.getByText('docs (mongodb)')).toBeInTheDocument());

    const expected: Array<[string, string]> = [
      ['21', 'MONGODB_URI'],
      ['22', 'MYSQL_URL'],
      ['23', 'CLICKHOUSE_URL'],
      ['24', 'MEILISEARCH_URL'],
      ['25', 'RABBITMQ_URL'],
      // Unknown engines fall back to the generic DATABASE_URL placeholder.
      ['26', 'DATABASE_URL'],
      ['27', 'REDIS_URL'],
      ['28', 'MONGODB_URI'],
      ['29', 'MYSQL_URL'],
    ];
    for (const [value, alias] of expected) {
      await user.selectOptions(screen.getByRole('combobox'), value);
      expect(screen.getByPlaceholderText(alias)).toBeInTheDocument();
    }
  });
});
