import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineRequest } from '../../src/lib/dockerTty.js';

class Request extends EventEmitter {
  setTimeout = vi.fn(() => this);
  end = vi.fn();
  destroy = vi.fn((error?: Error) => { if (error) this.emit('error', error); return this; });
}
const target = { kind: 'tcp' as const, host: '127.0.0.1', port: 2375 };
let req: Request;
beforeEach(() => {
  vi.useFakeTimers(); req = new Request();
  vi.spyOn(http, 'request').mockReturnValue(req as unknown as http.ClientRequest);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Docker Engine absolute request budget', () => {
  it.each(['before-connect', 'active-response'])('expires %s even when the native idle callback does not fire', async phase => {
    let state = 'pending', failure: unknown;
    const result = engineRequest(target, 'GET', '/containers/owned/json', undefined, 50);
    const settled = result.then(() => { state = 'resolved'; }, error => { state = 'rejected'; failure = error; });
    try {
      if (phase === 'active-response') {
        const response = Object.assign(new EventEmitter(), { statusCode: 200 });
        req.emit('response', response);
        for (let i = 0; i < 6; i++) { response.emit('data', Buffer.from(' ')); await vi.advanceTimersByTimeAsync(10); }
      } else await vi.advanceTimersByTimeAsync(51);
      expect(state).toBe('rejected');
      expect(failure).toEqual(expect.objectContaining({ message: expect.stringMatching(/Docker Engine API.*timed out/) }));
      expect(req.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (state === 'pending') req.destroy(new Error('Owned fixture cleanup'));
      await settled;
    }
  });
  it('clears the budget on success and preserves the complete response', async () => {
    const result = engineRequest(target, 'GET', '/owned', undefined, 50);
    const response = Object.assign(new EventEmitter(), { statusCode: 200 }); req.emit('response', response);
    response.emit('data', Buffer.from('{"ok":')); response.emit('data', Buffer.from('true}')); response.emit('end');
    await expect(result).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    await vi.advanceTimersByTimeAsync(51); expect(req.destroy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('clears the budget on an early transport error', async () => {
    const result = engineRequest(target, 'GET', '/owned', undefined, 50);
    req.emit('error', new Error('transport lost'));
    await expect(result).rejects.toThrow('transport lost');
    await vi.advanceTimersByTimeAsync(51); expect(req.destroy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains an explicitly disabled zero timeout', async () => {
    let completed = false;
    const result = engineRequest(target, 'GET', '/owned', undefined, 0); void result.finally(() => { completed = true; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100000); expect(completed).toBe(false); expect(req.destroy).not.toHaveBeenCalled();
    req.emit('error', new Error('Owned fixture cleanup')); await expect(result).rejects.toThrow('fixture cleanup');
  });
});
