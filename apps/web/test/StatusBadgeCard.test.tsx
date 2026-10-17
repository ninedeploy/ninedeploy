import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { StatusBadgeCard } from '../src/routes/service/StatusBadgeCard.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.1 Settings → Status badge: on, Markdown, rotate (confirmed), off; hidden where unavailable. */

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

const URL_A = 'https://panel.example.com/v1/badges/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg';
const URL_B = 'https://panel.example.com/v1/badges/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.svg';

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  mockOf(api.services.badge.get).mockResolvedValue({ enabled: false, url: null });
});

describe('StatusBadgeCard', () => {
  it('turns the badge on and offers its Markdown', async () => {
    mockOf(api.services.badge.enable).mockResolvedValue({ enabled: true, url: URL_A });
    renderWithProviders(<StatusBadgeCard serviceId={3} serviceName="api" />);
    const toggle = await screen.findByRole('switch', { name: 'Status badge' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(api.services.badge.enable).toHaveBeenCalledWith(3));
    const markdown = `[![api deploy](${URL_A})](${URL_A})`;
    expect(await screen.findByText(markdown)).toBeInTheDocument();
    expect(screen.getByAltText('Deploy status badge')).toHaveAttribute('src', URL_A);
    expect(toastSpy.toast).toHaveBeenCalledWith('Status badge on', 'success');
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(markdown));
  });

  it('rotates the URL only after confirming, then turns it off', async () => {
    mockOf(api.services.badge.get).mockResolvedValue({ enabled: true, url: URL_A });
    mockOf(api.services.badge.enable).mockResolvedValue({ enabled: true, url: URL_B });
    mockOf(api.services.badge.disable).mockResolvedValue({ enabled: false, url: null });
    renderWithProviders(<StatusBadgeCard serviceId={3} serviceName="api" />);
    fireEvent.click(await screen.findByRole('button', { name: 'New badge URL' }));
    expect(api.services.badge.enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New URL' }));
    await waitFor(() => expect(screen.getByAltText('Deploy status badge')).toHaveAttribute('src', URL_B));
    expect(toastSpy.toast).toHaveBeenCalledWith('New badge URL — the old one no longer works', 'success');

    fireEvent.click(screen.getByRole('switch', { name: 'Status badge' }));
    await waitFor(() => expect(api.services.badge.disable).toHaveBeenCalledWith(3));
    await waitFor(() => expect(screen.queryByAltText('Deploy status badge')).not.toBeInTheDocument());
    expect(toastSpy.toast).toHaveBeenCalledWith('Status badge off', 'success');
  });

  it('shows a refusal', async () => {
    mockOf(api.services.badge.enable).mockRejectedValue(new Error('Forbidden'));
    renderWithProviders(<StatusBadgeCard serviceId={3} serviceName="api" />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Status badge' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Forbidden', 'error'));
  });

  it('shows a refusal to turn it off', async () => {
    mockOf(api.services.badge.get).mockResolvedValue({ enabled: true, url: URL_A });
    mockOf(api.services.badge.disable).mockRejectedValue(new Error('nope'));
    renderWithProviders(<StatusBadgeCard serviceId={3} serviceName="api" />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Status badge' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('nope', 'error'));
  });

  it('is hidden for a viewer seat or an older panel (the read fails)', async () => {
    mockOf(api.services.badge.get).mockRejectedValue(new Error('Forbidden'));
    renderWithProviders(<StatusBadgeCard serviceId={3} serviceName="api" />);
    await waitFor(() => expect(api.services.badge.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Status badge')).not.toBeInTheDocument();
  });
});
