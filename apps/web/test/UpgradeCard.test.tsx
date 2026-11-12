import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    databases: {
      upgrades: {
        list: vi.fn(),
        options: vi.fn(),
        start: vi.fn(),
        rollback: vi.fn(),
        finalize: vi.fn(),
      },
    },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

import { ToastProvider } from '../src/components/Toast.js';
import { UpgradeCard } from '../src/routes/database/UpgradeCard.js';

/** O2: Database → Settings → Major version upgrade. */
const up = apiMock.api.databases.upgrades;
const db = { id: 7, name: 'orders', engine: 'postgres' } as never;
const row = (over: Record<string, unknown> = {}) => ({
  id: 4, databaseId: 7, engine: 'postgres', fromMajor: 16, toMajor: 18, previousVersion: '16', targetVersion: '18',
  previousVolume: 'nd-db-orders-data', targetVolume: 'nd-db-orders-data-u4', status: 'completed', phase: null, safetyBackupId: 3,
  verification: { tables: 3, rows: 120, sequences: 2, objects: { indexes: 1, constraints: 1, views: 0, triggers: 0, functions: 0, extensions: 'plpgsql' }, mismatches: [] },
  error: null, createdAt: '2026-11-12T10:00:00.000Z', completedAt: '2026-11-12T10:02:00.000Z', rolledBackAt: null, finalizedAt: null,
  ...over,
});

function renderCard(d: unknown = db) {
  return renderWithProviders(<UpgradeCard db={d as never} />, {
    queryClient: createQueryClient(),
    wrapper: (c) => <ToastProvider>{c}</ToastProvider>,
  });
}

beforeEach(() => {
  for (const fn of Object.values(up)) fn.mockReset();
  up.list.mockResolvedValue([]);
  up.options.mockResolvedValue({ databaseId: 7, currentMajor: 16, targets: [17, 18], refusal: null });
});

describe('UpgradeCard', () => {
  it('renders nothing for another engine', () => {
    const { container } = renderCard({ id: 7, name: 'cache', engine: 'redis' });
    expect(container.textContent).toBe('');
    expect(up.list).not.toHaveBeenCalled();
  });

  it('offers the newer majors, newest first selected, and starts after the name is typed', async () => {
    up.start.mockResolvedValue(row({ status: 'running', phase: 'pull' }));
    renderCard();
    const select = await screen.findByLabelText('Target major');
    expect((select as HTMLSelectElement).value).toBe('18');
    fireEvent.change(select, { target: { value: '17' } });
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(await screen.findByText('Upgrade to PostgreSQL 17?')).toBeTruthy();
    const confirm = screen.getAllByRole('button', { name: 'Upgrade' }).at(-1)!;
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(up.start).toHaveBeenCalledWith(7, { toMajor: 17 }));
    expect(await screen.findByText('Upgrade to PostgreSQL 18 started')).toBeTruthy();
  });

  it('shows why no upgrade can start', async () => {
    up.options.mockResolvedValue({ databaseId: 7, currentMajor: null, targets: [], refusal: { code: 'database_upgrade_pitr', message: 'Point-in-time recovery is on.' } });
    renderCard();
    expect((await screen.findByTestId('upgrade-refusal')).textContent).toBe('Point-in-time recovery is on.');
  });

  it('a running upgrade shows its phase and does not read the options', async () => {
    up.list.mockResolvedValue([row({ status: 'running', phase: 'restore' })]);
    renderCard();
    expect((await screen.findByTestId('upgrade-running')).textContent).toContain('Restoring into the new major');
    expect(up.options).not.toHaveBeenCalled();
  });

  it('a running upgrade in an unknown phase still says it is running', async () => {
    up.list.mockResolvedValue([row({ status: 'running', phase: null })]);
    renderCard();
    expect((await screen.findByTestId('upgrade-running')).textContent).toContain('starting');
  });

  it('a completed upgrade shows what was compared, and finalizes or rolls back', async () => {
    up.list.mockResolvedValue([row()]);
    up.finalize.mockResolvedValue({ ...row({ status: 'finalized' }), removedVolume: 'nd-db-orders-data' });
    up.rollback.mockResolvedValue(row({ status: 'rolled_back' }));
    renderCard();
    expect(await screen.findByText('Compared before the switch: 3 tables, 120 rows, 2 sequences.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to PostgreSQL 16' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(up.rollback).toHaveBeenCalledWith(7, 4));
    expect(await screen.findByText('Back on PostgreSQL 16')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finalize' }));
    expect(await screen.findByText('Delete nd-db-orders-data?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(up.finalize).toHaveBeenCalledWith(7, 4));
    expect(await screen.findByText('Deleted nd-db-orders-data')).toBeTruthy();
  });

  it('after a rollback the upgraded volume can be deleted', async () => {
    up.list.mockResolvedValue([row({ status: 'rolled_back' })]);
    up.finalize.mockRejectedValue(new Error('Volume nd-db-orders-data-u4 could not be removed'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the upgraded volume' }));
    expect(await screen.findByText('Delete nd-db-orders-data-u4?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Volume nd-db-orders-data-u4 could not be removed')).toBeTruthy();
  });

  it('a failed last upgrade says why, next to the history', async () => {
    up.list.mockResolvedValue([row({ id: 5, status: 'failed', error: 'the restored copy does not match' }), row({ status: 'finalized' })]);
    renderCard();
    expect(await screen.findByText('The last upgrade failed: the restored copy does not match')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Upgrade history' }).querySelectorAll('li')).toHaveLength(2);
  });

  it('reports a refused start and a failed rollback', async () => {
    up.start.mockRejectedValue(new Error('The cluster holds other databases'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade' }));
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Upgrade' }).at(-1)!);
    expect(await screen.findByText('The cluster holds other databases')).toBeTruthy();
  });

  it('a failed rollback is reported', async () => {
    up.list.mockResolvedValue([row()]);
    up.rollback.mockRejectedValue(new Error('PostgreSQL 16 did not start'));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Roll back to PostgreSQL 16' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Roll back' }));
    expect(await screen.findByText('PostgreSQL 16 did not start')).toBeTruthy();
  });

  it('says when the version cannot be read', async () => {
    up.options.mockRejectedValue(new Error('boom'));
    renderCard();
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});
