import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return { ...createFakeApiModule(), authedFetch: apiMock.authedFetch };
});

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => toastSpy,
}));

import { EnrolmentTokenCard } from '../src/components/EnrolmentTokenCard.js';
import { renderWithProviders } from './helpers.js';

type Reply = { status?: number; body: unknown };

/** Script the card's raw requests per HTTP method. */
function replies(map: Partial<Record<'GET' | 'POST' | 'DELETE', Reply>>) {
  apiMock.authedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    const r = map[(init?.method ?? 'GET') as 'GET'] as Reply;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200 });
  });
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
    expect(apiMock.authedFetch).toHaveBeenCalledWith('/v1/settings/enrolment/rotate', { method: 'POST' });
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
    expect(apiMock.authedFetch).toHaveBeenCalledWith('/v1/settings/enrolment', { method: 'DELETE' });

    fireEvent.click(screen.getByRole('button', { name: 'Generate token' }));
    expect(await screen.findByText('enrol-secret-3')).toBeInTheDocument();
  });

  it('reports a failed load with the server message', async () => {
    replies({ GET: { status: 403, body: { error: { code: 'forbidden', message: 'Admin access required' } } } });
    renderWithProviders(<EnrolmentTokenCard />);
    expect(await screen.findByText(/Admin access required/)).toBeInTheDocument();
  });

  it('toasts a failed rotate or disable, falling back to the status when the body is not JSON', async () => {
    replies({
      GET: { body: { enabled: true, token: 'enrol-secret-1' } },
      POST: { status: 500, body: 'oops' },
      DELETE: { status: 502, body: 'bad gateway' },
    });
    renderWithProviders(<EnrolmentTokenCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Request failed with status 500', 'error'));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Request failed with status 502', 'error'));
  });
});
