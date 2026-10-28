import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployFreezeSection } from '../src/routes/settings/DeployFreezeSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const FREEZE = {
  id: 'f1',
  scope: 'environment',
  targetId: 1,
  targetName: 'production',
  reason: 'release week',
  until: null,
  createdAt: '2026-10-28T09:00:00.000Z',
  createdBy: 'Ops',
};

describe('DeployFreezeSection (G5.5)', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.deployFreezes)) mockOf(fn as never).mockReset();
  });

  it('freezes an environment with a reason', async () => {
    mockOf(api.deployFreezes.list).mockResolvedValue([] as never);
    mockOf(api.environments.list).mockResolvedValue([{ id: 1, name: 'production', workspaceId: 1 }] as never);
    mockOf(api.deployFreezes.create).mockResolvedValue(FREEZE as never);
    renderWithProviders(<DeployFreezeSection />);
    expect(await screen.findByText('No freeze is in force; deploys run normally.')).toBeInTheDocument();
    const freeze = screen.getByRole('button', { name: 'Freeze deploys' });
    expect(freeze).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'environment');
    await userEvent.selectOptions(await screen.findByLabelText('Environment'), await screen.findByRole('option', { name: 'production' }));
    await userEvent.type(screen.getByLabelText('Reason'), 'release week');
    await userEvent.click(freeze);
    await waitFor(() =>
      expect(api.deployFreezes.create).toHaveBeenCalledWith({ scope: 'environment', targetId: 1, reason: 'release week', until: null }),
    );
  });

  it('lists freezes in force and lifts one', async () => {
    mockOf(api.deployFreezes.list).mockResolvedValue([FREEZE] as never);
    mockOf(api.deployFreezes.lift).mockResolvedValue(FREEZE as never);
    renderWithProviders(<DeployFreezeSection />);
    expect(await screen.findByText('Environment: production')).toBeInTheDocument();
    expect(screen.getByText('release week')).toBeInTheDocument();
    expect(screen.getByText('until lifted')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lift' }));
    await waitFor(() => expect(api.deployFreezes.lift).toHaveBeenCalledWith('f1'));
  });
});
