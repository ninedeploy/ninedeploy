import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../src/components/Toast.js';

/**
 * 0.16.10: the Settings → Autoscaling card. Self-contained like
 * CanaryCard.test.tsx (no `./helpers.js`).
 */

const apiMock = vi.hoisted(() => ({ api: { services: { update: vi.fn() } } }));
vi.mock('../src/lib/api.js', () => apiMock);

import { AutoscaleCard, autoscaleFormFrom, parseAutoscaleForm } from '../src/routes/service/AutoscaleCard.js';

const STORED = { minReplicas: 2, maxReplicas: 6, metric: 'rps' as const, target: 40, scaleUpSeconds: 90, scaleDownSeconds: 600 };

function serviceWith(over: Record<string, unknown>) {
  return { id: 4, name: 'api', slug: 'api', type: 'docker', serverId: null, memLimitMb: 512, autoscale: null, ...over };
}

function cardTree(svc: ReturnType<typeof serviceWith>) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>
          <AutoscaleCard svc={svc as never} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const renderCard = (svc: ReturnType<typeof serviceWith>) => render(cardTree(svc));

const form = (over: Partial<ReturnType<typeof autoscaleFormFrom>> = {}) => ({ ...autoscaleFormFrom(null), maxReplicas: '4', target: '70', ...over });

describe('autoscaleFormFrom', () => {
  it('starts from the defaults, with no maximum or target', () => {
    expect(autoscaleFormFrom(null)).toEqual({ minReplicas: '1', maxReplicas: '', metric: 'cpu', target: '', scaleUpSeconds: '60', scaleDownSeconds: '300' });
  });

  it('shows a stored configuration', () => {
    expect(autoscaleFormFrom(STORED)).toEqual({ minReplicas: '2', maxReplicas: '6', metric: 'rps', target: '40', scaleUpSeconds: '90', scaleDownSeconds: '600' });
  });
});

describe('parseAutoscaleForm', () => {
  it('parses a configuration, and a blank optional field takes its default', () => {
    expect(parseAutoscaleForm(form())).toEqual({
      config: { minReplicas: 1, maxReplicas: 4, metric: 'cpu', target: 70, scaleUpSeconds: 60, scaleDownSeconds: 300 },
      errors: {},
    });
    expect(parseAutoscaleForm(form({ minReplicas: ' ', scaleUpSeconds: '', scaleDownSeconds: '', metric: 'rps', target: ' 250 ' })).config).toEqual({
      minReplicas: 1, maxReplicas: 4, metric: 'rps', target: 250, scaleUpSeconds: 60, scaleDownSeconds: 300,
    });
  });

  it('needs a maximum above the minimum, and a percentage target for cpu and memory', () => {
    expect(parseAutoscaleForm(form({ minReplicas: '4' })).errors).toEqual({ maxReplicas: 'A whole number of containers above the minimum, up to 10' });
    expect(parseAutoscaleForm(form({ target: '150' })).errors).toEqual({ target: 'A percentage above 0, at most 100' });
    expect(parseAutoscaleForm(form({ metric: 'memory', target: '101' })).errors).toEqual({ target: 'A percentage above 0, at most 100' });
    expect(parseAutoscaleForm(form({ metric: 'rps', target: '150' })).config?.target).toBe(150);
  });

  it('names the range of every field that does not fit', () => {
    const { config, errors } = parseAutoscaleForm({ minReplicas: '0', maxReplicas: '', metric: 'cpu', target: 'x', scaleUpSeconds: '10', scaleDownSeconds: '4000' });
    expect(config).toBeNull();
    expect(errors).toEqual({
      minReplicas: 'A whole number of containers, 1–10',
      maxReplicas: 'A whole number of containers above the minimum, up to 10',
      target: 'A percentage above 0, at most 100',
      scaleUpSeconds: 'A whole number of seconds, 30–3600',
      scaleDownSeconds: 'A whole number of seconds, 60–3600',
    });
    expect(parseAutoscaleForm(form({ metric: 'rps', target: '0' })).errors).toEqual({ target: 'Requests per second per container, above 0' });
    expect(parseAutoscaleForm(form({ maxReplicas: '11', minReplicas: '1.5' })).errors).toEqual({
      minReplicas: 'A whole number of containers, 1–10',
      maxReplicas: 'A whole number of containers above the minimum, up to 10',
    });
    // Not reachable from the select, but a metric the schema does not know is named too.
    expect(parseAutoscaleForm(form({ metric: 'gpu' as never })).errors.metric).toBe('cpu, memory or rps');
  });
});

describe('AutoscaleCard', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.api.services.update.mockResolvedValue({});
  });

  it('is hidden for a non-docker service and on a panel that does not report the field', () => {
    const { rerender } = renderCard(serviceWith({ type: 'compose' }));
    expect(screen.queryByText('Autoscaling')).not.toBeInTheDocument();
    rerender(cardTree(serviceWith({ autoscale: undefined })));
    expect(screen.queryByText('Autoscaling')).not.toBeInTheDocument();
  });

  it('turns on, asks for the maximum and target, and saves', async () => {
    renderCard(serviceWith({}));
    const save = screen.getByRole('button', { name: 'Save autoscaling' });
    // Off with nothing stored: nothing to save.
    expect(save).toBeDisabled();
    expect(screen.queryByLabelText('Min containers')).not.toBeInTheDocument();
    expect(screen.getByText(/applies fully at the next deploy, which creates the spare containers/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Autoscaling' }));
    expect(screen.getByLabelText('Min containers')).toHaveValue('1');
    expect(screen.getByLabelText('Max containers')).toHaveValue('');
    expect(screen.getByLabelText('Metric')).toHaveValue('cpu');
    expect(screen.getByLabelText('Target')).toHaveValue('');
    expect(screen.getByText('%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Traefik → Traffic' })).toHaveAttribute('href', '/traefik');
    // The maximum and the target have no default.
    expect(screen.getByText('A whole number of containers above the minimum, up to 10')).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Max containers'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '60' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalled());
    expect(apiMock.api.services.update).toHaveBeenCalledWith(4, {
      autoscale: { minReplicas: 1, maxReplicas: 4, metric: 'cpu', target: 60, scaleUpSeconds: 60, scaleDownSeconds: 300 },
    });
    expect(await screen.findByText('Autoscaling saved — it applies fully at the next deploy')).toBeInTheDocument();
  });

  it('shows the stored configuration with req/s, and the windows under Advanced', async () => {
    renderCard(serviceWith({ autoscale: STORED }));
    expect(screen.getByRole('switch', { name: 'Autoscaling' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Metric')).toHaveValue('rps');
    expect(screen.getByText('req/s')).toBeInTheDocument();
    expect(screen.getByText('Requests per second per container.')).toBeInTheDocument();
    const advanced = screen.getByRole('button', { name: 'Advanced' });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Scale-up window (s)')).not.toBeInTheDocument();
    fireEvent.click(advanced);
    expect(screen.getByLabelText('Scale-up window (s)')).toHaveValue('90');
    expect(screen.getByLabelText('Scale-down window (s)')).toHaveValue('600');
    fireEvent.change(screen.getByLabelText('Scale-down window (s)'), { target: { value: '900' } });
    fireEvent.click(advanced);
    expect(screen.queryByLabelText('Scale-up window (s)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save autoscaling' }));
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { autoscale: { ...STORED, scaleDownSeconds: 900 } }));
  });

  it('shows a problem under its field, keeps Advanced open on one there, and does not save', async () => {
    renderCard(serviceWith({ autoscale: { ...STORED, metric: 'cpu', target: 50 } }));
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '120' } });
    expect(screen.getByText('A percentage above 0, at most 100')).toBeInTheDocument();
    expect(screen.getByLabelText('Target')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Max containers')).toHaveAttribute('aria-invalid', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.change(screen.getByLabelText('Scale-up window (s)'), { target: { value: '5' } });
    expect(screen.getByText('A whole number of seconds, 30–3600')).toBeInTheDocument();
    // Collapsing it would hide the problem, so it stays open.
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Scale-up window (s)')).toHaveAttribute('aria-invalid', 'true');

    const save = screen.getByRole('button', { name: 'Save autoscaling' });
    expect(save).toBeDisabled();
    // Enter in a field submits the form even with the button disabled in some browsers.
    fireEvent.submit(save.closest('form')!);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMock.api.services.update).not.toHaveBeenCalled();
  });

  it('warns that memory needs a memory limit', () => {
    renderCard(serviceWith({ memLimitMb: 0, autoscale: { ...STORED, metric: 'cpu', target: 50 } }));
    expect(screen.queryByText(/has no memory limit/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'memory' } });
    expect(screen.getByText(/has no memory limit, so memory would read the host's memory/)).toBeInTheDocument();
    expect(screen.getByText('Percent per container, at most 100.')).toBeInTheDocument();
    cleanup();
    renderCard(serviceWith({ autoscale: { ...STORED, metric: 'memory', target: 50 } }));
    expect(screen.queryByText(/has no memory limit/)).not.toBeInTheDocument();
  });

  it('turns a stored configuration off with null', async () => {
    renderCard(serviceWith({ autoscale: STORED }));
    fireEvent.click(screen.getByRole('switch', { name: 'Autoscaling' }));
    expect(screen.queryByLabelText('Min containers')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save autoscaling' }));
    await waitFor(() => expect(apiMock.api.services.update).toHaveBeenCalledWith(4, { autoscale: null }));
    expect(await screen.findByText('Autoscaling turned off')).toBeInTheDocument();
  });

  it("shows the server's message when the save is refused, and a fallback without one", async () => {
    apiMock.api.services.update.mockRejectedValueOnce(new Error('Autoscaling is for docker services')).mockRejectedValueOnce(new Error(''));
    renderCard(serviceWith({ autoscale: STORED }));
    const save = screen.getByRole('button', { name: 'Save autoscaling' });
    fireEvent.click(save);
    expect(await screen.findByText('Autoscaling is for docker services')).toBeInTheDocument();
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    expect(await screen.findByText('Could not save the autoscaling')).toBeInTheDocument();
  });

  it('holds the button while saving', async () => {
    apiMock.api.services.update.mockReturnValueOnce(new Promise(() => {}));
    renderCard(serviceWith({ autoscale: STORED }));
    fireEvent.click(screen.getByRole('button', { name: 'Save autoscaling' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
  });

  it('says the autoscaler holds for a service on a node or on Swarm', () => {
    renderCard(serviceWith({ serverId: 2 }));
    expect(screen.getByText(/runs on a node, so the autoscaler holds for it/)).toBeInTheDocument();
    cleanup();
    renderCard(serviceWith({ placement: { orchestrator: 'swarm' } }));
    expect(screen.getByText(/runs on Swarm, which scales with its own replicas/)).toBeInTheDocument();
  });
});
