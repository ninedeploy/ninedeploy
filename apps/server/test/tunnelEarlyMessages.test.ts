/**
 * G5.8: what a tunnel client sends before its target is connected is held
 * (lib/tunnelBridge.ts holdEarlyMessages) and written first, within a bound.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { bridgeTunnel, EARLY_BYTES_MAX, holdEarlyMessages } from '../src/lib/tunnelBridge.js';

function fakeSocket() {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(ee, { OPEN: 1, readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), pause: vi.fn(), resume: vi.fn() });
  return ee as never as Parameters<typeof holdEarlyMessages>[0];
}

describe('holdEarlyMessages', () => {
  it('hands over binary messages in order and stops listening', () => {
    const socket = fakeSocket();
    const take = holdEarlyMessages(socket);
    socket.emit('message', Buffer.from('a'), true);
    socket.emit('message', [Buffer.from('b'), Buffer.from('c')], true);
    const early = take();
    expect(early.refused).toBeNull();
    expect(Buffer.concat(early.chunks).toString()).toBe('abc');
    socket.emit('message', Buffer.from('late'), true);
    expect(Buffer.concat(early.chunks).toString()).toBe('abc');
  });

  it('refuses a text frame and more than the early limit', () => {
    const text = fakeSocket();
    const takeText = holdEarlyMessages(text);
    text.emit('message', Buffer.from('hi'), false);
    expect(takeText().refused).toBe('binary frames only');

    const big = fakeSocket();
    const takeBig = holdEarlyMessages(big);
    big.emit('message', Buffer.alloc(EARLY_BYTES_MAX), true);
    big.emit('message', Buffer.alloc(1), true);
    expect(takeBig().refused).toBe('too much data before the tunnel opened');
  });

  it('the bridge writes the held bytes to the target first and counts them', async () => {
    const socket = fakeSocket();
    const target = new PassThrough();
    const written: Buffer[] = [];
    target.on('data', (c: Buffer) => written.push(c));
    const onClose = vi.fn();
    bridgeTunnel({ socket: socket as never, tcp: target, release: () => undefined, stillAllowed: async () => true, onClose, label: 'test', early: [Buffer.from('first ')] });
    socket.emit('message', Buffer.from('second'), true);
    await new Promise((r) => setImmediate(r));
    expect(Buffer.concat(written).toString()).toBe('first second');
    socket.emit('close');
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ bytesIn: 12 }));
  });
});
