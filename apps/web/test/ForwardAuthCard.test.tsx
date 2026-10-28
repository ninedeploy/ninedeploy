import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForwardAuthCard } from '../src/routes/service/ForwardAuthCard.js';
import { ForwardAuthPage } from '../src/routes/forwardAuth/ForwardAuthPage.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('ForwardAuthCard (G2.3)', () => {
  it('puts a domain behind panel sign-in', async () => {
    mockOf(api.domains.list).mockResolvedValue([{ id: 11, hostname: 'grafana.example.com', path: '/', status: 'active' }] as never);
    mockOf(api.domains.forwardAuth.get).mockResolvedValue({ domainId: 11, forwardAuth: null } as never);
    mockOf(api.domains.forwardAuth.set).mockResolvedValue({ domainId: 11, forwardAuth: { minRole: 'viewer' } } as never);
    renderWithProviders(<ForwardAuthCard svc={{ id: 5, serverId: null } as never} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Panel sign-in for grafana.example.com' }));
    await waitFor(() => expect(api.domains.forwardAuth.set).toHaveBeenCalledWith(11, { minRole: 'viewer' }));
    expect(await screen.findByLabelText('Least role for grafana.example.com')).toBeTruthy();
  });
});

describe('ForwardAuthPage (G2.3)', () => {
  it('reports an incomplete link instead of calling the grant', async () => {
    renderWithProviders(<ForwardAuthPage />, { route: '/forward-auth?d=11' });
    expect(await screen.findByText('This sign-in link is incomplete. Open the protected page again.')).toBeTruthy();
    expect(api.domains.forwardAuth.grant).not.toHaveBeenCalled();
  });

  it('shows why the grant was refused', async () => {
    mockOf(api.domains.forwardAuth.grant).mockRejectedValue(new Error('Entering grafana.example.com needs the "admin" role'));
    renderWithProviders(<ForwardAuthPage />, { route: '/forward-auth?d=11&rd=https%3A%2F%2Fgrafana.example.com%2F&state=abcdefghijklmnopqrstuv' });
    expect(await screen.findByText('Entering grafana.example.com needs the "admin" role')).toBeTruthy();
    expect(api.domains.forwardAuth.grant).toHaveBeenCalledWith({ domainId: 11, returnTo: 'https://grafana.example.com/', state: 'abcdefghijklmnopqrstuv' });
  });
});
