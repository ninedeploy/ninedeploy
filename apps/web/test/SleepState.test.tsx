import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/Toast.js';

/** 0.16.11: the asleep badge and the Wake now / Sleep now actions of the service header. */

vi.mock('../src/lib/sleepApi.js', async () => ({
  sleepApi: (await import('./apiMock.js')).createSleepApiMock(),
}));

import { sleepApi } from '../src/lib/sleepApi.js';
import { ServiceStatusBadge, SleepActions, asleepTitle, isAsleep } from '../src/routes/service/SleepState.js';

const wake = vi.mocked(sleepApi.wake);
const sleep = vi.mocked(sleepApi.sleep);

const ASLEEP_AT = new Date(Date.now() - 5 * 60_000).toISOString();

function svcWith(over: Record<string, unknown> = {}) {
  return { id: 9, type: 'docker', status: 'running', sleepAfterMinutes: 15, asleepAt: null, ...over } as never;
}

function renderTree(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe('isAsleep / asleepTitle', () => {
  it('reads a running service with asleepAt as asleep', () => {
    expect(isAsleep({ status: 'running', asleepAt: ASLEEP_AT })).toBe(true);
    expect(isAsleep({ status: 'running', asleepAt: null })).toBe(false);
    expect(isAsleep({ status: 'running' })).toBe(false);
    // A stopped service is stopped, whatever the column says.
    expect(isAsleep({ status: 'stopped', asleepAt: ASLEEP_AT })).toBe(false);
  });

  it('says since when, and that a request wakes it', () => {
    expect(asleepTitle('2026-10-20T10:04:00Z')).toMatch(/^Asleep since 20 Oct 2026, \d\d:\d\d — its next request wakes it$/);
  });
});

describe('ServiceStatusBadge', () => {
  afterEach(cleanup);

  it('shows the status of an awake service', () => {
    render(<ServiceStatusBadge svc={svcWith()} since />);
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.queryByText('asleep')).not.toBeInTheDocument();
  });

  it('shows asleep with a tooltip, and since when when asked', () => {
    render(<ServiceStatusBadge svc={svcWith({ asleepAt: ASLEEP_AT })} since />);
    const badge = screen.getByText('asleep');
    expect(badge).toHaveAttribute('title', asleepTitle(ASLEEP_AT));
    expect(badge.className).toContain('text-sky-300');
    expect(screen.getByText('since 5m ago')).toHaveAttribute('title', asleepTitle(ASLEEP_AT));
    expect(screen.queryByText('running')).not.toBeInTheDocument();
    cleanup();
    render(<ServiceStatusBadge svc={svcWith({ asleepAt: ASLEEP_AT })} />);
    expect(screen.getByText('asleep')).toBeInTheDocument();
    expect(screen.queryByText(/^since /)).not.toBeInTheDocument();
  });
});

describe('SleepActions', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    wake.mockResolvedValue({ ok: true, status: 'running' });
    sleep.mockResolvedValue({ ok: true, asleep: true });
  });

  it('wakes a sleeping service and refreshes it', async () => {
    const { invalidate } = renderTree(<SleepActions svc={svcWith({ asleepAt: ASLEEP_AT })} />);
    expect(screen.queryByRole('button', { name: /Sleep now/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Wake now/ }));
    expect(await screen.findByText('Service woken up')).toBeInTheDocument();
    expect(wake).toHaveBeenCalledWith(9);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['service', 9] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['services'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dashboard'] });
  });

  it("shows the server's message when the wake fails, a fallback without one, and refreshes anyway", async () => {
    wake.mockRejectedValueOnce(new Error('The service could not be woken: its containers did not start or failed the healthcheck')).mockRejectedValueOnce(new Error(''));
    const { invalidate } = renderTree(<SleepActions svc={svcWith({ asleepAt: ASLEEP_AT })} />);
    const btn = screen.getByRole('button', { name: /Wake now/ });
    fireEvent.click(btn);
    expect(await screen.findByText(/could not be woken: its containers did not start/)).toBeInTheDocument();
    // Another tab may have woken it meanwhile (400 not_asleep): the page reloads the service.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['service', 9] });
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText('Could not wake the service')).toBeInTheDocument();
  });

  it('holds the wake button while it wakes', async () => {
    wake.mockReturnValueOnce(new Promise(() => {}));
    renderTree(<SleepActions svc={svcWith({ asleepAt: ASLEEP_AT })} />);
    fireEvent.click(screen.getByRole('button', { name: /Wake now/ }));
    expect(await screen.findByRole('button', { name: /Waking…/ })).toBeDisabled();
  });

  it('puts an awake service with Sleep when idle on to sleep', async () => {
    const { invalidate } = renderTree(<SleepActions svc={svcWith()} />);
    expect(screen.queryByRole('button', { name: /Wake now/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Sleep now/ }));
    expect(await screen.findByText('Service asleep — its next request wakes it')).toBeInTheDocument();
    expect(sleep).toHaveBeenCalledWith(9);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['service', 9] });
  });

  it("shows the server's cannot_sleep reason, and a fallback without one", async () => {
    sleep
      .mockRejectedValueOnce(new Error('Cannot put the service to sleep: no domain routes to the service, so no request could wake it'))
      .mockRejectedValueOnce(new Error(''));
    renderTree(<SleepActions svc={svcWith()} />);
    const btn = screen.getByRole('button', { name: /Sleep now/ });
    fireEvent.click(btn);
    expect(await screen.findByText(/no domain routes to the service/)).toBeInTheDocument();
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText('Could not put the service to sleep')).toBeInTheDocument();
  });

  it('holds the sleep button while it goes to sleep', async () => {
    sleep.mockReturnValueOnce(new Promise(() => {}));
    renderTree(<SleepActions svc={svcWith()} />);
    fireEvent.click(screen.getByRole('button', { name: /Sleep now/ }));
    expect(await screen.findByRole('button', { name: /Sleeping…/ })).toBeDisabled();
  });

  it('offers nothing for a service that is not running, has Sleep when idle off, or is not docker', () => {
    for (const over of [{ status: 'stopped' }, { sleepAfterMinutes: null }, { sleepAfterMinutes: undefined }, { type: 'compose' }]) {
      renderTree(<SleepActions svc={svcWith(over)} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      cleanup();
    }
  });
});
