import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * 0.16.11: the Settings → Sleep when idle card. Self-contained like
 * CanaryCard.test.tsx (no `./helpers.js`).
 */

const apiMock = vi.hoisted(() => ({ api: { services: { update: vi.fn() }, domains: { list: vi.fn() } } }));
vi.mock('../src/lib/api.js', () => apiMock);

import { SleepCard, parseSleepMinutes } from '../src/routes/service/SleepCard.js';

const ACTIVE_DOMAIN = { id: 1, hostname: 'app.example.com', status: 'active' };

function serviceWith(over: Record<string, unknown>) {
  return { id: 4, name: 'api', slug: 'api', type: 'docker', serverId: null, sleepAfterMinutes: null, asleepAt: null, ...over };
}

function cardTree(svc: ReturnType<typeof serviceWith>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>
          <SleepCard svc={svc as never} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const renderCard = (svc: ReturnType<typeof serviceWith>) => render(cardTree(svc));

describe('parseSleepMinutes', () => {
  it('takes a whole number of minutes from 5 to 1440', () => {
    expect(parseSleepMinutes('5')).toBe(5);
    expect(parseSleepMinutes(' 30 ')).toBe(30);
    expect(parseSleepMinutes('1440')).toBe(1440);
  });

  it('refuses anything else', () => {
    for (const v of ['', '4', '1441', '10.5', '-5', 'abc', '1e2']) expect(parseSleepMinutes(v)).toBeNull();
  });
});

describe('SleepCard', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.services.update.mockResolvedValue({});
    apiMock.api.domains.list.mockResolvedValue([ACTIVE_DOMAIN]);
  });

  it('is hidden for a non-docker service and on a panel that does not report the field', () => {
    const { rerender } = renderCard(serviceWith({ type: 'compose' }));
    expect(screen.queryByText('Sleep when idle')).not.toBeInTheDocument();
    const older: Record<string, unknown> = serviceWith({});
    delete older.sleepAfterMinutes;
    rerender(cardTree(older as ReturnType<typeof serviceWith>));
    expect(screen.queryByText('Sleep when idle')).not.toBeInTheDocument();
    // Hidden, it does not load the domains either.
    expect(apiMock.api.domains.list).not.toHaveBeenCalled();
  });

  it('turns on from 15 minutes and saves them', async () => {
    renderCard(serviceWith({}));
    const save = screen.getByRole('button', { name: 'Save sleep setting' });
    // Off with nothing stored: nothing to save.
    expect(save).toBeDisabled();
    expect(screen.queryByLabelText('Sleep after (minutes)')).not.toBeInTheDocument();
    expect(screen.getByText(/the visitor waits a few seconds for that first page/)).toBeInTheDocument();
    expect(screen.getByText(/Host ports and the service's internal network do not count as requests/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Traefik → Traffic' })).toHaveAttribute('href', '/traefik');
    await waitFor(() => expect(apiMock.api.domains.list).toHaveBeenCalledWith(4));
    expect(screen.queryByText(/has no active domain/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Sleep when idle' }));
    expect(screen.getByLabelText('Sleep after (minutes)')).toHaveValue('15');
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { sleepAfterMinutes: 15 }));
    expect(await screen.findByText('Sleep when idle saved — it sleeps after 15 minutes without a request')).toBeInTheDocument();
  });

  it('shows a stored window, names the range of a bad one and does not save it', async () => {
    renderCard(serviceWith({ sleepAfterMinutes: 45 }));
    expect(screen.getByRole('switch', { name: 'Sleep when idle' })).toHaveAttribute('aria-checked', 'true');
    const input = screen.getByLabelText('Sleep after (minutes)');
    expect(input).toHaveValue('45');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getByText('A whole number of minutes, 5–1440')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const save = screen.getByRole('button', { name: 'Save sleep setting' });
    expect(save).toBeDisabled();
    // Enter in a field submits the form even with the button disabled in some browsers.
    fireEvent.submit(save.closest('form')!);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMock.api.services.update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { sleepAfterMinutes: 90 }));
  });

  it('turns a stored window off with null', async () => {
    renderCard(serviceWith({ sleepAfterMinutes: 30 }));
    fireEvent.click(screen.getByRole('switch', { name: 'Sleep when idle' }));
    expect(screen.queryByLabelText('Sleep after (minutes)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save sleep setting' }));
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { sleepAfterMinutes: null }));
    expect(await screen.findByText('Sleep when idle turned off')).toBeInTheDocument();
  });

  it("shows the server's message when the save is refused, and a fallback without one", async () => {
    apiMock.api.services.update.mockRejectedValueOnce(new Error('Scale to zero is for docker services')).mockRejectedValueOnce(new Error(''));
    renderCard(serviceWith({ sleepAfterMinutes: 30 }));
    const save = screen.getByRole('button', { name: 'Save sleep setting' });
    fireEvent.click(save);
    expect(await screen.findByText('Scale to zero is for docker services')).toBeInTheDocument();
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    expect(await screen.findByText('Could not save the sleep setting')).toBeInTheDocument();
  });

  it('holds the button while saving', async () => {
    apiMock.api.services.update.mockReturnValueOnce(new Promise(() => {}));
    renderCard(serviceWith({ sleepAfterMinutes: 30 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save sleep setting' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('warns in amber when no active domain could wake the service', async () => {
    apiMock.api.domains.list.mockResolvedValue([{ ...ACTIVE_DOMAIN, status: 'pending' }]);
    renderCard(serviceWith({}));
    const note = await screen.findByText(/has no active domain, so no request could wake it/);
    expect(note).toHaveClass('text-amber-300');
    cleanup();
    apiMock.api.domains.list.mockResolvedValue([]);
    renderCard(serviceWith({}));
    expect(await screen.findByText(/has no active domain/)).toBeInTheDocument();
  });

  it('says a service on a node or on Swarm does not sleep', () => {
    renderCard(serviceWith({ serverId: 2 }));
    expect(screen.getByText(/runs on a node, so it does not sleep for now/)).toBeInTheDocument();
    cleanup();
    renderCard(serviceWith({ placement: { orchestrator: 'swarm' } }));
    expect(screen.getByText(/runs on Swarm; scale to zero does not apply to it/)).toBeInTheDocument();
  });
});
