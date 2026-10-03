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

  it('r565: a reconnect after the buffer was trimmed neither doubles nor drops the log', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    // > 512 KiB of numbered lines: the retained buffer gets trimmed, so what
    // the hook holds no longer starts at the head of the log.
    const backlog = Array.from({ length: 70_000 }, (_, i) => `line-${i}\n`).join('');
    act(() => first.message(backlog));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines.startsWith('line-0\n')).toBe(false);
    act(() => first.message('line-70000\n'));
    act(() => first.closeFromServer());
    act(() => vi.advanceTimersByTime(2000));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    // The server replays the WHOLE log file, plus a line published while
    // the socket was down.
    act(() => second.message(`${backlog}line-70000\nline-70001\n`));
    act(() => second.message('line-70002\n')); // live
    act(() => vi.advanceTimersByTime(200));
    const lines = result.current.lines;
    expect(lines.endsWith('line-69999\nline-70000\nline-70001\nline-70002\n')).toBe(true);
    for (const marker of ['line-69999\n', 'line-70000\n', 'line-70001\n', 'line-65000\n']) {
      expect(lines.split(marker).length - 1).toBe(1);
    }
    vi.useRealTimers();
  });

  it('r565: a replay that adds nothing new appends nothing', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message('a\nb\n'));
    act(() => first.closeFromServer());
    act(() => vi.advanceTimersByTime(2000));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    act(() => second.message('a\nb\n'));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('a\nb\n');
    vi.useRealTimers();
  });

  it('r565: a first frame that is not a replay of what we hold is appended, not swallowed', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message('a\nb\n'));
    act(() => first.closeFromServer());
    act(() => vi.advanceTimersByTime(2000));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    // No backlog on the server side (the file is gone) — the first frame is
    // a live line and must be kept.
    act(() => second.message('c\n'));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('a\nb\nc\n');
    vi.useRealTimers();
  });

  it('r565: a short held log is not mistaken for a replay just because the next frame contains it', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeployLogs(1, 2));
    const first = FakeWebSocket.instances[0]!;
    act(() => first.open());
    act(() => first.message('ok\n'));
    act(() => first.closeFromServer());
    act(() => vi.advanceTimersByTime(2000));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    // The server had no backlog to replay, so the first frame is a live line
    // that merely CONTAINS what we hold. The old substring check took it for
    // a replay and threw the held log away.
    act(() => second.message('build ok\n'));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.lines).toBe('ok\nbuild ok\n');
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
