import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorsCard } from '../src/routes/service/ErrorsCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const ISSUE = {
  id: 3,
  title: 'RangeError: Maximum call stack size exceeded',
  culprit: null,
  level: 'warning',
  status: 'unresolved',
  count: 2,
  firstSeen: '2026-10-28T09:00:00Z',
  lastSeen: '2026-10-28T10:00:00Z',
  firstRelease: null,
  firstDeploymentId: null,
  lastDeploymentId: null,
};

describe('ErrorsCard failures and ignore', () => {
  beforeEach(() => {
    mockOf(api.services.errors.list).mockReset().mockResolvedValue([] as never);
    mockOf(api.services.errors.get).mockReset().mockResolvedValue({ issue: ISSUE, events: [] } as never);
    mockOf(api.services.errors.setStatus).mockReset();
    for (const fn of Object.values(api.services.errors.ingest)) mockOf(fn as never).mockReset();
    mockOf(api.services.errors.ingest.get).mockResolvedValue({ enabled: false, createdAt: null } as never);
  });

  it('reports a DSN that could not be created and shows no DSN', async () => {
    mockOf(api.services.errors.ingest.create).mockRejectedValue(new Error('error ingest is disabled'));
    renderWithProviders(<ErrorsCard serviceId={5} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create DSN' }));
    expect(await screen.findByText('error ingest is disabled')).toBeInTheDocument();
    expect(screen.queryByText('Copy the DSN now; it is not shown again.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create DSN' })).toBeInTheDocument();
  });

  it('ignores an issue and reports a failed status change', async () => {
    mockOf(api.services.errors.ingest.get).mockResolvedValue({ enabled: true, createdAt: 'x' } as never);
    mockOf(api.services.errors.list).mockResolvedValue([ISSUE] as never);
    mockOf(api.services.errors.setStatus).mockRejectedValue(new Error('issue is locked'));
    renderWithProviders(<ErrorsCard serviceId={5} />);
    await userEvent.click(await screen.findByText(ISSUE.title));
    await waitFor(() => expect(api.services.errors.get).toHaveBeenCalledWith(5, 3));
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(api.services.errors.setStatus).toHaveBeenCalledWith(5, 3, 'ignored'));
    expect(await screen.findByText('issue is locked')).toBeInTheDocument();
  });
});
