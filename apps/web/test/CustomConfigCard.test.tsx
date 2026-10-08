import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  api: {
    traefik: { customConfig: { get: vi.fn(), validate: vi.fn(), set: vi.fn(), clear: vi.fn() } },
  },
}));
vi.mock('../src/lib/api.js', () => apiMock);

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

import { CustomConfigCard } from '../src/routes/traefik/CustomConfigCard.js';

const cfg = apiMock.api.traefik.customConfig;
const none = { content: null, sha256: null, updatedAt: null, updatedBy: null, status: 'none', lastError: null };
const applied = {
  content: 'http:\n  routers: {}\n',
  sha256: 'abcdef0123456789abcdef',
  updatedAt: '2026-10-08T10:00:00.000Z',
  updatedBy: 1,
  status: 'applied',
  lastError: null,
};

/** A NineDeployError-shaped refusal (the SDK lifts the findings into `details`). */
function refusal(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { status, details });
}

const editor = () => screen.getByLabelText('Custom config YAML');

describe('CustomConfigCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cfg.get.mockResolvedValue(none);
  });

  it('starts empty with no saved config and keeps the actions shut until something is typed', async () => {
    renderWithProviders(<CustomConfigCard />);
    expect(await screen.findByTestId('custom-config-status')).toHaveTextContent('none');
    expect(editor()).toHaveValue('');
    expect(screen.getByRole('button', { name: /Validate/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save & apply/ })).toBeDisabled();
    // Nothing saved: nothing to clear.
    expect(screen.queryByRole('button', { name: /Clear/ })).not.toBeInTheDocument();
  });

  it('prefills the saved config and shows its status, save time and hash', async () => {
    cfg.get.mockResolvedValue(applied);
    renderWithProviders(<CustomConfigCard />);
    const status = await screen.findByTestId('custom-config-status');
    expect(status).toHaveTextContent('applied');
    expect(status).toHaveTextContent('abcdef012345');
    expect(status).toHaveTextContent('saved');
    expect(editor()).toHaveValue(applied.content);
  });

  it('validates and lists errors and warnings with their paths', async () => {
    cfg.validate.mockResolvedValue({
      ok: false,
      errors: [{ path: 'http.routers.a', message: 'must start with custom-' }],
      warnings: [{ path: '', message: 'generated name' }],
    });
    renderWithProviders(<CustomConfigCard />);
    fireEvent.change(await screen.findByLabelText('Custom config YAML'), { target: { value: 'http: {}' } });
    fireEvent.click(screen.getByRole('button', { name: /Validate/ }));
    const findings = await screen.findByTestId('custom-config-findings');
    expect(cfg.validate).toHaveBeenCalledWith('http: {}');
    expect(findings).toHaveTextContent('breaks the panel rules');
    expect(within(findings).getByText('http.routers.a')).toBeInTheDocument();
    expect(findings).toHaveTextContent('must start with custom-');
    expect(findings).toHaveTextContent('generated name');
  });

  it('reports a passing validation, and a validation request that fails', async () => {
    cfg.validate.mockResolvedValueOnce({ ok: true, errors: [], warnings: [] });
    renderWithProviders(<CustomConfigCard />);
    fireEvent.change(await screen.findByLabelText('Custom config YAML'), { target: { value: 'http: {}' } });
    fireEvent.click(screen.getByRole('button', { name: /Validate/ }));
    expect(await screen.findByText(/passes the panel rules/)).toBeInTheDocument();
    cfg.validate.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByRole('button', { name: /Validate/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('network down', 'error'));
    cfg.validate.mockRejectedValueOnce('weird');
    fireEvent.click(screen.getByRole('button', { name: /Validate/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Validation failed', 'error'));
  });

  it('saves and shows the router warnings the server returns', async () => {
    cfg.set.mockResolvedValue({ ok: true, status: 'applied', sha256: 'x', warnings: [{ path: 'http.routers.custom-a', message: 'service is generated' }] });
    renderWithProviders(<CustomConfigCard />);
    fireEvent.change(await screen.findByLabelText('Custom config YAML'), { target: { value: 'http: {}' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & apply/ }));
    await waitFor(() => expect(cfg.set).toHaveBeenCalledWith('http: {}'));
    expect(await screen.findByText('Applied.')).toBeInTheDocument();
    expect(screen.getByText('service is generated')).toBeInTheDocument();
    expect(toastSpy.toast).toHaveBeenCalledWith('Custom config applied', 'success');
    // The status is re-read after a save.
    await waitFor(() => expect(cfg.get).toHaveBeenCalledTimes(2));
  });

  it('shows the refusal findings of a rejected save (last good version restored)', async () => {
    cfg.set.mockRejectedValue(
      refusal(422, 'Traefik rejected the config; the last good version was restored', {
        errors: [{ path: '', message: 'field not found, node: bogus' }],
      }),
    );
    renderWithProviders(<CustomConfigCard />);
    fireEvent.change(await screen.findByLabelText('Custom config YAML'), { target: { value: 'http: {}' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & apply/ }));
    const findings = await screen.findByTestId('custom-config-findings');
    expect(findings).toHaveTextContent('last good version was restored');
    expect(findings).toHaveTextContent('field not found, node: bogus');
    expect(toastSpy.toast).toHaveBeenCalledWith('Traefik rejected the config; the last good version was restored', 'error');
  });

  it('handles a refusal without findings (503) and a non-Error rejection', async () => {
    cfg.set.mockRejectedValueOnce(refusal(503, 'Traefik validation unavailable; not applied'));
    renderWithProviders(<CustomConfigCard />);
    fireEvent.change(await screen.findByLabelText('Custom config YAML'), { target: { value: 'http: {}' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & apply/ }));
    expect(await screen.findByText('Traefik validation unavailable; not applied')).toBeInTheDocument();
    cfg.set.mockRejectedValueOnce({ odd: true });
    fireEvent.click(screen.getByRole('button', { name: /Save & apply/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('The config was not saved', 'error'));
    expect(screen.getByTestId('custom-config-findings')).toHaveTextContent('The config was not saved');
  });

  it('shows the last error of a rejected config', async () => {
    cfg.get.mockResolvedValue({ ...applied, status: 'rejected', lastError: 'entryPoint "foo" not found' });
    renderWithProviders(<CustomConfigCard />);
    expect(await screen.findByTestId('custom-config-last-error')).toHaveTextContent('entryPoint "foo" not found');
  });

  it('clears the config after confirming', async () => {
    cfg.get.mockResolvedValue(applied);
    cfg.clear.mockResolvedValueOnce({ ok: true, cleared: true });
    renderWithProviders(<CustomConfigCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Clear/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(cfg.clear).toHaveBeenCalled());
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Custom config removed', 'success'));
    expect(editor()).toHaveValue('');
  });

  it('reports a clear with nothing stored, a failed clear, and a cancelled confirm', async () => {
    cfg.get.mockResolvedValue(applied);
    cfg.clear.mockResolvedValueOnce({ ok: true, cleared: false });
    renderWithProviders(<CustomConfigCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Clear/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cfg.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('There was no custom config', 'success'));
    cfg.clear.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(await screen.findByRole('button', { name: /Clear/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('denied', 'error'));
    cfg.clear.mockRejectedValueOnce(0);
    fireEvent.click(await screen.findByRole('button', { name: /Clear/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not remove the custom config', 'error'));
  });

  it('shows an error card when the config cannot be read', async () => {
    cfg.get.mockRejectedValue(new Error('forbidden'));
    renderWithProviders(<CustomConfigCard />);
    expect(await screen.findByText("Couldn't load the custom config")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(cfg.get).toHaveBeenCalledTimes(2));
  });
});
