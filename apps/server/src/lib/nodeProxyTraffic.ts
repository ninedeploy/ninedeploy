import { randomBytes } from 'node:crypto';
import { proxyTrafficOpen, proxyTrafficWindowId, proxyTrafficSample, proxyTrafficSnapshot, type ProxyTrafficOpen, type ProxyTrafficSnapshot } from '@ninedeploy/schemas';
import { ProxyTrafficCounter, proxyTrafficTargetHash, proxyTrafficRoutingGeneration, proxyTrafficUnavailable } from './proxyTrafficCounter.js';
import { nodeProxyTrafficDocker, type NodeProxyTrafficIO } from './nodeProxyTrafficDocker.js';

export const PROXY_TRAFFIC_MAX_SESSIONS = 16;
const opaque = () => randomBytes(16).toString('hex');
interface Session {
  id: string; input: Omit<ProxyTrafficOpen, 'routingConfig'>; routingConfig?: string; routingGeneration: string; hash: string; counter?: ProxyTrafficCounter;
  identity?: { proxyId: string; sourceId: string }; connection?: ReturnType<NodeProxyTrafficIO['connect']>;
  startedAt: number; deadline: number; busy: boolean; closed: boolean; fault?: Error; result?: ProxyTrafficSnapshot;
  opening?: Promise<ProxyTrafficSnapshot>; failure: Promise<never>; reject: (error: Error) => void; timer?: NodeJS.Timeout;
}

/** Bounded reservations only; a missing/expired session can never return empty metrics. */
export class NodeProxyTraffic {
  private epoch = opaque();
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, Session>();
  constructor(private readonly io: NodeProxyTrafficIO, private readonly now = () => performance.now(), private readonly enabled = () => true) {}

  private forget(s: Session) {
    clearTimeout(s.timer); this.sessions.delete(s.id);
    if (this.requests.get(s.input.requestId) === s) this.requests.delete(s.input.requestId);
  }
  private release(s: Session, reason = 'window closed') {
    if (s.closed) return;
    s.closed = true; s.fault = proxyTrafficUnavailable(reason); s.reject(s.fault);
    const connection = s.connection; s.connection = undefined; connection?.close(); s.counter = undefined; s.routingConfig = undefined;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.forget(s), 60_000); s.timer.unref();
  }
  private arm(s: Session) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.release(s, 'window expired'), Math.max(0, Math.min(30_000, s.deadline - this.now()))); s.timer.unref();
  }
  private live(s: Session) {
    if (!this.enabled() && !s.closed) this.release(s, 'node owner disabled observations');
    if (s.fault || s.closed) throw s.fault ?? proxyTrafficUnavailable('window closed');
    if (!s.result && this.now() > s.deadline) { this.release(s, 'window expired'); throw s.fault!; }
  }
  private async guard<T>(s: Session, promise: Promise<T>): Promise<T> {
    const value = await Promise.race([promise, s.failure]); this.live(s); return value;
  }
  private async verify(s: Session) {
    try {
      const actual = await this.guard(s, this.io.inspect({ ...s.input, routingConfig: s.routingConfig! }));
      if (actual.proxyId !== s.identity?.proxyId || actual.sourceId !== s.identity?.sourceId) throw proxyTrafficUnavailable('proxy restarted or was replaced');
    } catch { this.release(s, 'routing or proxy source changed or unavailable'); throw s.fault!; }
  }
  private receipt(s: Session): ProxyTrafficSnapshot {
    this.live(s);
    if (s.result) return s.result;
    return proxyTrafficSnapshot.parse({ protocol: 1, basis: 'traefik-request-sequence', precisionMs: 1,
      windowId: s.id, requestId: s.input.requestId, epoch: this.epoch, targetHash: s.hash, routingGeneration: s.routingGeneration,
      sourceId: s.identity!.sourceId, proxyId: s.identity!.proxyId, nodeId: s.input.nodeId, serviceId: s.input.serviceId,
      deploymentId: s.input.deploymentId, step: s.input.step, elapsedMs: Math.max(0, Math.floor(this.now() - s.startedAt)), ...s.counter!.snapshot() });
  }
  private async until(s: Session, condition: () => boolean, milliseconds: number) {
    const end = this.now() + milliseconds;
    while (!condition()) {
      this.live(s);
      if (this.now() >= end) throw proxyTrafficUnavailable('marker or request records are missing or still pending');
      await this.guard(s, new Promise<void>(resolve => setTimeout(resolve, 10)));
    }
  }

  async open(params: unknown): Promise<ProxyTrafficSnapshot> {
    if (!this.enabled()) throw proxyTrafficUnavailable('node owner disabled observations');
    const input = proxyTrafficOpen.parse(params), routingGeneration = proxyTrafficRoutingGeneration(input), hash = proxyTrafficTargetHash(input);
    const previous = this.requests.get(input.requestId);
    if (previous) {
      if (previous.hash !== hash) throw proxyTrafficUnavailable('reservation identity changed');
      this.live(previous); return previous.result ?? previous.opening!;
    }
    if ([...this.sessions.values()].filter(s => !s.closed && !s.result).length >= PROXY_TRAFFIC_MAX_SESSIONS) throw proxyTrafficUnavailable('too many active windows');
    if (this.sessions.size >= 128) for (const s of this.sessions.values()) { if (s.closed || s.result) { this.forget(s); break; } }
    let reject!: (error: Error) => void;
    const failure = new Promise<never>((_yes, no) => { reject = no; }); void failure.catch(() => undefined);
    const { routingConfig, ...identityInput } = input;
    const s: Session = { id: opaque(), input: identityInput, routingConfig, routingGeneration, hash, startedAt: this.now(), deadline: this.now() + 10_000,
      busy: true, closed: false, counter: undefined, failure, reject };
    s.counter = new ProxyTrafficCounter(identityInput, s.id); this.sessions.set(s.id, s); this.requests.set(input.requestId, s); this.arm(s);
    s.opening = this.initialize(s); return s.opening;
  }
  private async initialize(s: Session): Promise<ProxyTrafficSnapshot> {
    try {
      s.identity = await this.guard(s, this.io.inspect({ ...s.input, routingConfig: s.routingConfig! }));
      s.connection = this.io.connect(s.identity.proxyId, line => {
        if (s.closed || s.result) return;
        try { this.live(s); s.counter!.ingest(line); } catch { this.release(s, 'log records are invalid or incomplete'); }
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
  async finish(params: unknown): Promise<ProxyTrafficSnapshot> {
    const { windowId } = proxyTrafficWindowId.parse(params), s = this.get(windowId);
    if (s.result) return s.result;
    if (s.busy) throw proxyTrafficUnavailable('window operation is pending');
    if (this.now() - s.startedAt < s.input.durationMs) throw proxyTrafficUnavailable('observation duration is not complete');
    s.busy = true;
    try {
      await this.verify(s); s.counter!.requestFinish();
      await this.guard(s, this.io.heartbeat(s.identity!.proxyId, s.counter!.endPath));
      await this.until(s, () => s.counter!.snapshot().complete, 5000); await this.verify(s);
      s.result = this.receipt(s); s.connection?.close(); s.connection = undefined; s.counter = undefined; s.routingConfig = undefined; s.busy = false;
      clearTimeout(s.timer); s.timer = setTimeout(() => this.forget(s), 60_000); s.timer.unref(); return s.result;
    } catch { this.release(s, 'final observation incomplete or source changed'); throw s.fault!; }
  }
  close(params: unknown) { const { windowId } = proxyTrafficWindowId.parse(params); const s = this.sessions.get(windowId); if (s) this.release(s); return { windowId, closed: true }; }
  closeAll() { for (const s of this.sessions.values()) { this.release(s); this.forget(s); } this.epoch = opaque(); }
  activeCount() { return [...this.sessions.values()].filter(s => !s.closed && !s.result).length; }
}

export const nodeProxyTraffic = new NodeProxyTraffic(nodeProxyTrafficDocker(), () => performance.now(), () => {
  const value = (process.env.NINEDEPLOY_AGENT_PROXY_TRAFFIC ?? '').trim();
  return value !== '' && !/^(off|false|0|no|disabled)$/i.test(value);
});
