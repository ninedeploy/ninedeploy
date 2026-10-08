import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders, mockOf } from './helpers.js';

vi.mock('../src/lib/api.js', async () => (await import('./apiMock.js')).createFakeApiModule());

const authState = vi.hoisted(() => ({ user: { id: 1, email: 'op@x.test', isOperator: true } as { id: number; email: string; isOperator: boolean } | null }));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ user: authState.user, loading: false }),
}));

const toastSpy = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../src/components/Toast.js', async () => {
  const actual = await vi.importActual<typeof import('../src/components/Toast.js')>('../src/components/Toast.js');
  return { ...actual, useToast: () => toastSpy };
});

import { api } from '../src/lib/api.js';
import { Terminals, endReasonLabel } from '../src/routes/Terminals.js';
import { TerminalsCard } from '../src/routes/settings/TerminalsCard.js';

const session = (over: Record<string, unknown> = {}) => ({
  id: 5,
  status: 'active',
  targetKind: 'service',
  targetLabel: 'web',
  serverId: null,
  userId: 1,
  userEmail: 'op@x.test',
  createdAt: '2026-10-08T10:00:00.000Z',
  startedAt: '2026-10-08T10:00:01.000Z',
  endedAt: null,
  durationMs: null,
  bytesIn: 10,
  bytesOut: 2048,
  endReason: null,
  exitCode: null,
  clientIp: '10.0.0.1',
  ...over,
});

const SETTINGS = {
  hostTerminalEnabled: false,
  hostTerminalForbiddenByEnv: false,
  idleTimeoutMinutes: 15,
  maxSessionMinutes: 240,
  maxConcurrent: 10,
  retentionDays: 180,
};

describe('Terminal sessions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: 1, email: 'op@x.test', isOperator: true };
  });

  it('lists live and finished sessions with their details', async () => {
    mockOf(api.terminals.list).mockResolvedValue({
      items: [
        session(),
        session({ id: 4, status: 'ended', targetKind: 'host', targetLabel: 'node a host', serverId: 2, durationMs: 3_725_000, endReason: 'idle', exitCode: 0, userEmail: null, clientIp: null, startedAt: null }),
        session({ id: 3, status: 'failed', durationMs: 42_000, endReason: 'some_new_reason' }),
        session({ id: 2, status: 'expired', durationMs: 125_000 }),
      ],
      nextBefore: null,
    });
    renderWithProviders(<Terminals />);
    expect(await screen.findByText('node a host')).toBeInTheDocument();
    expect(screen.getByText('node #2')).toBeInTheDocument();
    expect(screen.getByText('idle timeout')).toBeInTheDocument();
    expect(screen.getByText('some new reason')).toBeInTheDocument();
    expect(screen.getByText('exit 0')).toBeInTheDocument();
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    // only the live row offers Terminate
    expect(screen.getAllByRole('button', { name: 'Terminate' })).toHaveLength(1);
  });

  it('filters by status and target, and pages back with Load older', async () => {
    mockOf(api.terminals.list)
      .mockResolvedValueOnce({ items: [session()], nextBefore: 5 })
      .mockResolvedValueOnce({ items: [session({ id: 1, status: 'ended', targetLabel: 'older' })], nextBefore: null })
      .mockResolvedValue({ items: [], nextBefore: null });
    renderWithProviders(<Terminals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older sessions' }));
    expect(await screen.findByText('older')).toBeInTheDocument();
    expect(mockOf(api.terminals.list).mock.calls[1]?.[0]).toEqual({ limit: 50, before: 5 });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'host' } });
    await waitFor(() => expect(mockOf(api.terminals.list)).toHaveBeenLastCalledWith({ status: 'active', targetKind: 'host', limit: 50 }));
    expect(await screen.findByText('No terminal sessions')).toBeInTheDocument();
  });

  it('terminates a live session after confirmation', async () => {
    mockOf(api.terminals.list).mockResolvedValue({ items: [session(), session({ id: 6, status: 'pending', userEmail: null })], nextBefore: null });
    mockOf(api.terminals.terminate).mockResolvedValueOnce({ ok: true, wasLive: true }).mockResolvedValueOnce({ ok: true, wasLive: false }).mockRejectedValueOnce(new Error('already ended')).mockRejectedValueOnce('x');
    renderWithProviders(<Terminals />);
    const confirmKill = async (index: number) => {
      fireEvent.click((await screen.findAllByRole('button', { name: 'Terminate' }))[index]!);
      fireEvent.click(within(document.body).getAllByRole('button', { name: 'Terminate' }).at(-1)!);
    };
    await confirmKill(0);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Session terminated', 'success'));
    await confirmKill(1);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Pending session revoked', 'success'));
    await confirmKill(0);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('already ended', 'error'));
    await confirmKill(0);
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not terminate the session', 'error'));
    expect(mockOf(api.terminals.terminate).mock.calls.map((c) => c[0])).toEqual([5, 6, 5, 5]);
  });

  it('shows an error card and retries', async () => {
    mockOf(api.terminals.list).mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ items: [], nextBefore: null });
    renderWithProviders(<Terminals />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No terminal sessions')).toBeInTheDocument();
  });

  it('is operator-only', () => {
    authState.user = { id: 2, email: 'm@x.test', isOperator: false };
    renderWithProviders(<Terminals />);
    expect(screen.getByText('Operators only.')).toBeInTheDocument();
    expect(api.terminals.list).not.toHaveBeenCalled();
  });

  it('labels end reasons', () => {
    expect(endReasonLabel(null)).toBe('');
    expect(endReasonLabel('terminated')).toBe('terminated by an operator');
  });
});

describe('Settings → Security → Terminals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enables host shells only after the warning and the password re-check', async () => {
    mockOf(api.terminals.settings.get).mockResolvedValue(SETTINGS);
    mockOf(api.terminals.settings.set).mockResolvedValue({ ...SETTINGS, hostTerminalEnabled: true });
    renderWithProviders(<TerminalsCard />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Host shells' }));
    expect(screen.getByText(/interactive root shell on the server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Host shells' }));
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable host shells' }));
    await waitFor(() => expect(api.terminals.settings.set).toHaveBeenCalledWith({ hostTerminalEnabled: true, password: 'pw' }));
    expect(await screen.findByText('enabled')).toBeInTheDocument();
    expect(toastSpy.toast).toHaveBeenCalledWith('Terminal settings saved', 'success');
  });

  it('sends no password for an SSO-only account, and turns host shells off without one', async () => {
    mockOf(api.terminals.settings.get).mockResolvedValue(SETTINGS);
    mockOf(api.terminals.settings.set).mockRejectedValueOnce(new Error('Confirm your current password')).mockResolvedValue({ ...SETTINGS, hostTerminalEnabled: true });
    renderWithProviders(<TerminalsCard />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Host shells' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable host shells' }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Confirm your current password', 'error'));
    expect(api.terminals.settings.set).toHaveBeenCalledWith({ hostTerminalEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Enable host shells' }));
    expect(await screen.findByText('enabled')).toBeInTheDocument();
    mockOf(api.terminals.settings.set).mockRejectedValueOnce('nope');
    fireEvent.click(screen.getByRole('switch', { name: 'Host shells' }));
    await waitFor(() => expect(api.terminals.settings.set).toHaveBeenLastCalledWith({ hostTerminalEnabled: false }));
    await waitFor(() => expect(toastSpy.toast).toHaveBeenCalledWith('Could not save the terminal settings', 'error'));
  });

  it('saves only the limits that changed', async () => {
    mockOf(api.terminals.settings.get).mockResolvedValue(SETTINGS);
    mockOf(api.terminals.settings.set).mockResolvedValue({ ...SETTINGS, idleTimeoutMinutes: 30 });
    renderWithProviders(<TerminalsCard />);
    const idle = await screen.findByLabelText('Idle timeout (minutes)');
    expect(screen.getByRole('button', { name: 'Save limits' })).toBeDisabled();
    fireEvent.change(idle, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Keep session history (days)'), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(api.terminals.settings.set).toHaveBeenCalledWith({ idleTimeoutMinutes: 30 }));
    await waitFor(() => expect(screen.getByLabelText('Idle timeout (minutes)')).toHaveValue(30));
  });

  it('says when the environment forbids host shells', async () => {
    mockOf(api.terminals.settings.get).mockResolvedValue({ ...SETTINGS, hostTerminalForbiddenByEnv: true });
    renderWithProviders(<TerminalsCard />);
    expect(await screen.findByText(/forbidden by NINEDEPLOY_HOST_TERMINAL=off/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Host shells' })).toBeDisabled();
  });

  it('shows a load error with retry', async () => {
    mockOf(api.terminals.settings.get).mockRejectedValueOnce(new Error('down')).mockResolvedValue(SETTINGS);
    renderWithProviders(<TerminalsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('switch', { name: 'Host shells' })).toBeInTheDocument();
  });
});
