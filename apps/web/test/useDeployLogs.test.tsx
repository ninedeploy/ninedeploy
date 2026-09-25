import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from './web-utils.js';

const apiMock = vi.hoisted(() => ({
  deployLogsWsUrl: vi.fn(() => 'ws://localhost/v1/services/1/deploys/2/logs'),
  websocketAuthProtocols: vi.fn(() => ['ninedeploy.bearer.t']),
}));

vi.mock('../src/lib/api.js', () => apiMock);

import { useDeployLogs } from '../src/lib/useDeployLogs.js';

describe('useDeployLogs', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    apiMock.deployLogsWsUrl.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates no socket and stays closed when ids are null', () => {
    const { result } = renderHook(() => useDeployLogs(null, null));
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(result.current.lines).toBe('');
    expect(result.current.open).toBe(false);
  });

  it('opens a socket with the log URL and marks it open on connect', () => {
    const { result } = renderHook(() => useDeployLogs(1, 2));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(apiMock.deployLogsWsUrl).toHaveBeenCalledWith(1, 2);
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://localhost/v1/services/1/deploys/2/logs');
    expect(ws?.protocols).toEqual(['ninedeploy.bearer.t']);
    expect(result.current.open).toBe(false);

    act(() => ws?.open());
    expect(result.current.open).toBe(true);
  });

  it('appends incoming messages to the log lines', () => {
    // Chunks batch and flush on the 200ms interval (re-joining the whole log
    // per message was O(n²)) — advance the clock to reach the flush.
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const ws = FakeWebSocket.instances[0];
    act(() => ws?.message('line one\n'));
    act(() => ws?.message('line two'));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('line one\nline two');
    vi.useRealTimers();
  });

  it('ignores messages from a stale socket after the deployment changes', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ sid, did }) => useDeployLogs(sid, did), {
      initialProps: { sid: 1, did: 2 },
    });
    const first = FakeWebSocket.instances[0];
    act(() => first?.message('old'));

    rerender({ sid: 1, did: 3 });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('');

    // Stale socket still fires, but its deployment id no longer matches.
    act(() => first?.message('stale'));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('');
    act(() => second?.message('fresh'));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('fresh');
    vi.useRealTimers();
  });

  it('reconnects after an unexpected close while the deployment is still live', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const first = FakeWebSocket.instances[0];
    act(() => first?.open());
    act(() => first?.closeFromServer());
    expect(result.current.open).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.useRealTimers();
  });

  it('r209: a reconnect replaces the replayed backlog instead of appending it', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message('step 1\nstep 2\n'));
    act(() => first.closeFromServer());
    act(() => vi.advanceTimersByTime(2000));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    act(() => second.message('step 1\nstep 2\nstep 3\n')); // server backlog replay
    act(() => second.message('step 4\n')); // live
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('step 1\nstep 2\nstep 3\nstep 4\n');
    vi.useRealTimers();
  });

  it('marks the stream closed on error and on close', () => {
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const ws = FakeWebSocket.instances[0];

    act(() => ws?.open());
    expect(result.current.open).toBe(true);

    act(() => ws?.error());
    expect(result.current.open).toBe(false);

    act(() => ws?.open());
    act(() => ws?.closeFromServer());
    expect(result.current.open).toBe(false);
  });

  it('r299: an orphaned socket from an A→B→A switch neither doubles lines nor closes the live stream', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ did }) => useDeployLogs(1, did), { initialProps: { did: 2 } });
    const orphan = FakeWebSocket.instances[0]!;
    act(() => orphan.open());
    rerender({ did: 3 });
    rerender({ did: 2 }); // back to A before the first socket's close landed
    expect(FakeWebSocket.instances).toHaveLength(3);
    const live = FakeWebSocket.instances[2]!;
    act(() => live.open());
    act(() => live.message('line\n'));
    act(() => orphan.message('line\n')); // the torn-down socket still delivers
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('line\n');

    // Its (async) close must not flag the live stream closed or reconnect.
    act(() => orphan.closeFromServer());
    expect(result.current.open).toBe(true);
    act(() => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.useRealTimers();
  });

  it('closes the socket and resets on unmount', () => {
    const { unmount } = renderHook(() => useDeployLogs(1, 2));
    const ws = FakeWebSocket.instances[0];
    unmount();
    expect(ws?.close).toHaveBeenCalled();
  });
});
