import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DeployHookCard } from '../src/routes/service/DeployHookCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** Settings → Deploy hook: on, curl line, rotate (confirmed), off, refusals; hidden where unavailable. */

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});
vi.mock('../src/lib/auth.js', async () => {
  const { createAuthMock } = await import('./apiMock.js');
  return createAuthMock();
});
const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

const URL_A = 'https://panel.example.com/v1/deploy-hooks/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const URL_B = 'https://panel.example.com/v1/deploy-hooks/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  mockOf(api.services.deployHook.get).mockResolvedValue({ enabled: false, url: null, mine: false });
});

describe('DeployHookCard', () => {
  it('turns the hook on and offers the curl line', async () => {
    mockOf(api.services.deployHook.enable).mockResolvedValue({ enabled: true, url: URL_A, mine: true });
    renderWithProviders(<DeployHookCard serviceId={3} />);
    const toggle = await screen.findByRole('switch', { name: 'Deploy hook' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(api.services.deployHook.enable).toHaveBeenCalledWith(3));
    const curl = `curl -fsS -X POST ${URL_A}`;
    expect(await screen.findByText(curl)).toBeInTheDocument();
    expect(toastSpy.toast).toHaveBeenCalledWith('Deploy hook on', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'Copy curl command' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(curl));
  });

  it('rotates the URL only after confirming, then turns it off', async () => {
    mockOf(api.services.deployHook.get).mockResolvedValue({ enabled: true, url: URL_A, mine: true });
    mockOf(api.services.deployHook.enable).mockResolvedValue({ enabled: true, url: URL_B, mine: true });
    mockOf(api.services.deployHook.disable).mockResolvedValue({ enabled: false, url: null, mine: false });
    renderWithProviders(<DeployHookCard serviceId={3} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New deploy hook URL' }));
    expect(api.services.deployHook.enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'New deploy hook URL' }));
    fireEvent.click(screen.getByRole('button', { name: 'New URL' }));
    expect(await screen.findByText(`curl -fsS -X POST ${URL_B}`)).toBeInTheDocument();
    expect(toastSpy.toast).toHaveBeenCalledWith('New deploy hook URL — the old one no longer works', 'success');

    fireEvent.click(screen.getByRole('switch', { name: 'Deploy hook' }));
    await waitFor(() => expect(api.services.deployHook.disable).toHaveBeenCalledWith(3));
    await waitFor(() => expect(screen.queryByText(/curl -fsS/)).not.toBeInTheDocument());
    expect(toastSpy.toast).toHaveBeenCalledWith('Deploy hook off', 'success');
  });

  it("another member's hook shows no URL and can be taken over after confirming", async () => {
    mockOf(api.services.deployHook.get).mockResolvedValue({ enabled: true, url: null, mine: false });
    mockOf(api.services.deployHook.enable).mockResolvedValue({ enabled: true, url: URL_B, mine: true });
    renderWithProviders(<DeployHookCard serviceId={3} />);
    expect(await screen.findByText(/Turned on by another member/)).toBeInTheDocument();
    expect(screen.queryByText(/curl -fsS/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Use my own URL/ }));
    expect(screen.getByText(/deploys as you from now on/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New URL' }));
    expect(await screen.findByText(`curl -fsS -X POST ${URL_B}`)).toBeInTheDocument();
    expect(api.services.deployHook.enable).toHaveBeenCalledWith(3);
  });

  it('shows refusals, with a fallback message', async () => {
    mockOf(api.services.deployHook.enable).mockRejectedValue(new Error('Forbidden'));
    renderWithProviders(<DeployHookCard serviceId={3} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Deploy hook' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Forbidden', 'error'));
    mockOf(api.services.deployHook.enable).mockRejectedValue(new Error(''));
    fireEvent.click(screen.getByRole('switch', { name: 'Deploy hook' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not turn the deploy hook on', 'error'));
  });

  it('shows a refusal to turn it off, with a fallback message', async () => {
    mockOf(api.services.deployHook.get).mockResolvedValue({ enabled: true, url: URL_A, mine: true });
    mockOf(api.services.deployHook.disable).mockRejectedValue(new Error('nope'));
    renderWithProviders(<DeployHookCard serviceId={3} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Deploy hook' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('nope', 'error'));
    mockOf(api.services.deployHook.disable).mockRejectedValue(new Error(''));
    fireEvent.click(screen.getByRole('switch', { name: 'Deploy hook' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not turn the deploy hook off', 'error'));
  });

  it('is hidden for a viewer seat or an older panel (the read fails)', async () => {
    mockOf(api.services.deployHook.get).mockRejectedValue(new Error('Forbidden'));
    renderWithProviders(<DeployHookCard serviceId={3} />);
    await waitFor(() => expect(api.services.deployHook.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Deploy hook')).not.toBeInTheDocument();
  });
});
