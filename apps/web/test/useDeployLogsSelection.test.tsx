import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FakeWebSocket } from './web-utils.js';
vi.mock('../src/lib/api.js', () => ({ deployLogsWsUrl: () => 'ws://fixture/logs', websocketAuthProtocols: () => ['fixture'] }));
const { useDeployLogs } = await import('../src/lib/useDeployLogs.js');
function nullSelectionCase(kind: 'service' | 'deployment' | 'both') {
  vi.useFakeTimers(); FakeWebSocket.instances.length = 0; vi.stubGlobal('WebSocket', FakeWebSocket);
  const view = renderHook(({ service, deployment }: { service: number | null; deployment: number | null }) => useDeployLogs(service, deployment), { initialProps: { service: 1 as number | null, deployment: 2 as number | null } });
  try {
    const old = FakeWebSocket.instances[0]!;
    act(() => { old.open(); old.message('previous\n'); vi.advanceTimersByTime(200); });
    expect(view.result.current).toEqual({ lines: 'previous\n', open: true });
    view.rerender({ service: kind === 'deployment' ? 1 : null, deployment: kind === 'service' ? 2 : null });
    act(() => { old.open(); old.message('late\n'); old.closeFromServer(); vi.advanceTimersByTime(2200); });
    return { ...view.result.current, sockets: FakeWebSocket.instances.length, closeCalls: old.close.mock.calls.length };
  } finally { view.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); }
}
function reselectionCase() {
  vi.useFakeTimers(); FakeWebSocket.instances.length = 0; vi.stubGlobal('WebSocket', FakeWebSocket);
  const view = renderHook(({ deployment }: { deployment: number | null }) => useDeployLogs(1, deployment), { initialProps: { deployment: 2 as number | null } });
  try {
    const old = FakeWebSocket.instances[0]!;
    act(() => { old.open(); old.message('previous\n'); vi.advanceTimersByTime(200); });
    view.rerender({ deployment: null });
    view.rerender({ deployment: 2 });
    const current = FakeWebSocket.instances[1]!;
    act(() => { current.open(); current.message('fresh\n'); old.message('stale\n'); old.closeFromServer(); vi.advanceTimersByTime(2200); });
    expect(view.result.current).toEqual({ lines: 'fresh\n', open: true });
    expect(FakeWebSocket.instances).toHaveLength(2);
  } finally { view.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); }
}

it.each(['service', 'deployment', 'both'] as const)('F79: clearing %s selection resets state and ignores disposed callbacks', (kind) => {
  expect(nullSelectionCase(kind)).toEqual({ lines: '', open: false, sockets: 1, closeCalls: 1 });
});
it('F79: re-selection remains owned by the new socket', () => {
  reselectionCase();
});
