import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/Toast.js';

/** 0.16.9: the live canary panel under the service header. */

const apiMock = vi.hoisted(() => ({ api: { deploys: { cancel: vi.fn() } } }));
vi.mock('../src/lib/api.js', () => apiMock);
vi.mock('../src/lib/canaryApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canaryApi.js')>()),
  canaryApi: (await import('./apiMock.js')).createCanaryApiMock(),
}));

import { canaryApi } from '../src/lib/canaryApi.js';
import { CanaryPanel, canaryTimeLeft } from '../src/routes/service/CanaryPanel.js';

const status = vi.mocked(canaryApi.status);
const promote = vi.mocked(canaryApi.promote);

const ACTIVE = {
  active: true,
  deploymentId: 7,
  step: 1,
  steps: 2,
  weight: 10,
  stepStartedAt: new Date().toISOString(),
  stepEndsAt: new Date(Date.now() + 90_000).toISOString(),
  measured: true,
  canary: { requests: 42, errors: 1, errorRate: 2.38, p95Ms: 120 },
  stable: { requests: 380, errors: 0, errorRate: null, p95Ms: null },
  promoting: false,
};

function renderPanel(enabled = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>
          <CanaryPanel serviceId={1} enabled={enabled} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('canaryTimeLeft', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  it('reads the time left in minutes and seconds', () => {
    expect(canaryTimeLeft('2026-10-20T10:01:05Z', now)).toBe('1m 05s');
    expect(canaryTimeLeft('2026-10-20T10:00:42Z', now)).toBe('42s');
    expect(canaryTimeLeft('2026-10-20T09:59:00Z', now)).toBe('0s');
  });
  it('has nothing to say without a valid end', () => {
    expect(canaryTimeLeft(undefined, now)).toBeNull();
    expect(canaryTimeLeft('not a date', now)).toBeNull();
  });
});

describe('CanaryPanel', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    status.mockResolvedValue(ACTIVE);
    promote.mockResolvedValue({ ok: true });
    apiMock.api.deploys.cancel.mockResolvedValue({ ok: true });
  });

  // The toast region is always there; the panel is the only other content.
  const panelShown = () => screen.queryByText(/^Canary release/) !== null;

  it('does not poll while disabled', () => {
    renderPanel(false);
    expect(panelShown()).toBe(false);
    expect(status).not.toHaveBeenCalled();
  });

  it('renders nothing without a canary, or when the status cannot be read', async () => {
    status.mockResolvedValueOnce({ active: false });
    const first = renderPanel();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(panelShown()).toBe(false);
    first.unmount();

    status.mockRejectedValueOnce(new Error('404'));
    const second = renderPanel();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(panelShown()).toBe(false);
    second.unmount();

    // Active but without a deployment id: nothing to act on.
    status.mockResolvedValueOnce({ active: true });
    renderPanel();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    expect(panelShown()).toBe(false);
  });

  it('shows the step, the share and each release next to the other', async () => {
    renderPanel();
    expect(await screen.findByText('Canary release · deployment #7')).toBeInTheDocument();
    expect(screen.getByText(/^Step 1 of 2 · 1m 3\ds left in this step$/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Share of requests on the new release' })).toHaveAttribute('aria-valuenow', '10');
    expect(screen.getByText('New release 10%')).toBeInTheDocument();
    expect(screen.getByText('Previous release 90%')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('2.38%')).toBeInTheDocument();
    expect(screen.getByText('120 ms')).toBeInTheDocument();
    expect(screen.getByText('380')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(status).toHaveBeenCalledWith(1);
  });

  it('shows zeros for a measured step that has no numbers yet', async () => {
    status.mockResolvedValue({ active: true, deploymentId: 7, step: 1, steps: 2, weight: 10, measured: true });
    renderPanel();
    expect(await screen.findByText('New release')).toBeInTheDocument();
    expect(screen.getAllByText('0')).toHaveLength(2);
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('counts the time left down every second', async () => {
    status.mockResolvedValue({ ...ACTIVE, stepEndsAt: new Date(Date.now() + 20_500).toISOString() });
    renderPanel();
    const first = (await screen.findByText(/left in this step/)).textContent;
    await waitFor(() => expect(screen.getByText(/left in this step/).textContent).not.toBe(first), { timeout: 4000 });
  });

  it('says the steps are judged on the healthcheck when traffic analytics is off', async () => {
    status.mockResolvedValue({ active: true, deploymentId: 7, measured: false });
    renderPanel();
    expect(await screen.findByText(/each step is judged on the healthcheck only/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Traefik → Traffic' })).toHaveAttribute('href', '/traefik');
    // No step data yet: step 1 of 1, nothing on the new release, no clock.
    expect(screen.getByText('Step 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('New release 0%')).toBeInTheDocument();
    expect(screen.queryByText('Requests')).not.toBeInTheDocument();
  });

  it('promotes the canary', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith(1, 7));
    expect(await screen.findByText('Promoting: all traffic switches to the new release')).toBeInTheDocument();
  });

  it("shows the server's message when a promote is refused, and a fallback without one", async () => {
    promote.mockRejectedValueOnce(new Error('That deployment has no canary in progress')).mockRejectedValueOnce(new Error(''));
    renderPanel();
    const btn = await screen.findByRole('button', { name: 'Promote' });
    fireEvent.click(btn);
    expect(await screen.findByText('That deployment has no canary in progress')).toBeInTheDocument();
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);
    expect(await screen.findByText('Could not promote the canary')).toBeInTheDocument();
  });

  it('aborts the canary by cancelling the deployment, after a confirmation', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Abort' }));
    expect(screen.getByText(/Deployment #7 is cancelled and all traffic goes back to the previous release/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Abort canary' }));
    await waitFor(() => expect(apiMock.api.deploys.cancel).toHaveBeenCalledWith(1, 7));
    expect(await screen.findByText('Canary aborted: all traffic goes back to the previous release')).toBeInTheDocument();
  });

  it('keeps the canary when the abort dialog is dismissed', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Abort' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Abort this canary?')).not.toBeInTheDocument();
    expect(apiMock.api.deploys.cancel).not.toHaveBeenCalled();
  });

  it("shows the server's message when an abort fails, and a fallback without one", async () => {
    apiMock.api.deploys.cancel.mockRejectedValueOnce(new Error('Deployment already finished')).mockRejectedValueOnce(new Error(''));
    renderPanel();
    const abort = await screen.findByRole('button', { name: 'Abort' });
    fireEvent.click(abort);
    fireEvent.click(screen.getByRole('button', { name: 'Abort canary' }));
    expect(await screen.findByText('Deployment already finished')).toBeInTheDocument();
    await waitFor(() => expect(abort).not.toBeDisabled());
    fireEvent.click(abort);
    fireEvent.click(screen.getByRole('button', { name: 'Abort canary' }));
    expect(await screen.findByText('Could not abort the canary')).toBeInTheDocument();
  });

  it('holds both buttons while a promote is being applied', async () => {
    status.mockResolvedValue({ ...ACTIVE, promoting: true });
    renderPanel();
    expect(await screen.findByText('Switching all traffic to the new release…')).toBeInTheDocument();
    // The spinner's "Loading" title joins the button's name.
    expect(screen.getByRole('button', { name: /Promote$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abort' })).toBeDisabled();
  });
});
