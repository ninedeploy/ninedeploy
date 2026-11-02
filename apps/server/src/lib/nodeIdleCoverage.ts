import { idleWatchOpen, idleWatchSnapshot, type IdleWatchOpen, type IdleWatchSnapshot } from '@ninedeploy/schemas';
import { proxyTrafficRoutingGeneration, proxyTrafficTargetHash, proxyTrafficUnavailable } from './proxyTrafficCounter.js';

export type CompletedIdleWindow = {
  input: IdleWatchOpen; opened: IdleWatchSnapshot; finished: IdleWatchSnapshot;
  /** Monotonic panel timestamps bracketing the opening RPC, never wall time. */
  beforeOpen: number; afterOpen: number;
  context: string;
  /** Conservative panel wall time captured before sending the finishing RPC. */
  sampledAt?: number;
};
type Last = { receipt: IdleWatchSnapshot; beforeOpen: number; context: string; targets: string };
declare const evidenceBrand: unique symbol;
export type NodeIdleEvidence = { readonly [evidenceBrand]: true };
type Evidence = { window: CompletedIdleWindow; idleMs: number; sampledAt: number; current: () => boolean };
const issued = new WeakMap<NodeIdleEvidence, Evidence>();
/** Only locally issued observation evidence is accepted; callers cannot supply a numeric idle claim. */
export function spendNodeIdleEvidence(token: NodeIdleEvidence): Evidence | null {
  const evidence = issued.get(token); issued.delete(token);
  return evidence?.current() ? evidence : null;
}

/** One service's conservative idle proof; this class never mutates a runtime. */
export class NodeIdleCoverage {
  private anchor: number | null = null;
  private last: Last | null = null;
  private idleMs = 0;
  private version = 0;
  private evidence: { window: CompletedIdleWindow; sampledAt: number; verifiedAt: number } | null = null;
  constructor(private readonly now = () => performance.now(), private readonly wall = () => Date.now()) {}

  reset(): void { this.anchor = null; this.last = null; this.idleMs = 0; this.evidence = null; this.version++; }

  takeEvidence(): NodeIdleEvidence | null {
    const evidence = this.evidence; if (!evidence) return null;
    this.evidence = null;
    const version = this.version, fresh = () => this.version === version && this.now() >= evidence.verifiedAt && this.now() - evidence.verifiedAt < 30_000 &&
      this.wall() >= evidence.sampledAt && this.wall() - evidence.sampledAt < 30_000;
    if (!fresh()) return null;
    const token = Object.freeze({}) as NodeIdleEvidence;
    issued.set(token, { window: structuredClone(evidence.window), idleMs: this.idleMs, sampledAt: evidence.sampledAt, current: fresh });
    return token;
  }

  complete(window: CompletedIdleWindow): { idleMs: number; chained: boolean; reason: string | null } {
    try {
      const input = idleWatchOpen.parse(window.input), opened = idleWatchSnapshot.parse(window.opened), finished = idleWatchSnapshot.parse(window.finished);
      const hash = proxyTrafficTargetHash(input), route = proxyTrafficRoutingGeneration(input);
      if (![window.beforeOpen, window.afterOpen].every(value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) || window.afterOpen < window.beforeOpen ||
        typeof window.context !== 'string' || !window.context || opened.elapsedMs > window.afterOpen - window.beforeOpen || opened.complete || opened.endCounter !== null ||
        !finished.complete || finished.endCounter === null || finished.elapsedMs < input.durationMs) {
        throw proxyTrafficUnavailable('idle window timing or coverage is incomplete');
      }
      for (const receipt of [opened, finished]) {
        if (receipt.requestId !== input.requestId || receipt.targetHash !== hash || receipt.routingGeneration !== route ||
          receipt.nodeId !== input.nodeId || receipt.serviceId !== input.serviceId || receipt.deploymentId !== input.deploymentId) throw proxyTrafficUnavailable('idle receipt is unbound');
      }
      if (['windowId', 'sourceId', 'proxyId', 'epoch', 'startCounter'].some(key => opened[key as keyof IdleWatchSnapshot] !== finished[key as keyof IdleWatchSnapshot]) ||
        finished.elapsedMs < opened.elapsedMs || finished.observed < opened.observed || finished.serving.requests < opened.serving.requests || finished.serving.errors < opened.serving.errors) {
        throw proxyTrafficUnavailable('idle source continuity changed');
      }
      const prior = this.last;
      const targets = JSON.stringify(input.serving.map(target => ({ ...target })).sort((a, b) => a.name.localeCompare(b.name)));
      const sameSource = prior && prior.targets === targets && prior.context === window.context && prior.receipt.nodeId === finished.nodeId && prior.receipt.serviceId === finished.serviceId &&
        prior.receipt.deploymentId === finished.deploymentId && prior.receipt.sourceId === finished.sourceId && prior.receipt.proxyId === finished.proxyId &&
        prior.receipt.epoch === finished.epoch && prior.receipt.routingGeneration === finished.routingGeneration;
      if (prior && sameSource && (finished.windowId === prior.receipt.windowId || finished.requestId === prior.receipt.requestId ||
        BigInt(finished.endCounter) <= BigInt(prior.receipt.endCounter!))) throw proxyTrafficUnavailable('idle receipt was repeated or superseded');
      if (prior && window.beforeOpen < prior.beforeOpen) throw proxyTrafficUnavailable('panel monotonic clock regressed');
      if (finished.serving.requests !== 0) { this.reset(); return { idleMs: 0, chained: false, reason: 'serving traffic interrupted idle coverage' }; }
      const chained = !!(sameSource && BigInt(opened.startCounter) < BigInt(prior!.receipt.endCounter!));
      if (prior && !chained) { this.version++; this.evidence = null; }
      if (!chained) { this.anchor = window.afterOpen; this.idleMs = finished.elapsedMs; }
      else {
        // Next start >= its panel beforeOpen; first start <= the first afterOpen.
        // Counters prove overlap, and these bounds avoid adding overlapping durations twice.
        this.idleMs = Math.floor(Math.max(this.idleMs, finished.elapsedMs, window.beforeOpen + finished.elapsedMs - this.anchor!));
      }
      this.last = { receipt: structuredClone(finished), beforeOpen: window.beforeOpen, context: window.context, targets };
      const sampledAt = window.sampledAt ?? this.wall();
      if (!Number.isSafeInteger(sampledAt) || sampledAt < 0 || sampledAt > this.wall()) throw proxyTrafficUnavailable('idle observation wall time is invalid');
      this.evidence = { window: structuredClone(window), sampledAt, verifiedAt: this.now() };
      return { idleMs: this.idleMs, chained, reason: prior && !chained ? 'idle coverage restarted after a source, context or interval change' : null };
    } catch (error) { this.reset(); throw error; }
  }
}
