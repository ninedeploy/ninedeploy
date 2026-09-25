import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Activity } from '../src/routes/Activity.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const sampleActivities = [
  {
    id: 101,
    userId: 1,
    userName: 'Ada Lovelace',
    userEmail: 'ada@example.com',
    action: 'service.create',
    entity: 'api-service',
    meta: { ip: '127.0.0.1', port: 3000 },
    ts: '2026-08-17T12:00:00.000Z',
  },
  {
    id: 102,
    userId: 2,
    userName: null,
    userEmail: null,
    action: 'service.delete',
    entity: 'worker-job',
    meta: { reason: 'cleanup' },
    ts: '2026-08-17T12:05:00.000Z',
  },
  {
    id: 103,
    userId: null,
    userName: null,
    userEmail: null,
    action: 'deploy.trigger',
    entity: 'web-frontend',
    meta: { commit: 'abc1234' },
    ts: '2026-08-17T12:10:00.000Z',
  },
  {
    id: 104,
    userId: 1,
    userName: 'Ada Lovelace',
    userEmail: 'ada@example.com',
    action: 'deploy.rollback',
    entity: 'web-frontend',
    meta: { targetDeployId: 99 },
    ts: '2026-08-17T12:15:00.000Z',
  },
  {
    id: 105,
    userId: null,
    userName: null,
    userEmail: null,
    action: 'custom.audit_log',
    entity: null,
    meta: null,
    ts: '2026-08-17T12:20:00.000Z',
  },
];

describe('Activity Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
  });

  it('pages older entries with the server cursor (r344)', async () => {
    mockOf(api.activity.list).mockImplementation(async (q?: { before?: number }) =>
      q?.before === 101
        ? { entries: [{ ...sampleActivities[1]!, id: 7, action: 'service.oldest' }], nextCursor: null }
        : { entries: [sampleActivities[0]!], nextCursor: 101 },
    );
    renderWithProviders(<Activity />);
    expect((await screen.findAllByText('service.create')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('service.oldest')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Load older entries/ }));
    await waitFor(() => expect(api.activity.list).toHaveBeenCalledWith(expect.objectContaining({ before: 101 })));
    // Older rows are appended (and so reach search / export), and the last page ends paging.
    expect((await screen.findAllByText('service.oldest')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Load older entries/ })).not.toBeInTheDocument();
  });

  it('renders loading skeleton when loading', () => {
    mockOf(api.activity.list).mockReturnValue(new Promise(() => {}));
    const { container } = renderWithProviders(<Activity />);
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders empty state when there are no activity records', async () => {
    mockOf(api.activity.list).mockResolvedValue({ entries: [] });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getByText('No activity recorded')).toBeInTheDocument();
    });
  });

  it('renders activity table with actions, actors, and metadata inspect buttons', async () => {
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getByText('Activity & Audit Logs')).toBeInTheDocument();
      expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
      expect(screen.getAllByText('service.delete').length).toBeGreaterThan(0);
      expect(screen.getAllByText('deploy.trigger').length).toBeGreaterThan(0);
      expect(screen.getAllByText('deploy.rollback').length).toBeGreaterThan(0);
      expect(screen.getAllByText('custom.audit_log').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(screen.getAllByText('(ada@example.com)').length).toBeGreaterThan(0);
    expect(screen.getByText('User #2')).toBeInTheDocument();
    expect(screen.getAllByText('System Automation').length).toBeGreaterThan(0);
    expect(screen.getAllByText('api-service').length).toBeGreaterThan(0);
    expect(screen.getAllByText('worker-job').length).toBeGreaterThan(0);
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('handles search filtering and clearing all filters', async () => {
    const user = userEvent.setup();
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
    });

    const searchInput = screen.getByPlaceholderText('Search audit trail...');
    fireEvent.change(searchInput, { target: { value: 'cleanup' } });

    expect(screen.getAllByText('service.delete').length).toBeGreaterThan(0);
    expect(screen.getAllByText('worker-job').length).toBeGreaterThan(0);

    // Click clear button
    const clearBtn = screen.getByRole('button', { name: 'Clear' });
    await user.click(clearBtn);

    expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
  });

  it('filters by entity selector', async () => {
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'api-service' } });
    await waitFor(() => {
      expect(mockOf(api.activity.list)).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'api-service' }),
      );
    });
  });

  it('filters by action selector', async () => {
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
    });

    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'service.create' } });
    await waitFor(() => {
      expect(mockOf(api.activity.list)).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'service.create' }),
      );
    });
  });

  it('filters by user ID input', async () => {
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
    });

    const userIdInput = screen.getByPlaceholderText('User ID (e.g. 1)');
    fireEvent.change(userIdInput, { target: { value: '1' } });
    await waitFor(() => {
      expect(mockOf(api.activity.list)).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1 }),
      );
    });
  });

  it('toggles live stream auto-refresh and manually refreshes', async () => {
    const user = userEvent.setup();
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getByText('Live Stream On')).toBeInTheDocument();
    });

    const liveBtn = screen.getByRole('button', { name: /Live Stream On/i });
    await user.click(liveBtn);
    expect(screen.getByText('Paused')).toBeInTheDocument();

    const refreshBtn = screen.getByTitle('Refresh audit logs');
    await user.click(refreshBtn);
    expect(mockOf(api.activity.list)).toHaveBeenCalled();
  });

  it('opens and closes metadata inspect modal', async () => {
    const user = userEvent.setup();
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getAllByText('service.create').length).toBeGreaterThan(0);
    });

    const inspectBtns = screen.getAllByRole('button', { name: /Inspect/i });
    await user.click(inspectBtns[0]!);

    expect(await screen.findByText('Audit Payload #101')).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1/)).toBeInTheDocument();

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    await user.click(dismissBtn);

    await waitFor(() => {
      expect(screen.queryByText('Audit Payload #101')).not.toBeInTheDocument();
    });

    // Reopen entry #102 (User #2) and close via header Close dialog button
    const inspectBtns2 = screen.getAllByRole('button', { name: /Inspect/i });
    await user.click(inspectBtns2[1]!);
    expect(await screen.findByText('Audit Payload #102')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('User #2');
    const closeDialogBtn = screen.getByRole('button', { name: 'Close dialog' });
    await user.click(closeDialogBtn);
    await waitFor(() => {
      expect(screen.queryByText('Audit Payload #102')).not.toBeInTheDocument();
    });

    // Inspect entry #103 (System)
    const inspectBtns3 = screen.getAllByRole('button', { name: /Inspect/i });
    await user.click(inspectBtns3[2]!);
    expect(await screen.findByText('Audit Payload #103')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('System');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByText('Audit Payload #103')).not.toBeInTheDocument();
    });
  });

  it('inspects an entry with null entity', async () => {
    const user = userEvent.setup();
    mockOf(api.activity.list).mockResolvedValue({
      entries: [
        {
          id: 200,
          userId: null,
          userName: null,
          userEmail: null,
          action: 'system.prune',
          entity: null,
          meta: { freed: '500MB' },
          ts: '2026-08-17T12:00:00.000Z',
        },
      ],
    });
    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getAllByText('system.prune').length).toBeGreaterThan(0);
    });

    const inspectBtn = screen.getByRole('button', { name: /Inspect/i });
    await user.click(inspectBtn);

    expect(await screen.findByText('Audit Payload #200')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('system.prune');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
  });

  it('exports filtered entries as JSON file', async () => {
    const user = userEvent.setup();
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    const createObjectURLMock = vi.fn(() => 'blob:mock-url');
    const revokeObjectURLMock = vi.fn();
    window.URL.createObjectURL = createObjectURLMock;
    window.URL.revokeObjectURL = revokeObjectURLMock;

    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getByText('Export JSON')).toBeInTheDocument();
    });

    const exportBtn = screen.getByRole('button', { name: /Export JSON/i });
    await user.click(exportBtn);

    expect(createObjectURLMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalled();
  });

  it('exports filtered entries as CSV file', async () => {
    const user = userEvent.setup();
    mockOf(api.activity.list).mockResolvedValue({ entries: sampleActivities });
    const createObjectURLMock = vi.fn(() => 'blob:mock-url');
    const revokeObjectURLMock = vi.fn();
    window.URL.createObjectURL = createObjectURLMock;
    window.URL.revokeObjectURL = revokeObjectURLMock;

    renderWithProviders(<Activity />);

    await waitFor(() => {
      expect(screen.getByText('Export CSV')).toBeInTheDocument();
    });

    const exportBtn = screen.getByRole('button', { name: /Export CSV/i });
    await user.click(exportBtn);

    expect(createObjectURLMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalled();
  });
});
