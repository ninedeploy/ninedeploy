import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  authedFetch: vi.fn(),
  enrolment: { get: vi.fn(), rotate: vi.fn(), disable: vi.fn() },
}));
vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  const mod = createFakeApiModule();
  // r563: the card reads through the SDK's settings.enrolment.* now.
  return {
    ...mod,
    api: { ...mod.api, settings: { ...mod.api.settings, enrolment: apiMock.enrolment } },
    authedFetch: apiMock.authedFetch,
  };
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

import { EnrolmentTokenCard } from '../src/components/EnrolmentTokenCard.js';
import { renderWithProviders } from './helpers.js';

type Reply = { error?: string; body?: unknown };

/** Script the card's SDK calls (GET = get, POST = rotate, DELETE = disable). */
function replies(map: Partial<Record<'GET' | 'POST' | 'DELETE', Reply>>) {
  const wire = (fn: ReturnType<typeof vi.fn>, r: Reply | undefined) =>
    fn.mockImplementation(async () => {
      if (r?.error) throw new Error(r.error);
      return r?.body;
    });
  wire(apiMock.enrolment.get, map.GET);
  wire(apiMock.enrolment.rotate, map.POST);
  wire(apiMock.enrolment.disable, map.DELETE);
}

describe('EnrolmentTokenCard (r359)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('masks the token until revealed, and copies it', async () => {
    replies({ GET: { body: { enabled: true, token: 'enrol-secret-1' } } });
    renderWithProviders(<EnrolmentTokenCard />);
    await screen.findByRole('button', { name: /Reveal/ });
    expect(screen.queryByText('enrol-secret-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reveal/ }));
    expect(screen.getByText('enrol-secret-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.queryByText('enrol-secret-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Copy token/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('enrol-secret-1'));
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  it('rotates the token and shows the new one', async () => {
    replies({
      GET: { body: { enabled: true, token: 'enrol-secret-1' } },
      POST: { body: { ok: true, enabled: true, token: 'enrol-secret-2' } },
    });
    renderWithProviders(<EnrolmentTokenCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }));
    expect(await screen.findByText('enrol-secret-2')).toBeInTheDocument();
    expect(apiMock.enrolment.rotate).toHaveBeenCalled();
    expect(apiMock.authedFetch).not.toHaveBeenCalled();
    expect(toastSpy.toast).toHaveBeenCalledWith(expect.stringContaining('New enrolment token'), 'success');
  });

  it('disables enrolment after confirmation, then offers to generate a token', async () => {
    replies({
      GET: { body: { enabled: true, token: 'enrol-secret-1' } },
      DELETE: { body: { ok: true, enabled: false } },
      POST: { body: { ok: true, enabled: true, token: 'enrol-secret-3' } },
    });
    renderWithProviders(<EnrolmentTokenCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText(/Enrolment is off/)).toBeInTheDocument();
    expect(apiMock.enrolment.disable).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Generate token' }));
    expect(await screen.findByText('enrol-secret-3')).toBeInTheDocument();
  });

  it('reports a failed load with the server message', async () => {
    replies({ GET: { error: 'Admin access required' } });
    renderWithProviders(<EnrolmentTokenCard />);
    expect(await screen.findByText(/Admin access required/)).toBeInTheDocument();
  });

  it('toasts a failed rotate or disable with the SDK error message', async () => {
    replies({
      GET: { body: { enabled: true, token: 'enrol-secret-1' } },
      POST: { error: 'HTTP 500' },
      DELETE: { error: 'HTTP 502' },
    });
    renderWithProviders(<EnrolmentTokenCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('HTTP 500', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('HTTP 502', 'error'));
  });
});
