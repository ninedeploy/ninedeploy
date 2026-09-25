import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePanelUpdate } from '../src/lib/usePanelUpdate.js';

// The hook is the shared brain behind the banner and the About card; these
// unit tests drive every server phase directly instead of going through DOM.

const auth = vi.hoisted(() => ({
  useAuth: vi.fn<() => { user: { isOperator?: boolean } | null; loading: boolean }>(() => ({ user: null, loading: false })),
}));
vi.mock('../src/lib/auth.js', () => ({
  AuthProvider: ({ children }: { children?: ReactNode }) => children,
  useAuth: auth.useAuth,
}));

const toast = vi.hoisted(() => ({ toast: vi.fn() }));
// The hook destructures `const { toast } = useToast()` — return the context shape.
vi.mock('../src/components/Toast.js', () => ({
  ToastProvider: ({ children }: { children?: ReactNode }) => children,
  useToast: () => ({ toast: toast.toast }),
}));

vi.mock('../src/lib/api.js', async () => {
  const { createFakeApiModule } = await import('./apiMock.js');
  return createFakeApiModule();
});

import { api } from '../src/lib/api.js';

const operatorUser = { id: 1, email: 'root@example.com', name: null, isOperator: true, workspaceCount: 1, createdAt: '2026-01-01T00:00:00Z' };

function status(overrides: Record<string, unknown> = {}) {
  return { supported: true, phase: 'idle', currentVersion: 'v0.3.3', targetVersion: null, startedAt: null, finishedAt: null, errorTail: null, ...overrides };
}

function checkResult(overrides: Record<string, unknown> = {}) {
  return { current: 'v0.3.3', latest: null, updateAvailable: false, notesUrl: null, checkedAt: '2026-08-27T00:00:00Z', ...overrides };
}

function renderHookWith() {
  // One QueryClient PER TEST (created outside the render tree): a client
  // rebuilt mid-mount loses in-flight queries and strands phases.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...renderHook(() => usePanelUpdate(), {
      wrapper: ({ children }: { children?: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  toast.toast.mockReset();
  auth.useAuth.mockReturnValue({ user: operatorUser, loading: false });
  mockOf(api.system.updateCheck).mockResolvedValue(checkResult());
  mockOf(api.system.updateStatus).mockResolvedValue(status());
});

function mockOf(fn: unknown) {
  return fn as ReturnType<typeof vi.fn>;
}

describe('usePanelUpdate', () => {
  it('stays checking and fires nothing for non-operators', async () => {
    auth.useAuth.mockReturnValue({ user: null, loading: false });
    const { result } = renderHookWith();
    expect(result.current.ready).toBe(false);
    expect(result.current.phase).toBe('checking');
    await new Promise((r) => setTimeout(r, 10));
    expect(api.system.updateCheck).not.toHaveBeenCalled();
    expect(api.system.updateStatus).not.toHaveBeenCalled();
  });

  it('resolves to idle for an up-to-date supported panel', async () => {
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.phase).toBe('idle');
    expect(result.current.available).toBe(false);
    expect(result.current.supported).toBe(true);
  });

  it('offers the update when a newer release exists', async () => {
    mockOf(api.system.updateCheck).mockResolvedValue(checkResult({ latest: 'v0.4.0', updateAvailable: true }));
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.latestVersion).toBe('v0.4.0');
    expect(result.current.dismissedByUser).toBe(false);
  });

  it('dismissal hides only this device until a newer release appears', async () => {
    mockOf(api.system.updateCheck).mockResolvedValue(checkResult({ latest: 'v0.4.0', updateAvailable: true }));
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.available).toBe(true));

    act(() => result.current.dismissAvailable());
    expect(window.localStorage.getItem('ninedeploy.updateDismissed')).toBe('v0.4.0');
    expect(result.current.dismissedByUser).toBe(true);
  });

  it('marks unsupported installations with their reason and stays manual', async () => {
    mockOf(api.system.updateStatus).mockResolvedValue(status({ supported: false, reason: 'Container mode' }));
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.supported).toBe(false);
    expect(result.current.supportReason).toBe('Container mode');
    // A dismissed strip renders as idle; there is nothing to restart from here.
    expect(result.current.phase).toBe('idle');
  });

  it('keeps showing updating while the run was started on this tab but never confirmed', async () => {
    mockOf(api.system.updateStatus).mockResolvedValue(status({ supported: false, reason: 'Container mode' }));
    window.localStorage.setItem('ninedeploy.updateTarget', 'v0.3.4');
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.ready).toBe(true));
    // The localStorage marker survives the panel restart mid-run.
    expect(result.current.targetVersion).toBe('v0.3.4');
    expect(result.current.phase).toBe('updating');
  });

  it('startUpdating persists the target and flips to updating immediately', async () => {
    mockOf(api.system.updateStart).mockResolvedValue({ ok: true });
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => result.current.startUpdating('v0.3.4'));
    await waitFor(() => expect(result.current.phase).toBe('updating'));
    expect(window.localStorage.getItem('ninedeploy.updateTarget')).toBe('v0.3.4');
    mockOf(api.system.updateStatus).mockResolvedValue(status({ phase: 'running', targetVersion: 'v0.3.4' }));
    await waitFor(() => expect(api.system.updateStart).toHaveBeenCalledWith('v0.3.4'));
  });

  it('surfaces an errored start attempt through the toast', async () => {
    mockOf(api.system.updateStart).mockRejectedValue(new Error('installer missing'));
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => result.current.startUpdating('v0.3.4'));
    await waitFor(() => expect(toast.toast).toHaveBeenCalledWith('installer missing', 'error'));
    expect(window.localStorage.getItem('ninedeploy.updateTarget')).toBeNull();
  });

  it('reports success exactly once per target and clears the local marker', async () => {
    mockOf(api.system.updateCheck).mockResolvedValue(checkResult({ latest: 'v0.3.3', updateAvailable: true }));
    window.localStorage.setItem('ninedeploy.updateTarget', 'v0.3.4');
    mockOf(api.system.updateStatus).mockResolvedValue(status({ phase: 'success', targetVersion: 'v0.3.4' }));

    const { result, qc } = renderHookWith();
    await waitFor(() => expect(result.current.phase).toBe('done'));
    expect(toast.toast).toHaveBeenCalledTimes(1);
    expect(toast.toast).toHaveBeenCalledWith(expect.stringContaining('v0.3.4'), 'success');
    expect(window.localStorage.getItem('ninedeploy.updateTarget')).toBeNull();

    // Re-rendering with the same settled phase must not repeat the toast.
    // (Success slows polling to 120s, so feed the next phases through the
    // caches directly instead of waiting on timers.) A truthful post-update
    // refresh reports nothing new available any more.
    mockOf(api.system.updateCheck).mockResolvedValue(checkResult({ current: 'v0.3.4' }));
    act(() => {
      qc.setQueryData(['update-check'], checkResult({ current: 'v0.3.4' }));
      qc.setQueryData(['self-update-status'], status({ phase: 'idle' }));
    });
    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(toast.toast).toHaveBeenCalledTimes(1);

    // The success banner self-clears after 12s.
    vi.useFakeTimers();
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(result.current.phase).toBe('idle');
    vi.useRealTimers();
  });

  it('lands idle when the server reports success without any known target', async () => {
    mockOf(api.system.updateStatus).mockResolvedValue(status({ phase: 'success', targetVersion: null }));
    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.phase).toBe('idle');
  });

  it('reports failure once with the installer output tail', async () => {
    window.localStorage.setItem('ninedeploy.updateTarget', 'v0.3.4');
    mockOf(api.system.updateStatus).mockResolvedValue(status({ phase: 'failed', targetVersion: 'v0.3.4', errorTail: 'npm ERR! boom' }));

    const { result } = renderHookWith();
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.errorTail).toBe('npm ERR! boom');
    expect(toast.toast).toHaveBeenCalledWith(expect.stringContaining('failed'), 'error');
    expect(window.localStorage.getItem('ninedeploy.updateTarget')).toBeNull();

    act(() => result.current.clearFailure());
    expect(result.current.phase).toBe('idle');
  });

  // r291: the server keeps the terminal phase until the next update, so the
  // outcome used to be toasted again on every page load and in every tab.
  describe('announces a finished run once per browser (r291)', () => {
    it('stays quiet on a later page load about a run it already announced', async () => {
      window.localStorage.setItem('ninedeploy.updateAnnounced', 'success:v0.5.0:2026-09-01T10:00:00Z');
      mockOf(api.system.updateStatus).mockResolvedValue(
        status({ phase: 'success', currentVersion: 'v0.5.0', targetVersion: 'v0.5.0', finishedAt: '2026-09-01T10:00:00Z' }),
      );
      const { result } = renderHookWith();
      await waitFor(() => expect(result.current.ready).toBe(true));
      await waitFor(() => expect(result.current.phase).toBe('idle'));
      expect(toast.toast).not.toHaveBeenCalled();
    });

    it('a second hook instance (About beside the banner) shows the result without a second toast', async () => {
      mockOf(api.system.updateStatus).mockResolvedValue(
        status({ phase: 'success', targetVersion: 'v0.5.1', finishedAt: '2026-09-02T10:00:00Z' }),
      );
      const first = renderHookWith();
      await waitFor(() => expect(first.result.current.phase).toBe('done'));
      const second = renderHookWith();
      await waitFor(() => expect(second.result.current.phase).toBe('done'));
      expect(toast.toast).toHaveBeenCalledTimes(1);
    });

    it('still announces a newer run to an operator who reloaded mid-update', async () => {
      window.localStorage.setItem('ninedeploy.updateAnnounced', 'success:v0.5.0:2026-09-01T10:00:00Z');
      mockOf(api.system.updateStatus).mockResolvedValue(
        status({ phase: 'success', targetVersion: 'v0.5.2', finishedAt: '2026-09-03T10:00:00Z' }),
      );
      const { result } = renderHookWith();
      await waitFor(() => expect(result.current.phase).toBe('done'));
      expect(toast.toast).toHaveBeenCalledWith(expect.stringContaining('v0.5.2'), 'success');
    });

    it('keeps an unacknowledged failure on screen without re-toasting, and a dismissal sticks', async () => {
      window.localStorage.setItem('ninedeploy.updateAnnounced', 'failed:v0.5.3:2026-09-04T10:00:00Z');
      mockOf(api.system.updateStatus).mockResolvedValue(
        status({ phase: 'failed', targetVersion: 'v0.5.3', finishedAt: '2026-09-04T10:00:00Z', errorTail: 'boom' }),
      );
      const first = renderHookWith();
      await waitFor(() => expect(first.result.current.phase).toBe('failed'));
      expect(toast.toast).not.toHaveBeenCalled();
      act(() => first.result.current.clearFailure());
      first.unmount();

      const again = renderHookWith();
      await waitFor(() => expect(again.result.current.ready).toBe(true));
      await waitFor(() => expect(again.result.current.phase).toBe('idle'));
      expect(toast.toast).not.toHaveBeenCalled();
    });
  });
});
