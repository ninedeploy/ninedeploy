import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorsCard } from '../src/routes/service/ErrorsCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const ISSUE = {
  id: 3,
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  culprit: 'handler (app)',
  level: 'error',
  status: 'unresolved',
  count: 12,
  firstSeen: '2026-10-28T09:00:00Z',
  lastSeen: '2026-10-28T10:00:00Z',
  firstRelease: 'aaaaaaa',
  firstDeploymentId: 40,
  lastDeploymentId: 41,
};

describe('ErrorsCard (G5.4)', () => {
  it('shows the DSN once when it is created', async () => {
    mockOf(api.services.errors.ingest.create).mockResolvedValue({ enabled: true, createdAt: 'x', dsn: 'https://k@panel.example.com/5' } as never);
    renderWithProviders(<ErrorsCard serviceId={5} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create DSN' }));
    expect(await screen.findByText('https://k@panel.example.com/5')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace DSN' })).toBeTruthy();
  });

  it('lists issues with the deploy that introduced them, shows the stack and resolves one', async () => {
    mockOf(api.services.errors.ingest.get).mockResolvedValue({ enabled: true, createdAt: 'x' } as never);
    mockOf(api.services.errors.list).mockResolvedValue([ISSUE] as never);
    mockOf(api.services.errors.get).mockResolvedValue({
      issue: ISSUE,
      events: [{ id: 1, eventId: null, release: null, environment: null, deploymentId: 41, receivedAt: 'x', payload: { exception: { values: [{ stacktrace: { frames: [{ function: 'handler', filename: '/app/src/app.js', lineno: 10 }] } }] } } }],
    } as never);
    mockOf(api.services.errors.setStatus).mockResolvedValue({ ...ISSUE, status: 'resolved' } as never);
    renderWithProviders(<ErrorsCard serviceId={5} />);
    expect(await screen.findByText(/since deploy #40/)).toBeTruthy();
    await userEvent.click(screen.getByText(ISSUE.title));
    expect(await screen.findByText('handler — /app/src/app.js:10')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(api.services.errors.setStatus).toHaveBeenCalledWith(5, 3, 'resolved'));
  });
});
