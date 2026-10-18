import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Http3Card } from '../src/routes/traefik/Http3Card.js';
import { api } from '../src/lib/api.js';
import { mockOf, renderWithProviders } from './helpers.js';

/** 0.16.1 Traefik → Overview → HTTP/3: confirmed switch, server error shown, a lost answer re-reads the setting. */

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

beforeEach(() => {
  vi.clearAllMocks();
  mockOf(api.traefik.http3.get).mockResolvedValue({ enabled: false });
});

describe('Http3Card', () => {
  it('turns HTTP/3 on only after confirming', async () => {
    mockOf(api.traefik.http3.set).mockResolvedValue({ enabled: true });
    renderWithProviders(<Http3Card />);
    const toggle = await screen.findByRole('switch', { name: 'HTTP/3' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(api.traefik.http3.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.traefik.http3.set).toHaveBeenCalledWith(true));
    expect(toastSpy.toast).toHaveBeenCalledWith('HTTP/3 on: Traefik now listens on 443/udp', 'success');
    await waitFor(() => expect(screen.getByRole('switch', { name: 'HTTP/3' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('turns it off, and cancelling sends nothing', async () => {
    mockOf(api.traefik.http3.get).mockResolvedValue({ enabled: true });
    mockOf(api.traefik.http3.set).mockResolvedValue({ enabled: false });
    renderWithProviders(<Http3Card />);
    fireEvent.click(await screen.findByRole('switch', { name: 'HTTP/3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.traefik.http3.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch', { name: 'HTTP/3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('HTTP/3 off: 443/udp closed', 'success'));
  });

  it("shows the server's 502, and re-reads when the answer was lost to the restart", async () => {
    mockOf(api.traefik.http3.set).mockRejectedValueOnce(Object.assign(new Error('Traefik could not be recreated; HTTP/3 stays off'), { status: 502 }));
    renderWithProviders(<Http3Card />);
    fireEvent.click(await screen.findByRole('switch', { name: 'HTTP/3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Traefik could not be recreated; HTTP/3 stays off', 'error'));

    mockOf(api.traefik.http3.set).mockRejectedValueOnce(new Error('Failed to fetch'));
    fireEvent.click(screen.getByRole('switch', { name: 'HTTP/3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('The proxy restarted before the panel could answer; re-reading the setting.', 'info'));
    expect(api.traefik.http3.get).toHaveBeenCalledTimes(3);
  });
});
