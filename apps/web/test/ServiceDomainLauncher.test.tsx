import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServiceDomainLauncher } from '../src/components/ServiceDomainLauncher.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

vi.mock('../src/lib/api.js', async () => {
  // Must be './apiMock.js', not './helpers.js' — see the note in apiMock.ts.
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

describe('ServiceDomainLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays hidden when the service has no domain', async () => {
    mockOf(api.domains.all).mockResolvedValue([] as never);
    renderWithProviders(<ServiceDomainLauncher serviceId={1} serviceName="api" />);
    await waitFor(() => expect(api.domains.all).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Open api domain/ })).not.toBeInTheDocument();
  });

  it('confirms a single HTTPS destination before opening it in a new tab', async () => {
    const user = userEvent.setup();
    mockOf(api.domains.all).mockResolvedValue([
      { id: 10, serviceId: 1, hostname: 'api.example.com', path: '/docs', ssl: true },
    ] as never);
    renderWithProviders(<ServiceDomainLauncher serviceId={1} serviceName="api" />);

    await user.click(await screen.findByRole('button', { name: 'Open api domain' }));
    expect(screen.getByRole('dialog', { name: 'Open api' })).toBeInTheDocument();
    expect(screen.getByText('This page will open in a new tab.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open https://api.example.com/docs in a new tab' });
    expect(link).toHaveAttribute('href', 'https://api.example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');

    // The dialog backdrop closes the modal.
    fireEvent.click(screen.getAllByLabelText('Close dialog')[0]!);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open api' })).not.toBeInTheDocument());
  });

  it('lists every service domain and preserves HTTP routes', async () => {
    const user = userEvent.setup();
    mockOf(api.domains.all).mockResolvedValue([
      { id: 10, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: true },
      { id: 11, serviceId: 1, hostname: 'internal.example.com', path: '/admin', ssl: false },
      { id: 12, serviceId: 2, hostname: 'other.example.com', path: '/', ssl: true },
    ] as never);
    renderWithProviders(<ServiceDomainLauncher serviceId={1} serviceName="app" />);

    const trigger = await screen.findByRole('button', { name: 'Open app domains' });
    expect(trigger).toHaveTextContent('2');
    await user.click(trigger);
    expect(screen.getByText('Choose the page to open in a new tab.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open https://app.example.com in a new tab' })).toHaveAttribute('href', 'https://app.example.com');
    expect(screen.getByRole('link', { name: 'Open http://internal.example.com/admin in a new tab' })).toHaveAttribute('href', 'http://internal.example.com/admin');
    expect(screen.queryByText(/other\.example\.com/)).not.toBeInTheDocument();

    // Following a link closes the modal behind it.
    await user.click(screen.getByRole('link', { name: 'Open https://app.example.com in a new tab' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Open app' })).not.toBeInTheDocument());
  });

  it('normalizes paths without a leading slash and marks wildcard hostnames', async () => {
    const user = userEvent.setup();
    mockOf(api.domains.all).mockResolvedValue([
      { id: 13, serviceId: 3, hostname: '*.wild.example.com', path: 'app', ssl: true },
      { id: 14, serviceId: 3, hostname: 'plain.example.com', path: 'app', ssl: true },
    ] as never);
    renderWithProviders(<ServiceDomainLauncher serviceId={3} serviceName="multi" label />);

    // label=true renders the "Open site" caption next to the icon.
    const trigger = await screen.findByRole('button', { name: 'Open multi domains' });
    expect(trigger).toHaveTextContent('Open site');
    await user.click(trigger);

    // A path without a leading slash is normalized to '/app'.
    const plain = screen.getByRole('link', { name: 'Open https://plain.example.com/app in a new tab' });
    expect(plain).toHaveAttribute('href', 'https://plain.example.com/app');

    // A wildcard hostname cannot be opened directly — it gets a hint instead.
    expect(screen.getByTitle('Use a concrete hostname covered by this wildcard')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /wild\.example\.com/ })).not.toBeInTheDocument();
  });
});

