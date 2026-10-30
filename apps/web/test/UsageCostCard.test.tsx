import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageCostCard } from '../src/components/UsageCostCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const figures = (cpu: number, cost: number | null) => ({ cpuCoreHours: cpu, memoryGbHours: 2, diskGbHours: 7.5, egressGb: 0.5, requests: 1200, cost });
const REPORT = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-31T00:00:00.000Z',
  days: 30,
  currency: 'EUR',
  historyDays: 30,
  trafficAnalytics: true,
  services: [
    { serviceId: 1, name: 'api', serverId: null, serverName: 'Panel host', projects: [], workspaces: [], ...figures(4, 18) },
    { serviceId: 2, name: 'edge', serverId: 9, serverName: 'node-x', projects: [], workspaces: [], ...figures(0, null) },
  ],
  projects: [{ id: 3, name: 'Shop', services: 2, ...figures(4, 18) }],
  workspaces: [{ id: 4, name: 'Acme', services: 1, ...figures(4, 18) }],
  servers: [
    { serverId: null, name: 'Panel host', monthlyCost: 18, periodCost: 18, unallocated: 0, cpuCoreHours: 4, memoryGbHours: 2 },
    { serverId: 9, name: 'node-x', monthlyCost: 5, periodCost: 5, unallocated: 5, cpuCoreHours: 0, memoryGbHours: 0 },
  ],
  totals: figures(4, 18),
};

describe('UsageCostCard (ROADMAP item 9)', () => {
  beforeEach(() => {
    mockOf(api.usage.report).mockReset().mockResolvedValue(REPORT as never);
    mockOf(api.usage.setCosts).mockReset();
  });

  it('shows usage per service with the total, and per project or workspace', async () => {
    renderWithProviders(<UsageCostCard />);
    const api1 = (await screen.findByText('api')).closest('tr')!;
    expect(within(api1).getByText('Panel host')).toBeInTheDocument();
    expect(within(api1).getByText('18 EUR')).toBeInTheDocument();
    expect(within(api1).getByText(/^7[.,]5$/)).toBeInTheDocument();
    expect(within((screen.getByText('edge')).closest('tr')!).getByText('—')).toBeInTheDocument();
    expect(within(screen.getByText('Total').closest('tr')!).getByText('18 EUR')).toBeInTheDocument();
    expect(screen.getByText('Not carried by any service: node-x 5 EUR')).toBeInTheDocument();
    expect(api.usage.report).toHaveBeenCalledWith({ days: 30 });

    await userEvent.selectOptions(screen.getByLabelText('Group by'), 'projects');
    expect(await screen.findByText('Shop')).toBeInTheDocument();
    expect(screen.getByText('2 services')).toBeInTheDocument();
    expect(screen.getByText(/groups do not add up/)).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Group by'), 'workspaces');
    expect(await screen.findByText('Acme')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Window'), '7');
    await waitFor(() => expect(api.usage.report).toHaveBeenCalledWith({ days: 7 }));
  });

  it('warns when the window is longer than the kept history or traffic analytics is off; an empty report says so', async () => {
    mockOf(api.usage.report).mockResolvedValue({ ...REPORT, days: 90, historyDays: 1, trafficAnalytics: false, services: [], servers: [] } as never);
    renderWithProviders(<UsageCostCard />);
    expect(await screen.findByText(/Resource history is kept for 1 days/)).toBeInTheDocument();
    expect(screen.getByText(/Traffic analytics is off/)).toBeInTheDocument();
    expect(screen.getByText('Nothing to show yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Not carried by any service/)).not.toBeInTheDocument();
  });

  it('an unreadable report says so', async () => {
    mockOf(api.usage.report).mockRejectedValue(new Error('boom'));
    renderWithProviders(<UsageCostCard />);
    expect(await screen.findByText('Usage could not be read')).toBeInTheDocument();
  });

  it('edits the server costs: an empty field leaves a server unpriced, bad input cannot be sent, a refusal is reported', async () => {
    mockOf(api.usage.setCosts).mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce({ currency: 'USD', servers: [] } as never);
    renderWithProviders(<UsageCostCard />);
    await screen.findByText('api');
    await userEvent.click(screen.getByRole('button', { name: 'Server costs' }));
    const form = screen.getByRole('form', { name: 'Server costs' });
    const host = within(form).getByLabelText('Monthly cost of Panel host');
    expect(host).toHaveValue('18');
    await userEvent.clear(host);
    await userEvent.type(host, '-3');
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(host);
    await userEvent.type(host, '40');
    await userEvent.clear(within(form).getByLabelText('Monthly cost of node-x'));
    const currency = within(form).getByDisplayValue('EUR');
    await userEvent.clear(currency);
    await userEvent.type(currency, 'us');
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.type(currency, 'd');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.usage.setCosts).toHaveBeenCalledWith({ currency: 'USD', servers: [{ serverId: null, monthlyCost: 40 }] }));
    expect(screen.getByRole('form', { name: 'Server costs' })).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Server costs' })).not.toBeInTheDocument());
  });
});
