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

  it('requires a new target after changing scope and preserves the reason after a failed freeze', async () => {
    mockOf(api.deployFreezes.list).mockResolvedValue([] as never);
    mockOf(api.workspaces.list).mockResolvedValue([{ id: 2, name: 'team' }] as never);
    mockOf(api.projects.list).mockResolvedValue([{ id: 3, name: 'shop' }] as never);
    mockOf(api.deployFreezes.create).mockRejectedValue(new Error('permission denied'));
    renderWithProviders(<DeployFreezeSection />);
    await userEvent.type(await screen.findByLabelText('Reason'), 'incident');
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'workspace');
    await userEvent.selectOptions(await screen.findByLabelText('Workspace'), await screen.findByRole('option', { name: 'team' }));
    expect(screen.getByRole('button', { name: 'Freeze deploys' })).toBeEnabled();
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    expect(screen.getByRole('button', { name: 'Freeze deploys' })).toBeDisabled();
    await userEvent.selectOptions(await screen.findByLabelText('Project'), await screen.findByRole('option', { name: 'shop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Freeze deploys' }));
    expect(await screen.findByText('Could not freeze deploys: permission denied')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveValue('incident');
    expect(api.deployFreezes.create).toHaveBeenCalledWith({ scope: 'project', targetId: 3, reason: 'incident', until: null });
  });

  it('keeps a freeze visible if lifting it fails', async () => {
    mockOf(api.deployFreezes.list).mockResolvedValue([FREEZE] as never);
    mockOf(api.deployFreezes.lift).mockRejectedValue(new Error('not permitted'));
    renderWithProviders(<DeployFreezeSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Lift' }));
    expect(await screen.findByText('Could not lift the freeze: not permitted')).toBeInTheDocument();
    expect(screen.getByText('release week')).toBeInTheDocument();
  });
});
