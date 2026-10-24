import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { FRAME_DATA_CHUNK, FrameOpener, FrameSealer } from './agentFrameCipher.js';
import {
  STUDIO_RELAY_FRAME as F, STUDIO_RELAY_FRAME_TYPES, STUDIO_RELAY_MAX_BODY, STUDIO_RELAY_MAX_HEAD,
  decodeStudioEnd, decodeStudioResponseHead, encodeStudioEnd, encodeStudioResponseHead,
  type StudioRelayEnd, type StudioRelayResponseHead,
} from './studioRelayProtocol.js';

export interface StudioRelaySocket {
  readonly bufferedAmount: number;
  send(frame: Buffer): void;
  close(code: number, reason: string): void;
}
export interface StudioRelayChannelOptions {
  maxBytes?: number;
  expectedIncomingBytes?: number;
  expectedOutgoingBytes?: number;
  /** The agent opens its fixed HTTP upstream only after this authentication. */
  onAuthenticated?: () => void | Promise<void>;
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  authTimeoutMs?: number;
}
interface PendingWrite { bytes: Buffer; offset: number; callback: (error?: Error | null) => void }
const PRESSURE_BYTES = 4 * 1024 * 1024;
/** Credit bounds in-flight bytes even when TCP/WebSocket buffers drain quickly. */
export const STUDIO_RELAY_WINDOW = 256 * 1024;

/** `_read` precedes consumption, and flowing push() can bypass read(). The
 * data event covers both manual reads and pipes without forcing flowing mode. */
class StudioBodyReadable extends Readable {
  constructor(private readonly consumed: (bytes: number) => void, disconnected: () => void) {
    super({
      highWaterMark: 64 * 1024,
      read() {},
      destroy(error, callback) { callback(error); disconnected(); },
    });
  }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const delivered = super.emit(event, ...args);
    if (event === 'data' && Buffer.isBuffer(args[0])) this.consumed(args[0].length);
    return delivered;
  }
}

/**
 * One authenticated, full-duplex HTTP body exchange. The HTTP adapters own
 * identity and authorization; this class owns ordering, bytes, integrity,
 * backpressure and bounded completion. It never opens a network connection.
 */
export class StudioRelayChannel {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly head: Promise<StudioRelayResponseHead>;
  readonly ready: Promise<void>;
  readonly done: Promise<{ sent: StudioRelayEnd; received: StudioRelayEnd }>;
  private readonly rx: FrameOpener;
  private readonly tx: FrameSealer;
  private readonly rxHash = createHash('sha256');
  private readonly txHash = createHash('sha256');
  private rxBytes = 0;
  private txBytes = 0;
  private received: StudioRelayEnd | null = null;
  private sent: StudioRelayEnd | null = null;
  private authenticated = false;
  private hasHead = false;
  private ended = false;
  private remotePaused = false;
  private localPaused = false;
  private acknowledged = 0;
  private consumptionAcknowledged = 0;
  private pending: PendingWrite | null = null;
  private drainTimer: NodeJS.Timeout | undefined;
  private readonly hardTimer: NodeJS.Timeout;
  private readonly idleTimer: NodeJS.Timeout;
  private readonly authTimer: NodeJS.Timeout;
  private readonly maxBytes: number;
  private headResolve!: (head: StudioRelayResponseHead) => void;
  private headReject!: (error: Error) => void;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private doneResolve!: (result: { sent: StudioRelayEnd; received: StudioRelayEnd }) => void;
  private doneReject!: (error: Error) => void;

  constructor(
    private readonly side: 'panel' | 'agent', key: Buffer,
    private readonly socket: StudioRelaySocket,
    private readonly options: StudioRelayChannelOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? STUDIO_RELAY_MAX_BODY;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > STUDIO_RELAY_MAX_BODY) throw new Error('Invalid Studio relay byte limit');
    for (const expected of [options.expectedIncomingBytes, options.expectedOutgoingBytes]) {
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected > this.maxBytes)) throw new Error('Invalid Studio relay expected bytes');
    }
    for (const timeout of [options.hardTimeoutMs, options.idleTimeoutMs, options.authTimeoutMs]) {
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000)) throw new Error('Invalid Studio relay timeout');
    }
    this.rx = new FrameOpener(key, side === 'panel' ? 'agent' : 'panel', STUDIO_RELAY_FRAME_TYPES);
    this.tx = new FrameSealer(key, side);
    this.head = new Promise((resolve, reject) => { this.headResolve = resolve; this.headReject = reject; });
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.done = new Promise((resolve, reject) => { this.doneResolve = resolve; this.doneReject = reject; });
    // A startup failure may precede the adapter's pipeline/await installation.
    // Keep it handled while preserving rejection for every consumer.
    void this.head.catch(() => undefined);
    void this.ready.catch(() => undefined);
    void this.done.catch(() => undefined);
    this.readable = new StudioBodyReadable(bytes => this.consumed(bytes), () => {
      if (!this.received && !this.ended) this.fail('Studio relay response consumer disconnected');
    });
    this.writable = new Writable({
      highWaterMark: 64 * 1024,
      destroy: (error, callback) => {
        callback(error);
        if (!this.sent && !this.ended) this.fail('Studio relay body producer disconnected');
      },
      write: (chunk: Buffer, _encoding, callback) => {
        this.pending = { bytes: chunk, offset: 0, callback };
        this.pump();
      },
      final: callback => {
        if (!this.authenticated || (side === 'agent' && !this.hasHead)) { this.fail('Studio relay body ended before headers'); return callback(new Error('Studio relay body ended before headers')); }
        if (options.expectedOutgoingBytes !== undefined && this.txBytes !== options.expectedOutgoingBytes) { this.fail('Studio relay request length changed'); return callback(new Error('Studio relay request length changed')); }
        this.sent = { bytes: this.txBytes, sha256: this.txHash.digest('hex') };
        this.send(F.end, encodeStudioEnd(this.sent));
        callback();
        this.complete();
      },
    });
    this.readable.on('error', () => undefined);
    this.writable.on('error', () => undefined);
    this.hardTimer = setTimeout(() => this.fail('Studio relay exceeded its lifetime'), options.hardTimeoutMs ?? 600_000);
    this.idleTimer = setTimeout(() => this.fail('Studio relay stopped making progress'), options.idleTimeoutMs ?? 60_000);
    this.authTimer = setTimeout(() => this.fail('Studio relay was not authenticated'), options.authTimeoutMs ?? 10_000);
    this.hardTimer.unref(); this.idleTimer.unref(); this.authTimer.unref();
  }

  /** Panel's first encrypted frame; the channel id alone never starts HTTP. */
  start(): void {
    if (this.side !== 'panel' || this.authenticated || this.ended) throw new Error('Invalid Studio relay start');
    this.authenticated = true;
    clearTimeout(this.authTimer);
    this.readyResolve();
    this.send(F.start);
    this.pump();
  }

  sendHead(head: StudioRelayResponseHead): void {
    if (this.side !== 'agent' || !this.authenticated || this.hasHead || this.ended) throw new Error('Invalid Studio relay response headers');
    const bytes = encodeStudioResponseHead(head);
    this.hasHead = true;
    this.send(F.head, bytes);
  }

  receive(bytes: Buffer): void {
    if (this.ended) return;
    try {
      if (bytes.length > STUDIO_RELAY_MAX_HEAD + 25) throw new Error('oversized frame');
      const frame = this.rx.open(bytes);
      if (!this.authenticated) {
        if (this.side !== 'agent' || frame.type !== F.start || frame.payload.length) throw new Error('unauthenticated channel');
        this.authenticated = true;
        clearTimeout(this.authTimer);
        this.idleTimer.refresh();
        this.readyResolve();
        void Promise.resolve().then(() => this.options.onAuthenticated?.()).catch(() => this.fail('Studio relay upstream could not start'));
        return;
      }
      if (frame.type === F.pause || frame.type === F.resume) {
        if (frame.type === F.pause && frame.payload.length) throw new Error('invalid pause');
        if (frame.type === F.resume) {
          if (frame.payload.length !== 8) throw new Error('invalid credit');
          const consumed = frame.payload.readBigUInt64BE();
          if (consumed > BigInt(this.txBytes) || consumed < BigInt(this.acknowledged)) throw new Error('invalid credit');
          this.acknowledged = Number(consumed);
        }
        this.remotePaused = frame.type === F.pause;
        if (!this.remotePaused) this.pump();
        return;
      }
      if (frame.type === F.error || frame.type === F.close) { this.fail('Studio relay peer ended the exchange', false); return; }
      if (frame.type === F.head) {
        if (this.side !== 'panel' || this.hasHead || this.received) throw new Error('unexpected headers');
        const head = decodeStudioResponseHead(frame.payload);
        this.hasHead = true;
        this.headResolve(head);
      } else if (frame.type === F.data) {
        if (this.received || (this.side === 'panel' && !this.hasHead) || !frame.payload.length || frame.payload.length > FRAME_DATA_CHUNK) throw new Error('unexpected body');
        this.rxBytes += frame.payload.length;
        if (this.rxBytes > this.maxBytes || (this.options.expectedIncomingBytes !== undefined && this.rxBytes > this.options.expectedIncomingBytes)) throw new Error('body limit');
        if (this.rxBytes - this.consumptionAcknowledged > STUDIO_RELAY_WINDOW) throw new Error('receiver credit exceeded');
        this.rxHash.update(frame.payload);
        if (!this.readable.push(frame.payload) && !this.localPaused) { this.localPaused = true; this.send(F.pause); }
      } else if (frame.type === F.end) {
        if (this.received || (this.side === 'panel' && !this.hasHead)) throw new Error('unexpected end');
        const end = decodeStudioEnd(frame.payload);
        if (end.bytes !== this.rxBytes || end.sha256 !== this.rxHash.digest('hex') || (this.options.expectedIncomingBytes !== undefined && end.bytes !== this.options.expectedIncomingBytes)) throw new Error('body integrity');
        this.received = end;
        this.readable.push(null);
        this.complete();
      } else throw new Error('unexpected frame');
      if (!this.ended) this.idleTimer.refresh();
    } catch { this.fail('Studio relay frame or body integrity was rejected'); }
  }

  socketClosed(): void { this.complete(); if (!this.ended) this.fail('Studio relay ended before completion', false); }
  abort(): void { this.fail('Studio relay was cancelled'); }

  private consumed(bytes: number): void {
    if (!this.authenticated || this.ended || bytes === 0) return;
    this.consumptionAcknowledged += bytes;
    if (this.consumptionAcknowledged > this.rxBytes) { this.fail('Studio relay consumer exceeded received bytes'); return; }
    this.localPaused = false;
    const ack = Buffer.alloc(8); ack.writeBigUInt64BE(BigInt(this.consumptionAcknowledged));
    this.send(F.resume, ack);
  }

  private send(type: (typeof F)[keyof typeof F], payload: Buffer = Buffer.alloc(0)): void {
    if (this.ended) return;
    try { this.socket.send(this.tx.seal(type, payload)); } catch { this.fail('Studio relay transport failed', false); }
  }

  private pump(): void {
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = undefined; }
    const pending = this.pending;
    if (!pending || this.ended || !this.authenticated || this.remotePaused) return;
    if (this.side === 'agent' && !this.hasHead) { this.fail('Studio relay body preceded response headers'); return; }
    while (pending.offset < pending.bytes.length && !this.ended && !this.remotePaused) {
      const credit = STUDIO_RELAY_WINDOW - (this.txBytes - this.acknowledged);
      if (credit === 0) return;
      if (this.socket.bufferedAmount >= PRESSURE_BYTES) {
        this.drainTimer = setTimeout(() => this.pump(), 20); this.drainTimer.unref(); return;
      }
      const part = pending.bytes.subarray(pending.offset, pending.offset + Math.min(FRAME_DATA_CHUNK, credit));
      if (this.txBytes + part.length > this.maxBytes) { this.fail('Studio relay body exceeds its byte limit'); return; }
      this.txBytes += part.length;
      this.txHash.update(part);
      pending.offset += part.length;
      this.send(F.data, part);
      if (!this.ended) this.idleTimer.refresh();
    }
    if (!this.ended && pending.offset === pending.bytes.length) { this.pending = null; pending.callback(); }
  }

  private cleanup(): void {
    clearTimeout(this.authTimer); clearTimeout(this.hardTimer); clearTimeout(this.idleTimer); clearTimeout(this.drainTimer);
  }
  private complete(): void {
    if (this.ended || !this.sent || !this.received) return;
    this.ended = true;
    this.cleanup();
    this.doneResolve({ sent: this.sent, received: this.received });
    try { this.socket.close(1000, 'Studio relay complete'); } catch { /* already closed */ }
  }
  private fail(message: string, notify = true): void {
    if (this.ended) return;
    if (notify) this.send(F.error);
    if (this.ended) return;
    this.ended = true;
    this.cleanup();
    const error = new Error(message), pending = this.pending;
    this.pending = null;
    pending?.callback(error);
    this.readable.destroy(error); this.writable.destroy(error);
    this.headReject(error); this.readyReject(error); this.doneReject(error);
    try { this.socket.close(1011, 'Studio relay failed'); } catch { /* already closed */ }
  }
}
