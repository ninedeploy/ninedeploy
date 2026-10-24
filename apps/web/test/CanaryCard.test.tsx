import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * 0.16.9: the Settings → Canary releases card. Self-contained like
 * ContainerOptionsCard.test.tsx (no `./helpers.js`).
 */

const apiMock = vi.hoisted(() => ({ api: { services: { update: vi.fn() } } }));
vi.mock('../src/lib/api.js', () => apiMock);

import { CanaryCard, canaryFormFrom, parseCanaryForm } from '../src/routes/service/CanaryCard.js';

const STORED = { steps: [5, 25, 75], stepSeconds: 300, maxErrorRate: 2.5, maxP95Ms: 800, minRequests: 50 };

function serviceWith(over: Record<string, unknown>) {
  return { id: 4, name: 'api', slug: 'api', type: 'docker', serverId: null, canary: null, ...over };
}

function renderCard(svc: ReturnType<typeof serviceWith>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>
          <CanaryCard svc={svc as never} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const form = (over: Partial<ReturnType<typeof canaryFormFrom>> = {}) => ({ ...canaryFormFrom(null), ...over });

describe('canaryFormFrom', () => {
  it('starts from the defaults', () => {
    expect(canaryFormFrom(null)).toEqual({ steps: '10, 50', stepSeconds: '120', maxErrorRate: '5', maxP95Ms: '', minRequests: '20' });
  });

  it('shows a stored configuration', () => {
    expect(canaryFormFrom(STORED)).toEqual({ steps: '5, 25, 75', stepSeconds: '300', maxErrorRate: '2.5', maxP95Ms: '800', minRequests: '50' });
  });
});

describe('parseCanaryForm', () => {
  it('parses the defaults, and a blank field takes its default', () => {
    expect(parseCanaryForm(form())).toEqual({
      config: { steps: [10, 50], stepSeconds: 120, maxErrorRate: 5, maxP95Ms: null, minRequests: 20 },
      errors: {},
    });
    expect(parseCanaryForm(form({ steps: ' 5 25,75 ', stepSeconds: ' ', maxErrorRate: '', minRequests: '', maxP95Ms: '900' })).config).toEqual({
      steps: [5, 25, 75], stepSeconds: 120, maxErrorRate: 5, maxP95Ms: 900, minRequests: 20,
    });
  });

  it('names the rising-steps rule in its own words', () => {
    expect(parseCanaryForm(form({ steps: '50, 10' })).errors).toEqual({ steps: 'Canary steps must go up, for example 10, 50' });
  });

  it('names the range of every field that does not fit', () => {
    const { config, errors } = parseCanaryForm({ steps: '10, abc', stepSeconds: '10', maxErrorRate: 'x', maxP95Ms: '5', minRequests: '0' });
    expect(config).toBeNull();
    expect(errors).toEqual({
      steps: '1 to 5 whole percentages from 1 to 99, for example 10, 50',
      stepSeconds: 'A whole number of seconds, 30–3600',
      maxErrorRate: 'A percentage, 0–100',
      maxP95Ms: 'A whole number of milliseconds, 10 or more; blank turns it off',
      minRequests: 'A whole number, 1 or more',
    });
    expect(parseCanaryForm(form({ steps: '' })).errors.steps).toMatch(/^1 to 5/);
    expect(parseCanaryForm(form({ steps: '1, 2, 3, 4, 5, 6' })).errors.steps).toMatch(/^1 to 5/);
    expect(parseCanaryForm(form({ steps: '100' })).errors.steps).toMatch(/^1 to 5/);
  });
});

describe('CanaryCard', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.services.update.mockResolvedValue({});
  });

  it('is hidden for a non-docker service and on a panel that does not report the field', () => {
    const { rerender } = renderCard(serviceWith({ type: 'compose' }));
    expect(screen.queryByText('Canary releases')).not.toBeInTheDocument();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ToastProvider>
            <CanaryCard svc={serviceWith({ canary: undefined }) as never} />
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByText('Canary releases')).not.toBeInTheDocument();
  });

  it('turns on from the defaults and saves them', async () => {
    renderCard(serviceWith({}));
    const save = screen.getByRole('button', { name: 'Save canary releases' });
    // Off with nothing stored: nothing to save.
    expect(save).toBeDisabled();
    expect(screen.queryByLabelText('Steps (%)')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Traefik → Traffic' })).toHaveAttribute('href', '/traefik');

    fireEvent.click(screen.getByRole('switch', { name: 'Canary releases' }));
    expect(screen.getByLabelText('Steps (%)')).toHaveValue('10, 50');
    expect(screen.getByLabelText('Step length (s)')).toHaveValue('120');
    expect(screen.getByLabelText('Max 5xx rate (%)')).toHaveValue('5');
    expect(screen.getByLabelText('Max p95 (ms)')).toHaveValue('');
    expect(screen.getByLabelText('Min requests')).toHaveValue('20');

    fireEvent.change(screen.getByLabelText('Max p95 (ms)'), { target: { value: '750' } });
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalled());
    expect(apiMock.api.services.update).toHaveBeenCalledWith(4, {
      canary: { steps: [10, 50], stepSeconds: 120, maxErrorRate: 5, maxP95Ms: 750, minRequests: 20 },
    });
    expect(await screen.findByText('Canary releases saved — used from the next deploy')).toBeInTheDocument();
  });

  it('shows a problem under its field and does not save', async () => {
    renderCard(serviceWith({ canary: STORED }));
    expect(screen.getByLabelText('Steps (%)')).toHaveValue('5, 25, 75');
    fireEvent.change(screen.getByLabelText('Steps (%)'), { target: { value: '50, 10' } });
    fireEvent.change(screen.getByLabelText('Step length (s)'), { target: { value: '5' } });
    expect(screen.getByText('Canary steps must go up, for example 10, 50')).toBeInTheDocument();
    expect(screen.getByText('A whole number of seconds, 30–3600')).toBeInTheDocument();
    expect(screen.getByLabelText('Steps (%)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Max p95 (ms)')).toHaveAttribute('aria-invalid', 'false');
    const save = screen.getByRole('button', { name: 'Save canary releases' });
    expect(save).toBeDisabled();
    // Enter in a field submits the form even with the button disabled in some browsers.
    fireEvent.submit(save.closest('form')!);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMock.api.services.update).not.toHaveBeenCalled();
  });

  it('turns a stored configuration off with null', async () => {
    renderCard(serviceWith({ canary: STORED }));
    const sw = screen.getByRole('switch', { name: 'Canary releases' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(screen.queryByLabelText('Steps (%)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save canary releases' }));
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { canary: null }));
    expect(await screen.findByText('Canary releases turned off')).toBeInTheDocument();
  });

  it("shows the server's message when the save is refused, and a fallback without one", async () => {
    apiMock.api.services.update.mockRejectedValueOnce(new Error('Canary releases are for docker services')).mockRejectedValueOnce(new Error(''));
    renderCard(serviceWith({ canary: STORED }));
    const save = screen.getByRole('button', { name: 'Save canary releases' });
    fireEvent.click(save);
    expect(await screen.findByText('Canary releases are for docker services')).toBeInTheDocument();
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    expect(await screen.findByText('Could not save the canary releases')).toBeInTheDocument();
  });

  it('holds the button while saving', async () => {
    apiMock.api.services.update.mockReturnValueOnce(new Promise(() => {}));
    renderCard(serviceWith({ canary: STORED }));
    fireEvent.click(screen.getByRole('button', { name: 'Save canary releases' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('explains node readiness and observation requirements without the panel analytics toggle', () => {
    renderCard(serviceWith({ serverId: 2 }));
    expect(screen.getByText(/Node canary requires one replica, HTTP readiness, a domain and no published host ports/)).toBeInTheDocument();
    expect(screen.getByText(/traffic observations enabled by its owner/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Traefik → Traffic' })).not.toBeInTheDocument();
    expect(screen.queryByText(/runs on a node, so its deploys switch all traffic at once/)).not.toBeInTheDocument();
  });
});
