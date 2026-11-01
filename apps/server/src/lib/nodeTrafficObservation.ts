import { randomBytes } from 'node:crypto';
import { proxyTrafficWindowId, proxyTrafficSample, type ProxyTrafficOpen, type ProxyTrafficSnapshot, type ServingTrafficOpen } from '@ninedeploy/schemas';
import { proxyTrafficTargetHash, proxyTrafficRoutingGeneration, proxyTrafficUnavailable } from './proxyTrafficCounter.js';
import type { NodeProxyTrafficIO } from './nodeProxyTrafficDocker.js';

export const PROXY_TRAFFIC_MAX_SESSIONS = 16;
const opaque = () => randomBytes(16).toString('hex');
type TrafficObservationInput = ProxyTrafficOpen | ServingTrafficOpen;
type CounterFields = Pick<ProxyTrafficSnapshot, 'startCounter' | 'endCounter' | 'observed' | 'expected' | 'complete'>;
type ReceiptFields = Omit<ProxyTrafficSnapshot, 'step' | 'stable' | 'canary'>;
interface TrafficCounter {
  startPath: string; endPath: string;
  ingest(line: string): void; started(): boolean; ended(): boolean; requestFinish(): void; snapshot(): CounterFields;
}
export interface ObservationDefinition<Input, Snapshot> {
  markerTiming?: boolean;
  parse(params: unknown): Input;
  counter(input: Input, windowId: string): TrafficCounter;
  snapshot(input: Input, fields: ReceiptFields): Snapshot;
}
interface Session<Input extends TrafficObservationInput, Snapshot> {
  id: string; input: Input; routingGeneration: string; hash: string; counter?: TrafficCounter;
  identity?: { proxyId: string; sourceId: string }; connection?: ReturnType<NodeProxyTrafficIO['connect']>;
  startedAt: number; deadline: number; busy: boolean; closed: boolean; fault?: Error; result?: Snapshot;
  observedStartedAt?: number; observedEndedAt?: number;
  opening?: Promise<Snapshot>; failure: Promise<never>; reject: (error: Error) => void; timer?: NodeJS.Timeout;
}

/** Bounded reservations only; a missing/expired session can never return empty metrics. */
export class NodeTrafficObservation<Input extends TrafficObservationInput, Snapshot> {
  private epoch = opaque();
  private readonly sessions = new Map<string, Session<Input, Snapshot>>();
  private readonly requests = new Map<string, Session<Input, Snapshot>>();
  constructor(private readonly io: NodeProxyTrafficIO<Input>, private readonly definition: ObservationDefinition<Input, Snapshot>, private readonly now = () => performance.now(), private readonly enabled = () => true) {}

  private forget(s: Session<Input, Snapshot>) {
    clearTimeout(s.timer); this.sessions.delete(s.id);
    if (this.requests.get(s.input.requestId) === s) this.requests.delete(s.input.requestId);
  }
  private release(s: Session<Input, Snapshot>, reason = 'window closed') {
    if (s.closed) return;
    s.closed = true; s.fault = proxyTrafficUnavailable(reason); s.reject(s.fault);
    const connection = s.connection; s.connection = undefined; connection?.close(); s.counter = undefined; s.input = { ...s.input, routingConfig: '' };
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.forget(s), 60_000); s.timer.unref();
  }
  private arm(s: Session<Input, Snapshot>) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.release(s, 'window expired'), Math.max(0, Math.min(30_000, s.deadline - this.now()))); s.timer.unref();
  }
  private live(s: Session<Input, Snapshot>) {
    if (!this.enabled() && !s.closed) this.release(s, 'node owner disabled observations');
    if (s.fault || s.closed) throw s.fault ?? proxyTrafficUnavailable('window closed');
    if (!s.result && this.now() > s.deadline) { this.release(s, 'window expired'); throw s.fault!; }
  }
  private async guard<T>(s: Session<Input, Snapshot>, promise: Promise<T>): Promise<T> {
    const value = await Promise.race([promise, s.failure]); this.live(s); return value;
  }
  private async verify(s: Session<Input, Snapshot>) {
    try {
      const actual = await this.guard(s, this.io.inspect(s.input));
      if (actual.proxyId !== s.identity?.proxyId || actual.sourceId !== s.identity?.sourceId) throw proxyTrafficUnavailable('proxy restarted or was replaced');
    } catch { this.release(s, 'routing or proxy source changed or unavailable'); throw s.fault!; }
  }
  private receipt(s: Session<Input, Snapshot>): Snapshot {
    this.live(s);
    if (s.result) return s.result;
    const startedAt = this.definition.markerTiming ? s.observedStartedAt : s.startedAt;
    if (startedAt === undefined) throw proxyTrafficUnavailable('start marker timing unavailable');
    const endedAt = this.definition.markerTiming ? s.observedEndedAt ?? this.now() : this.now();
    return this.definition.snapshot(s.input, { protocol: 1, basis: 'traefik-request-sequence', precisionMs: 1,
      windowId: s.id, requestId: s.input.requestId, epoch: this.epoch, targetHash: s.hash, routingGeneration: s.routingGeneration,
      sourceId: s.identity!.sourceId, proxyId: s.identity!.proxyId, nodeId: s.input.nodeId, serviceId: s.input.serviceId,
      deploymentId: s.input.deploymentId, elapsedMs: Math.max(0, Math.floor(endedAt - startedAt)), ...s.counter!.snapshot() });
  }
  private async until(s: Session<Input, Snapshot>, condition: () => boolean, milliseconds: number) {
    const end = this.now() + milliseconds;
    while (!condition()) {
      this.live(s);
      if (this.now() >= end) throw proxyTrafficUnavailable('marker or request records are missing or still pending');
      await this.guard(s, new Promise<void>(resolve => setTimeout(resolve, 10)));
    }
  }

  async open(params: unknown): Promise<Snapshot> {
    if (!this.enabled()) throw proxyTrafficUnavailable('node owner disabled observations');
    const input = this.definition.parse(params), routingGeneration = proxyTrafficRoutingGeneration(input), hash = proxyTrafficTargetHash(input);
    const previous = this.requests.get(input.requestId);
    if (previous) {
      if (previous.hash !== hash) throw proxyTrafficUnavailable('reservation identity changed');
      this.live(previous); return previous.result ?? previous.opening!;
    }
    if ([...this.sessions.values()].filter(s => !s.closed && !s.result).length >= PROXY_TRAFFIC_MAX_SESSIONS) throw proxyTrafficUnavailable('too many active windows');
    if (this.sessions.size >= 128) for (const s of this.sessions.values()) { if (s.closed || s.result) { this.forget(s); break; } }
    let reject!: (error: Error) => void;
    const failure = new Promise<never>((_yes, no) => { reject = no; }); void failure.catch(() => undefined);
    const s: Session<Input, Snapshot> = { id: opaque(), input, routingGeneration, hash, startedAt: this.now(), deadline: this.now() + 10_000,
      busy: true, closed: false, counter: undefined, failure, reject };
    s.counter = this.definition.counter(input, s.id); this.sessions.set(s.id, s); this.requests.set(input.requestId, s); this.arm(s);
    s.opening = this.initialize(s); return s.opening;
  }
  private async initialize(s: Session<Input, Snapshot>): Promise<Snapshot> {
    try {
      s.identity = await this.guard(s, this.io.inspect(s.input));
      s.connection = this.io.connect(s.identity.proxyId, line => {
        if (s.closed || s.result) return;
        try {
          this.live(s); s.counter!.ingest(line);
          // Rates cover the two observed sequence markers; source verification
          // after the end marker must not lengthen the measurement interval.
          if (this.definition.markerTiming) {
            if (s.observedStartedAt === undefined && s.counter!.started()) s.observedStartedAt = this.now();
            if (s.observedEndedAt === undefined && s.counter!.ended()) s.observedEndedAt = this.now();
          }
        } catch { this.release(s, 'log records are invalid or incomplete'); }
      }, () => { if (!s.result && !s.closed) this.release(s, 'log stream unavailable'); });
      this.live(s);
      await this.guard(s, Promise.all([s.connection.ready, this.io.heartbeat(s.identity.proxyId, s.counter!.startPath)]));
      await this.until(s, () => s.counter!.started(), 5000);
      await this.verify(s); s.startedAt = this.now(); s.deadline = s.startedAt + s.input.durationMs + 20_000; s.busy = false; this.arm(s);
      return this.receipt(s);
    } catch {
      this.release(s, 'observation could not be opened'); s.connection?.close(); s.connection = undefined;
      throw s.fault!;
    }
  }
  async sample(params: unknown) {
    const { windowIds } = proxyTrafficSample.parse(params);
    if (new Set(windowIds).size !== windowIds.length) throw proxyTrafficUnavailable('duplicate window identity');
    return Promise.all(windowIds.map(async windowId => {
      try {
        const s = this.get(windowId); if (s.busy) throw proxyTrafficUnavailable('window operation is pending');
        if (!s.result) {
          s.busy = true;
          try { await this.verify(s); this.arm(s); } finally { s.busy = false; }
        }
        return { ok: true as const, snapshot: this.receipt(s) };
      } catch { return { ok: false as const, windowId, reason: 'Observation unavailable; reopen after confirming the node source' }; }
    }));
  }
  private get(id: string) { const s = this.sessions.get(id); if (!s) throw proxyTrafficUnavailable('window unknown or expired'); this.live(s); return s; }
  async finish(params: unknown): Promise<Snapshot> {
    const { windowId } = proxyTrafficWindowId.parse(params), s = this.get(windowId);
    if (s.result) return s.result;
    if (s.busy) throw proxyTrafficUnavailable('window operation is pending');
    if (this.now() - s.startedAt < s.input.durationMs) throw proxyTrafficUnavailable('observation duration is not complete');
    s.busy = true;
    try {
      await this.verify(s); s.counter!.requestFinish();
      await this.guard(s, this.io.heartbeat(s.identity!.proxyId, s.counter!.endPath));
      await this.until(s, () => s.counter!.snapshot().complete, 5000); await this.verify(s);
      s.result = this.receipt(s); s.connection?.close(); s.connection = undefined; s.counter = undefined; s.input = { ...s.input, routingConfig: '' }; s.busy = false;
      clearTimeout(s.timer); s.timer = setTimeout(() => this.forget(s), 60_000); s.timer.unref(); return s.result;
    } catch { this.release(s, 'final observation incomplete or source changed'); throw s.fault!; }
  }
  close(params: unknown) { const { windowId } = proxyTrafficWindowId.parse(params); const s = this.sessions.get(windowId); if (s) this.release(s); return { windowId, closed: true }; }
  closeAll() { for (const s of this.sessions.values()) { this.release(s); this.forget(s); } this.epoch = opaque(); }
  activeCount() { return [...this.sessions.values()].filter(s => !s.closed && !s.result).length; }
}

export const trafficObservationsEnabled = () => {
  const value = (process.env.NINEDEPLOY_AGENT_PROXY_TRAFFIC ?? '').trim();
  return value !== '' && !/^(off|false|0|no|disabled)$/i.test(value);
};
