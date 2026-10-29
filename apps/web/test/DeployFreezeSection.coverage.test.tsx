import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeployFreezeSection } from '../src/routes/settings/DeployFreezeSection.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('DeployFreezeSection: end time and load errors', () => {
  beforeEach(() => {
    for (const fn of Object.values(api.deployFreezes)) mockOf(fn as never).mockReset();
  });

  it('sends the chosen end time as ISO and clears the form after freezing', async () => {
    mockOf(api.deployFreezes.list).mockResolvedValue([] as never);
    mockOf(api.deployFreezes.create).mockResolvedValue({} as never);
    renderWithProviders(<DeployFreezeSection />);
    await userEvent.type(await screen.findByLabelText('Reason'), 'holidays');
    const ends = screen.getByLabelText('Ends');
    fireEvent.change(ends, { target: { value: '2026-12-24T18:00' } });
    expect(ends).toHaveValue('2026-12-24T18:00');
    await userEvent.click(screen.getByRole('button', { name: 'Freeze deploys' }));
    await waitFor(() =>
      expect(api.deployFreezes.create).toHaveBeenCalledWith({
        scope: 'instance',
        targetId: null,
        reason: 'holidays',
        until: new Date('2026-12-24T18:00').toISOString(),
      }),
    );
    expect(await screen.findByText('Deploys frozen')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveValue('');
    expect(screen.getByLabelText('Ends')).toHaveValue('');
  });

  it('shows a load error and refetches on retry', async () => {
    mockOf(api.deployFreezes.list).mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue([] as never);
    renderWithProviders(<DeployFreezeSection />);
    expect(await screen.findByText('Could not load deploy freezes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No freeze is in force; deploys run normally.')).toBeInTheDocument();
    expect(api.deployFreezes.list).toHaveBeenCalledTimes(2);
  });
});
