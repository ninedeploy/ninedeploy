import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForwardAuthCard } from '../src/routes/service/ForwardAuthCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const svc = { id: 5, serverId: null } as never;

describe('ForwardAuthCard — role changes and refusals', () => {
  beforeEach(() => {
    mockOf(api.domains.list).mockReset();
    mockOf(api.domains.forwardAuth.get).mockReset();
    mockOf(api.domains.forwardAuth.set).mockReset();
    mockOf(api.domains.list).mockResolvedValue([{ id: 11, hostname: 'grafana.example.com', path: '/admin', status: 'active' }] as never);
  });

  it('raises the least role of a protected domain and confirms it', async () => {
    mockOf(api.domains.forwardAuth.get).mockResolvedValue({ domainId: 11, forwardAuth: { minRole: 'viewer' } } as never);
    mockOf(api.domains.forwardAuth.set).mockResolvedValue({ domainId: 11, forwardAuth: { minRole: 'admin' } } as never);
    renderWithProviders(<ForwardAuthCard svc={svc} />);
    const role = await screen.findByLabelText('Least role for grafana.example.com/admin');
    await userEvent.selectOptions(role, 'admin');
    await waitFor(() => expect(api.domains.forwardAuth.set).toHaveBeenCalledWith(11, { minRole: 'admin' }));
    expect(await screen.findByText('grafana.example.com/admin is behind panel sign-in')).toBeInTheDocument();
    expect((screen.getByLabelText('Least role for grafana.example.com/admin') as HTMLSelectElement).value).toBe('admin');
  });

  it('opens a domain again, and shows the error when the change is refused', async () => {
    mockOf(api.domains.forwardAuth.get).mockResolvedValue({ domainId: 11, forwardAuth: { minRole: 'member' } } as never);
    mockOf(api.domains.forwardAuth.set)
      .mockRejectedValueOnce(new Error('Only admins can change sign-in'))
      .mockResolvedValueOnce({ domainId: 11, forwardAuth: null } as never);
    renderWithProviders(<ForwardAuthCard svc={svc} />);
    const toggle = await screen.findByRole('switch', { name: 'Panel sign-in for grafana.example.com/admin' });
    await userEvent.click(toggle);
    expect(await screen.findByText('Only admins can change sign-in')).toBeInTheDocument();
    expect(api.domains.forwardAuth.set).toHaveBeenLastCalledWith(11, null);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(await screen.findByText('grafana.example.com/admin is open again')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Least role for grafana.example.com/admin')).not.toBeInTheDocument());
  });
});
