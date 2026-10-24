import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { FrameSealer } from '../../src/lib/agentFrameCipher.js';
import { StudioRelayChannel, STUDIO_RELAY_WINDOW, type StudioRelayChannelOptions, type StudioRelaySocket } from '../../src/lib/studioRelayChannel.js';
import { STUDIO_RELAY_FRAME as F, STUDIO_RELAY_MAX_HEAD, encodeStudioEnd, encodeStudioResponseHead } from '../../src/lib/studioRelayProtocol.js';

const live: StudioRelayChannel[] = [];
afterEach(() => { for (const channel of live.splice(0)) channel.abort(); vi.useRealTimers(); });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function standalone(side: 'panel' | 'agent', opts: StudioRelayChannelOptions = {}, socket?: StudioRelaySocket) {
  const key = randomBytes(32), packets: Buffer[] = [], close = vi.fn();
  const channel = new StudioRelayChannel(side, key, socket ?? { bufferedAmount: 0, send: bytes => packets.push(bytes), close }, opts);
  live.push(channel);
  return { channel, key, packets, close };
}
function pair(options: { panel?: StudioRelayChannelOptions; agent?: StudioRelayChannelOptions } = {}) {
  const key = randomBytes(32), packets: Array<{ from: string; bytes: Buffer }> = [];
  let panel: StudioRelayChannel, agent: StudioRelayChannel;
  const close = () => queueMicrotask(() => { panel.socketClosed(); agent.socketClosed(); });
  panel = new StudioRelayChannel('panel', key, { bufferedAmount: 0, close, send: bytes => { packets.push({ from: 'panel', bytes }); queueMicrotask(() => agent.receive(bytes)); } }, options.panel);
  agent = new StudioRelayChannel('agent', key, { bufferedAmount: 0, close, send: bytes => { packets.push({ from: 'agent', bytes }); queueMicrotask(() => panel.receive(bytes)); } }, options.agent);
  live.push(panel, agent);
  return { panel, agent, packets };
}

describe('encrypted duplex Studio HTTP channel', () => {
  it('exchanges multi-window binary request/response bodies, exact hashes and duplicate headers', async () => {
    const request = randomBytes(2 * 1024 * 1024 + 17), response = randomBytes(3 * 1024 * 1024 + 31);
    const { panel, agent, packets } = pair({ panel: { expectedOutgoingBytes: request.length }, agent: { expectedIncomingBytes: request.length } });
    const input = buffer(agent.readable), output = buffer(panel.readable);
    panel.start();
    await agent.ready;
    const head = { status: 200, headers: [['content-type', 'application/octet-stream'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']] as [string, string][] };
    agent.sendHead(head);
    panel.writable.end(request);
    agent.writable.end(response);
    const [gotRequest, gotResponse, sent, received] = await Promise.all([input, output, panel.done, agent.done]);
    expect(gotRequest.equals(request)).toBe(true); expect(gotResponse.equals(response)).toBe(true);
    expect(await panel.head).toEqual(head);
    expect(sent.sent).toEqual({ bytes: request.length, sha256: digest(request) });
    expect(sent.received).toEqual({ bytes: response.length, sha256: digest(response) });
    expect(received.sent).toEqual(sent.received); expect(received.received).toEqual(sent.sent);
    expect(packets.every(packet => packet.bytes.length <= STUDIO_RELAY_MAX_HEAD + 25)).toBe(true);
    expect(packets.some(packet => packet.bytes.includes(request.subarray(0, 32)))).toBe(false);
  });
  it('supports a zero-byte request and response', async () => {
    const { panel, agent } = pair({ agent: { expectedIncomingBytes: 0 } });
    panel.start(); await agent.ready;
    agent.sendHead({ status: 204, headers: [] });
    panel.writable.end(); agent.writable.end();
    const [result] = await Promise.all([panel.done, agent.done]);
    expect(result.sent.bytes).toBe(0); expect(result.received.bytes).toBe(0);
  });
  it('holds a slow consumer within its credit window, then resumes without loss', async () => {
    const body = randomBytes(1024 * 1024 + 1), { panel, agent } = pair();
    panel.start(); await agent.ready;
    const completed = vi.fn(); panel.writable.write(body, completed);
    await nextTurn();
    expect(completed).not.toHaveBeenCalled();
    expect(agent.readable.readableLength).toBeGreaterThan(0);
    expect(agent.readable.readableLength).toBeLessThanOrEqual(STUDIO_RELAY_WINDOW);
    const received = buffer(agent.readable), response = buffer(panel.readable);
    agent.sendHead({ status: 200, headers: [] }); agent.writable.end(); panel.writable.end();
    await Promise.all([panel.done, agent.done]);
    expect((await received).equals(body)).toBe(true); expect(await response).toEqual(Buffer.alloc(0));
    expect(completed).toHaveBeenCalledOnce();
  });
  it('never starts upstream before a valid first authenticated frame', async () => {
    const upstream = vi.fn(), { channel, key } = standalone('agent', { onAuthenticated: upstream });
    channel.receive(new FrameSealer(randomBytes(32), 'panel').seal(F.start));
    await expect(channel.done).rejects.toThrow('integrity');
    await nextTurn(); expect(upstream).not.toHaveBeenCalled();
    const valid = standalone('agent', { onAuthenticated: upstream });
    valid.channel.receive(new FrameSealer(valid.key, 'panel').seal(F.start));
    await valid.channel.ready; await nextTurn(); expect(upstream).toHaveBeenCalledOnce();
    expect(key).toHaveLength(32);
  });
  it('releases sender credit after one exact-window read without needing another read call', async () => {
    const { panel, agent } = pair(); panel.start(); await agent.ready;
    const written = vi.fn(); panel.writable.write(Buffer.alloc(STUDIO_RELAY_WINDOW + 1, 1), written);
    await nextTurn();
    expect(agent.readable.readableLength).toBe(STUDIO_RELAY_WINDOW);
    expect((agent.readable.read(STUDIO_RELAY_WINDOW) as Buffer).length).toBe(STUDIO_RELAY_WINDOW);
    await nextTurn();
    expect(agent.readable.readableLength).toBe(1);
    expect(written).toHaveBeenCalledOnce();
  });
  it.each([F.data, F.head, F.end, F.resume])('rejects frame %s as an unauthenticated first frame', async type => {
    const { channel, key } = standalone('agent');
    channel.receive(new FrameSealer(key, 'panel').seal(type));
    await expect(channel.done).rejects.toThrow('integrity');
  });
  it.each(['replay', 'gap', 'tag', 'oversize'])('rejects %s frames and poisons the exchange', async mode => {
    const { channel, key } = standalone('agent'), tx = new FrameSealer(key, 'panel');
    const start = tx.seal(F.start); channel.receive(start);
    let frame = tx.seal(F.data, Buffer.from('a'));
    if (mode === 'replay') frame = start;
    if (mode === 'gap') frame = tx.seal(F.data, Buffer.from('b'));
    if (mode === 'tag') frame[frame.length - 1] ^= 1;
    if (mode === 'oversize') frame = Buffer.alloc(STUDIO_RELAY_MAX_HEAD + 26);
    channel.receive(frame); await expect(channel.done).rejects.toThrow('integrity');
    channel.receive(tx.seal(F.data, Buffer.from('late')));
    expect(channel.readable.destroyed).toBe(true);
  });
  it.each(['wrong-hash', 'wrong-count', 'truncated-request', 'extra-body', 'duplicate-end'])('rejects %s without accepting completion', async mode => {
    const { channel, key } = standalone('agent', { expectedIncomingBytes: mode === 'truncated-request' ? 2 : undefined });
    const tx = new FrameSealer(key, 'panel'), bytes = Buffer.from('a');
    channel.receive(tx.seal(F.start)); channel.receive(tx.seal(F.data, bytes));
    const end = { bytes: mode === 'wrong-count' ? 2 : 1, sha256: mode === 'wrong-hash' ? '0'.repeat(64) : digest(bytes) };
    channel.receive(tx.seal(F.end, encodeStudioEnd(end)));
    if (mode === 'extra-body') channel.receive(tx.seal(F.data, bytes));
    if (mode === 'duplicate-end') channel.receive(tx.seal(F.end, encodeStudioEnd(end)));
    await expect(channel.done).rejects.toThrow('integrity');
  });
  it('refuses a sender that ignores receive credit', async () => {
    const { channel, key } = standalone('agent'), tx = new FrameSealer(key, 'panel');
    channel.receive(tx.seal(F.start));
    for (let i = 0; i <= STUDIO_RELAY_WINDOW / 32768; i++) channel.receive(tx.seal(F.data, Buffer.alloc(32768)));
    await expect(channel.done).rejects.toThrow('integrity');
    expect(channel.readable.readableLength).toBeLessThanOrEqual(STUDIO_RELAY_WINDOW);
  });
  it.each([0, 9])('rejects malformed consumption-credit length %s', async size => {
    const { channel, key } = standalone('panel'); channel.start();
    channel.receive(new FrameSealer(key, 'agent').seal(F.resume, Buffer.alloc(size)));
    await expect(channel.done).rejects.toThrow('integrity');
  });
  it('rejects forged and regressing consumption acknowledgements', async () => {
    for (const values of [[4], [3, 2]]) {
      const { channel, key } = standalone('panel'), tx = new FrameSealer(key, 'agent'); channel.start();
      channel.writable.write(Buffer.from('abc'));
      for (const value of values) { const ack = Buffer.alloc(8); ack.writeBigUInt64BE(BigInt(value)); channel.receive(tx.seal(F.resume, ack)); }
      await expect(channel.done).rejects.toThrow('integrity');
    }
  });
  it('refuses response bytes/end before response headers and invalid/duplicate headers', async () => {
    for (const kind of ['data', 'end', 'invalid-head', 'duplicate-head']) {
      const { channel, key } = standalone('panel'), tx = new FrameSealer(key, 'agent'); channel.start();
      if (kind === 'data') channel.receive(tx.seal(F.data, Buffer.from('a')));
      if (kind === 'end') channel.receive(tx.seal(F.end, encodeStudioEnd({ bytes: 0, sha256: digest(Buffer.alloc(0)) })));
      if (kind === 'invalid-head') channel.receive(tx.seal(F.head, Buffer.from('{"status":101,"headers":[]}')));
      if (kind === 'duplicate-head') { const head = encodeStudioResponseHead({ status: 200, headers: [] }); channel.receive(tx.seal(F.head, head)); channel.receive(tx.seal(F.head, head)); }
      await expect(channel.done).rejects.toThrow('integrity');
    }
  });
  it('rejects outgoing/incoming bounds and an outgoing request length mismatch', async () => {
    const send = standalone('panel', { maxBytes: 2 }); send.channel.start(); send.channel.writable.end(Buffer.from('abc'));
    await expect(send.channel.done).rejects.toThrow('byte limit');
    const receive = standalone('agent', { maxBytes: 2 }), tx = new FrameSealer(receive.key, 'panel');
    receive.channel.receive(tx.seal(F.start)); receive.channel.receive(tx.seal(F.data, Buffer.from('abc')));
    await expect(receive.channel.done).rejects.toThrow('integrity');
    const length = standalone('panel', { expectedOutgoingBytes: 2 }); length.channel.start(); length.channel.writable.end(Buffer.from('a'));
    await expect(length.channel.done).rejects.toThrow('length');
  });
  it('ends on browser/socket cancellation and settles an outstanding write', async () => {
    const { panel, agent } = pair(); panel.start(); await agent.ready;
    const callback = vi.fn(); panel.writable.write(Buffer.alloc(1024 * 1024), callback);
    await nextTurn(); panel.socketClosed();
    await expect(panel.done).rejects.toThrow('before completion');
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    panel.socketClosed(); panel.abort();
  });
  it('fails a throwing transport and an upstream startup failure', async () => {
    const failed = standalone('panel', {}, { bufferedAmount: 0, send: () => { throw Error('private transport diagnostic'); }, close: () => undefined });
    failed.channel.start(); await expect(failed.channel.done).rejects.toThrow('transport failed');
    const upstream = standalone('agent', { onAuthenticated: async () => { throw Error('private credential'); } });
    upstream.channel.receive(new FrameSealer(upstream.key, 'panel').seal(F.start));
    await expect(upstream.channel.done).rejects.toThrow('upstream could not start');
  });
  it.each(['readable', 'writable'] as const)('cancels the exchange when its %s is destroyed early', async stream => {
    const { channel } = standalone('panel'); channel.start();
    channel[stream].destroy();
    await expect(channel.done).rejects.toThrow('disconnected');
  });
  it('waits for socket backpressure to drain and releases a blocked writer on timeout', async () => {
    vi.useFakeTimers();
    let bufferedAmount = 8 * 1024 * 1024;
    const sent: Buffer[] = [], socket = { get bufferedAmount() { return bufferedAmount; }, send: (bytes: Buffer) => { sent.push(bytes); }, close: vi.fn() };
    const { channel } = standalone('panel', { hardTimeoutMs: 1000 }, socket); channel.start();
    const written = vi.fn(); channel.writable.write(Buffer.from('body'), written);
    expect(written).not.toHaveBeenCalled();
    bufferedAmount = 0; await vi.advanceTimersByTimeAsync(21);
    expect(written).toHaveBeenCalledOnce(); expect(sent).toHaveLength(2);
    bufferedAmount = 8 * 1024 * 1024;
    const blocked = vi.fn(); channel.writable.write(Buffer.from('next'), blocked);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(channel.done).rejects.toThrow('lifetime');
    expect(blocked).toHaveBeenCalledWith(expect.any(Error)); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['auth', 'idle', 'hard'])('bounds %s waits and removes timers after failure', async kind => {
    vi.useFakeTimers();
    const { channel } = standalone('panel', { authTimeoutMs: kind === 'auth' ? 10 : 1000, idleTimeoutMs: kind === 'idle' ? 10 : 1000, hardTimeoutMs: kind === 'hard' ? 10 : 1000 });
    if (kind !== 'auth') channel.start();
    await vi.advanceTimersByTimeAsync(11);
    await expect(channel.done).rejects.toThrow(/authenticated|progress|lifetime/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([{ maxBytes: 0 }, { maxBytes: Number.NaN }, { expectedIncomingBytes: -1 }, { expectedOutgoingBytes: 1.5 }, { idleTimeoutMs: 0 }, { hardTimeoutMs: 600001 }])('rejects invalid channel limits %j before creating timers', opts => {
    expect(() => standalone('panel', opts)).toThrow('Invalid Studio relay');
  });
});
