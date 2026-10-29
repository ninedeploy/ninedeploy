import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoveWithDataCard } from '../src/routes/service/MoveWithDataCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
// Moving between hosts is operator-only.
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: ReactNode }) => children,
  useAuth: () => ({ user: { id: 1, email: 'admin@test', name: 'Admin', isOperator: true }, loading: false }),
}));

const svc = (status: string) => ({ id: 5, type: 'docker', orchestrator: null, volumeMount: '/data', serverId: null, status }) as never;

describe('MoveWithDataCard (G3.1)', () => {
  it('moves a stopped service to the chosen node', async () => {
    mockOf(api.servers.list).mockResolvedValue([{ id: 3, name: 'edge-1' }] as never);
    mockOf(api.services.move.start).mockResolvedValue({ state: 'running', from: null, to: 3, step: 'copying', error: null, startedAt: 'x', finishedAt: null, deploymentId: null } as never);
    renderWithProviders(<MoveWithDataCard svc={svc('stopped')} />);
    expect(await screen.findByText('Move with data')).toBeTruthy();
    await screen.findByRole('option', { name: 'edge-1' });
    fireEvent.change(screen.getByLabelText('Move to'), { target: { value: '3' } });
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(api.services.move.start).toHaveBeenCalledWith(5, 3));
    expect(await screen.findByText(/Moving from this panel host to edge-1/)).toBeTruthy();
  });

  it('asks to stop a running service first', async () => {
    renderWithProviders(<MoveWithDataCard svc={svc('running')} />);
    expect(await screen.findByText('Stop the service to move it with its data.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers a compose stack the move and counts the volumes it copies', async () => {
    mockOf(api.services.move.get).mockResolvedValue({
      state: 'running', from: null, to: 3, step: 'copying', error: null, startedAt: 'x', finishedAt: null, deploymentId: null,
      volumes: ['ndcmp-shop_db', 'ndcmp-shop_uploads'], copied: 1,
    } as never);
    renderWithProviders(<MoveWithDataCard svc={{ id: 8, type: 'compose', orchestrator: null, volumeMount: null, serverId: null, status: 'stopped' } as never} />);
    expect(await screen.findByText(/copies every named volume compose made for it/)).toBeTruthy();
    expect(await screen.findByText(/copying the data \(1 of 2 volumes\)/)).toBeTruthy();
  });

  it('is hidden for a service without a data volume', () => {
    const { container } = renderWithProviders(<MoveWithDataCard svc={{ id: 6, type: 'docker', volumeMount: null } as never} />);
    expect(container.textContent).toBe('');
  });
});
