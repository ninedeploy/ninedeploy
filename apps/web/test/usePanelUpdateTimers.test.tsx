import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: {
    phase: 'idle', supported: true, targetVersion: null as string | null,
    finishedAt: null as string | null, errorTail: null,
  },
  check: { updateAvailable: false, latest: null },
  queryClient: { setQueryData: vi.fn() },
  toast: vi.fn(),
}));
vi.mock('../src/lib/auth.js', () => ({ useAuth: () => ({ user: { isOperator: true } }) }));
vi.mock('../src/components/Toast.js', () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock('../src/lib/api.js', () => ({ api: { system: { updateCheck: async () => h.check } } }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === 'update-check' ? h.check : h.status,
    isLoading: false, refetch: vi.fn(),
  }),
  useQueryClient: () => h.queryClient,
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

import { usePanelUpdate } from '../src/lib/usePanelUpdate.js';

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

it('F85: a finished run can clear only its own success banner', () => {
  vi.useFakeTimers();
  localStorage.clear();
  h.status = { phase: 'idle', supported: true, targetVersion: null, finishedAt: null, errorTail: null };
  const hook = renderHook(() => usePanelUpdate());
  const status = (phase: string, targetVersion: string, finishedAt: string | null) => {
    h.status = { phase, supported: true, targetVersion, finishedAt, errorTail: null };
    act(() => hook.rerender());
  };
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  status('success', 'v-timer-1', '2026-01-01T00:00:00Z');
  expect(hook.result.current.phase).toBe('done');
  advance(10_000);
  status('running', 'v-timer-2', null);
  expect(hook.result.current.phase).toBe('updating');
  status('success', 'v-timer-2', '2026-01-01T00:00:10Z');
  advance(2_000); // Complete the OLD run's timer after the replacement run.
  expect(hook.result.current.phase).toBe('done');
  advance(9_999);
  expect(hook.result.current.phase).toBe('done');
  advance(1);
  expect(hook.result.current.phase).toBe('idle');
  hook.unmount();
});
