import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MaintenanceCard } from '../src/routes/service/MaintenanceCard.js';
import { api } from '../src/lib/api.js';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

const svc = { id: 5, type: 'docker', serverId: null } as never;
const ON = {
  maintenance: { title: 'Upgrading', message: 'Back at noon.', retryAfterSeconds: 300, bypass: ['203.0.113.7', '10.0.0.0/8'] },
  since: '2026-10-28T10:00:00.000Z',
};

describe('MaintenanceCard (coverage)', () => {
  beforeEach(() => {
    mockOf(api.services.maintenance.get).mockReset().mockResolvedValue({ maintenance: null, since: null } as never);
    mockOf(api.services.maintenance.set).mockReset();
    mockOf(api.services.errorPages.get).mockReset().mockResolvedValue({ pages: {} } as never);
    mockOf(api.services.errorPages.set).mockReset();
  });

  it('loads the live page, updates its title and message, and toasts that it is on', async () => {
    mockOf(api.services.maintenance.get).mockResolvedValue(ON as never);
    mockOf(api.services.maintenance.set).mockResolvedValue({ ...ON, maintenance: { ...ON.maintenance, title: 'Database move' } } as never);
    renderWithProviders(<MaintenanceCard svc={svc} />);
    const title = await screen.findByDisplayValue('Upgrading');
    expect(screen.getByLabelText('Bypass addresses')).toHaveValue('203.0.113.7\n10.0.0.0/8');
    expect(screen.getByText(/^On since /)).toBeInTheDocument();
    await userEvent.clear(title);
    await userEvent.type(title, 'Database move');
    const message = screen.getByLabelText('Message');
    await userEvent.clear(message);
    await userEvent.type(message, 'Back at one.');
    await userEvent.click(screen.getByRole('button', { name: 'Update the page' }));
    await waitFor(() =>
      expect(api.services.maintenance.set).toHaveBeenCalledWith(5, { title: 'Database move', message: 'Back at one.', bypass: ['203.0.113.7', '10.0.0.0/8'] }),
    );
    expect(await screen.findByText('Maintenance mode is on')).toBeInTheDocument();
  });

  it('turns maintenance off with a null config and toasts that it is off', async () => {
    mockOf(api.services.maintenance.get).mockResolvedValue(ON as never);
    mockOf(api.services.maintenance.set).mockResolvedValue({ maintenance: null, since: null } as never);
    renderWithProviders(<MaintenanceCard svc={svc} />);
    const toggle = await screen.findByRole('switch', { name: 'Maintenance mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    await waitFor(() => expect(api.services.maintenance.set).toHaveBeenCalledWith(5, null));
    expect(await screen.findByText('Maintenance mode is off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update the page' })).not.toBeInTheDocument();
  });

  it('shows a rejected maintenance change as an error toast', async () => {
    mockOf(api.services.maintenance.set).mockRejectedValue(new Error('bypass entry is not an address'));
    renderWithProviders(<MaintenanceCard svc={svc} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Maintenance mode' }));
    expect(await screen.findByText('bypass entry is not an address')).toBeInTheDocument();
  });

  it('edits the 503 and 504 pages on their own tabs, marks filled tabs, and toasts on save', async () => {
    mockOf(api.services.errorPages.get).mockResolvedValue({ pages: { '502': '<p>bad gateway</p>' } } as never);
    mockOf(api.services.errorPages.set).mockImplementation(async (_id, pages) => ({ pages }) as never);
    renderWithProviders(<MaintenanceCard svc={svc} />);
    expect(await screen.findByLabelText('HTML for 502')).toHaveValue('<p>bad gateway</p>');
    expect(screen.getByRole('tab', { name: '502 •' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: '503' }));
    expect(screen.getByRole('tab', { name: '503' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.type(screen.getByLabelText('HTML for 503'), '<p>busy</p>');
    await userEvent.click(screen.getByRole('tab', { name: '504' }));
    await userEvent.type(screen.getByLabelText('HTML for 504'), '<p>slow</p>');
    expect(screen.getByRole('tab', { name: '503 •' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save error pages' }));
    await waitFor(() =>
      expect(api.services.errorPages.set).toHaveBeenCalledWith(5, { '502': '<p>bad gateway</p>', '503': '<p>busy</p>', '504': '<p>slow</p>' }),
    );
    expect(await screen.findByText('Error pages saved')).toBeInTheDocument();
  });

  it('shows a rejected error-page save as an error toast', async () => {
    mockOf(api.services.errorPages.set).mockRejectedValue(new Error('page is larger than 64 KiB'));
    renderWithProviders(<MaintenanceCard svc={svc} />);
    await userEvent.type(await screen.findByLabelText('HTML for 502'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save error pages' }));
    expect(await screen.findByText('page is larger than 64 KiB')).toBeInTheDocument();
  });
});
