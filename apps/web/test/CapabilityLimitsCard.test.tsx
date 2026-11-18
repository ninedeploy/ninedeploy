import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CapabilityLimitsCard } from '../src/routes/service/CapabilityLimitsCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const ok = { status: 'available', reason: null };

// C1: the service's limits where it runs, with the server's reasons.
describe('CapabilityLimitsCard', () => {
  it('shows node sleep conditions as limited, with the server reason', async () => {
    mockOf(api.services.capabilities).mockResolvedValueOnce({
      serviceId: 5,
      runtime: 'node-docker',
      capabilities: {
        maintenance: { status: 'unavailable', reason: 'Maintenance mode is for services on the panel host for now' },
        errorPages: ok, forwardAuth: ok, restartLimit: ok, inlineDockerfile: ok, fileMounts: ok, canary: ok,
        autoscale: { status: 'limited', reason: 'On a node, requests per second needs an agent with proxy traffic' },
        scaleToZero: { status: 'limited', reason: 'On a node, automatic sleep needs continuous idle observation and wake catcher capabilities' },
      },
    } as never);
    renderWithProviders(<CapabilityLimitsCard serviceId={5} />);
    await userEvent.click(await screen.findByText('3 features are limited or unavailable for this service'));
    expect(screen.getByText('Maintenance mode')).toBeInTheDocument();
    expect(screen.getByText('Not here')).toBeInTheDocument();
    expect(screen.getAllByText('Limited')).toHaveLength(2);
    expect(screen.queryByText('Coming')).not.toBeInTheDocument();
    expect(screen.getByText(/continuous idle observation and wake catcher capabilities/)).toBeInTheDocument();
    expect(screen.queryByText('Canary releases')).not.toBeInTheDocument();
  });

  it('keeps the Coming label for capabilities actually advertised as in progress', async () => {
    mockOf(api.services.capabilities).mockResolvedValueOnce({
      serviceId: 5, runtime: 'node-docker', capabilities: {
        maintenance: ok, errorPages: ok, forwardAuth: ok, restartLimit: ok, fileMounts: ok,
        autoscale: ok, scaleToZero: ok, canary: ok,
        inlineDockerfile: { status: 'in_progress', reason: 'A future runtime capability is under acceptance' },
      },
    } as never);
    renderWithProviders(<CapabilityLimitsCard serviceId={5} />);
    await userEvent.click(await screen.findByText('1 features are limited or unavailable for this service'));
    expect(screen.getByText('Coming')).toBeInTheDocument();
    expect(screen.getByText('A future runtime capability is under acceptance')).toBeInTheDocument();
  });

  it('renders nothing when everything is available', async () => {
    const { container } = renderWithProviders(<CapabilityLimitsCard serviceId={7} />);
    await waitFor(() => expect(api.services.capabilities).toHaveBeenCalledWith(7));
    expect(container.textContent).toBe('');
  });
});
