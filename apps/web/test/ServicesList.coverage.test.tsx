import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServicesList } from '../src/routes/ServicesList.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

vi.mock('../src/components/DeployWizard.js', () => ({
  DeployWizard: () => <div data-testid="deploy-wizard" />,
}));

vi.mock('../src/components/LanesModal.js', () => ({
  LanesModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="lanes-modal">
      <button type="button" onClick={onClose}>
        close lanes
      </button>
    </div>
  ),
}));

const services = [
  { id: 1, name: 'web-prod', slug: 'web-prod', type: 'docker', branch: 'main', port: 3000, status: 'running', environmentId: 7 },
  { id: 2, name: 'web-stage', slug: 'web-stage', type: 'docker', branch: 'dev', port: 3001, status: 'running', environmentId: 8 },
  { id: 3, name: 'loose', slug: 'loose', type: 'docker', branch: 'main', port: 3002, status: 'running', environmentId: null },
];
const lanes = [
  { id: 7, workspaceId: 1, name: 'production', slug: 'production', serviceCount: 1 },
  { id: 8, workspaceId: 1, name: 'staging', slug: 'staging', serviceCount: 1 },
];

describe('ServicesList: lanes and failed toggles', () => {
  beforeEach(() => {
    for (const fn of [api.services.list, api.services.stop, api.services.start, api.environments.list]) mockOf(fn as never).mockReset();
    mockOf(api.services.list).mockResolvedValue(services as never);
    mockOf(api.environments.list).mockResolvedValue(lanes as never);
  });

  it('filters the list by deployment lane; ungrouped services show only under all lanes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServicesList />);
    const select = await screen.findByLabelText('Filter by environment');
    expect(screen.getByRole('option', { name: 'production' })).toHaveValue('7');
    expect(screen.getByRole('option', { name: 'staging' })).toHaveValue('8');
    expect(screen.getAllByText('loose').length).toBeGreaterThan(0);

    await user.selectOptions(select, '8');
    expect(screen.getAllByText('web-stage').length).toBeGreaterThan(0);
    expect(screen.queryByText('web-prod')).not.toBeInTheDocument();
    expect(screen.queryByText('loose')).not.toBeInTheDocument();

    await user.selectOptions(select, 'all');
    expect(screen.getAllByText('web-prod').length).toBeGreaterThan(0);
    expect(screen.getAllByText('loose').length).toBeGreaterThan(0);
  });

  it('opens and closes the lanes manager', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServicesList />);
    await user.click(await screen.findByRole('button', { name: 'Manage deployment lanes' }));
    expect(screen.getByTestId('lanes-modal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'close lanes' }));
    expect(screen.queryByTestId('lanes-modal')).not.toBeInTheDocument();
  });

  it('re-enables the stop button when stopping fails', async () => {
    mockOf(api.services.list).mockResolvedValue([services[0]] as never);
    let reject!: (e: Error) => void;
    mockOf(api.services.stop).mockReturnValue(new Promise((_, r) => (reject = r)) as never);
    renderWithProviders(<ServicesList />);
    const stop = await screen.findByTitle('Stop service');
    fireEvent.click(stop);
    await waitFor(() => expect(api.services.stop).toHaveBeenCalledWith(1));
    await waitFor(() => expect(stop).toBeDisabled());
    reject(new Error('daemon unreachable'));
    await waitFor(() => expect(stop).toBeEnabled());
    expect(api.services.start).not.toHaveBeenCalled();
  });
});
