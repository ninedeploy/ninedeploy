import type { Service } from '@ninedeploy/db';
import { SLEEP_AFTER_MIN, SLEEP_AFTER_MAX } from '@ninedeploy/schemas';
import { NodeIdleCoverage } from './nodeIdleCoverage.js';
import type { openServiceNodeIdleWatch } from './nodeIdleWatchService.js';

export const NODE_IDLE_SAMPLE_MS = 15_000;
/** Reserve two windows per service within the agent's 16-window idle-watch limit. */
export const NODE_IDLE_SERVICES_PER_NODE = 8;
const LEASE_MS = 30_000;
const REFUSAL_RETRY_MS = 60_000;
type Watch = Awaited<ReturnType<typeof openServiceNodeIdleWatch>>;
export type NodeIdleStatus = { idleMs: number | null; requiredMs: number; idleSatisfied: boolean; holding: string | null };
type Entry = { service: Service; generation: string; clock: NodeIdleCoverage; abort: AbortController; active?: Watch; next?: Watch;
  status: NodeIdleStatus; sampledAt: number; retryAt: number; running?: Promise<void> };
const generation = (service: Service) => JSON.stringify(service);
const eligible = (s: Service) => s.type === 'docker' && s.orchestrator !== 'swarm' && s.serverId != null && s.status === 'running' &&
  s.asleepAt == null && !!s.runtimeId && !!s.port && Number.isInteger(s.sleepAfterMinutes) && s.sleepAfterMinutes! >= SLEEP_AFTER_MIN && s.sleepAfterMinutes! <= SLEEP_AFTER_MAX;

/** Read-only scheduler. Idle satisfaction is evidence, never runtime mutation authority. */
export function createNodeIdleScheduler(deps: {
  load: () => Promise<Service[]>; open: (service: Service, signal: AbortSignal) => Promise<Watch>;
  now?: () => number; onError?: (error: unknown) => void;
}) {
  const entries = new Map<number, Entry>();
  const now = deps.now ?? (() => performance.now());
  let closed = false;
  const clearWindows = async (entry: Entry) => {
    const windows = [entry.active, entry.next]; entry.active = entry.next = undefined;
    await Promise.allSettled(windows.filter((value): value is Watch => !!value).map(window => window.close()));
  };
  const discard = async (entry: Entry) => {
    entry.abort.abort(); entry.clock.reset(); await clearWindows(entry);
  };
  const live = (entry: Entry) => {
    entry.abort.signal.throwIfAborted();
    if (closed || entries.get(entry.service.id) !== entry) throw new Error('node idle observation superseded');
  };
  const open = async (entry: Entry) => {
    live(entry); const window = await deps.open(entry.service, entry.abort.signal);
    try { live(entry); return window; } catch (error) { await window.close(); throw error; }
  };
  const reset = async (entry: Entry, holding: string, idleMs: number | null = null) => {
    entry.clock.reset(); entry.status = { ...entry.status, idleMs, idleSatisfied: false, holding };
    await clearWindows(entry);
  };
  const step = async (entry: Entry) => {
    try {
      live(entry);
      if (entry.active && (now() < entry.sampledAt || now() - entry.sampledAt >= LEASE_MS)) {
        await reset(entry, 'node idle lease lapsed; coverage restarted');
      }
      if (!entry.active) {
        entry.active = await open(entry); entry.sampledAt = now();
        entry.status = { ...entry.status, idleMs: null, idleSatisfied: false, holding: 'waiting for a complete node idle window' };
        return;
      }
      const [sample, following] = await Promise.all([entry.active.sample(), entry.next?.sample()]);
      live(entry); entry.sampledAt = now();
      if (sample.serving.requests > 0 || following && following.serving.requests > 0) {
        await reset(entry, 'serving traffic interrupted node idle coverage', 0); return;
      }
      // Open with two sample intervals left, before finishing the current window.
      if (!entry.next && sample.elapsedMs >= entry.active.input.durationMs - 2 * NODE_IDLE_SAMPLE_MS) entry.next = await open(entry);
      if (sample.elapsedMs < entry.active.input.durationMs) return;
      const active = entry.active, next = entry.next;
      if (!next) throw new Error('node idle successor is missing');
      const sampledAt = Date.now(), finished = await active.finish(); live(entry);
      const nextSample = await next.sample(); live(entry); entry.sampledAt = now();
      if (nextSample.serving.requests > 0) { await reset(entry, 'serving traffic interrupted node idle coverage', 0); return; }
      const proof = entry.clock.complete({ input: active.input, opened: active.receipt, finished,
        beforeOpen: active.beforeOpen, afterOpen: active.afterOpen, context: active.context, sampledAt });
      await active.close(); live(entry);
      entry.active = next; entry.next = undefined;
      entry.status = { ...entry.status, idleMs: proof.idleMs, idleSatisfied: proof.idleMs >= entry.status.requiredMs, holding: proof.reason };
    } catch (error) {
      if (entries.get(entry.service.id) === entry && !closed && !entry.abort.signal.aborted) {
        const reason = error instanceof Error && error.message.startsWith('Node proxy traffic unavailable:')
          ? error.message.slice(0, 512) : 'node idle coverage unavailable';
        entry.retryAt = now() + REFUSAL_RETRY_MS;
        await reset(entry, reason); deps.onError?.(error);
      } else await clearWindows(entry);
    }
  };
  return {
    async tick(): Promise<void> {
      if (closed) return;
      let list: Service[];
      try { list = await deps.load(); } catch (error) {
        const previous = [...entries.values()]; entries.clear();
        await Promise.allSettled(previous.map(discard)); if (!closed) deps.onError?.(error); return;
      }
      if (closed) return;
      const selected = list.filter(eligible), byId = new Map(selected.map(service => [service.id, service]));
      const priority = (service: Service) => entries.get(service.id)?.active || entries.get(service.id)?.running ? 1 : 0;
      const allowed = new Set<number>(), counts = new Map<number, number>();
      for (const service of [...selected].sort((a, b) => priority(b) - priority(a) || a.id - b.id)) {
        const previous = entries.get(service.id);
        if (previous && !previous.active && !previous.running && now() < previous.retryAt) continue;
        const count = counts.get(service.serverId!) ?? 0;
        if (count < NODE_IDLE_SERVICES_PER_NODE) { allowed.add(service.id); counts.set(service.serverId!, count + 1); }
      }
      const removed = [...entries].filter(([id, entry]) => { const service = byId.get(id); return !service || generation(service) !== entry.generation ||
        !allowed.has(id) && !!(entry.active || entry.running); });
      for (const [id] of removed) entries.delete(id);
      await Promise.allSettled(removed.map(([, entry]) => discard(entry)));
      if (closed) return;
      const tasks: Promise<void>[] = [];
      for (const service of selected) {
        let entry = entries.get(service.id);
        if (!entry) {
          entry = { service, generation: generation(service), clock: new NodeIdleCoverage(now), abort: new AbortController(), sampledAt: now(), retryAt: 0,
            status: { idleMs: null, requiredMs: service.sleepAfterMinutes! * 60_000, idleSatisfied: false, holding: 'waiting for node idle coverage' } };
          entries.set(service.id, entry);
        }
        if (!entry.active && !entry.running && now() < entry.retryAt) continue;
        if (!allowed.has(service.id)) {
          entry.sampledAt = now();
          entry.status = { ...entry.status, idleMs: null, idleSatisfied: false, holding: 'node idle watch capacity is busy; waiting for a paired-window slot' };
          continue;
        }
        if (entry.running) continue; // A slow node must not block another service's next lease tick.
        const current = entry;
        current.running = step(current).finally(() => { current.running = undefined; }); tasks.push(current.running);
      }
      await Promise.allSettled(tasks);
    },
    status(service: Service): NodeIdleStatus | null {
      const entry = entries.get(service.id);
      if (!entry || entry.generation !== generation(service)) return null;
      if (entry.active && (now() < entry.sampledAt || now() - entry.sampledAt >= LEASE_MS)) return { ...entry.status, idleMs: null, idleSatisfied: false, holding: 'node idle lease is not current' };
      return { ...entry.status };
    },
    takeEvidence(service: Service) {
      const entry = entries.get(service.id);
      if (!entry || entry.running || entry.generation !== generation(service) || !entry.status.idleSatisfied ||
        now() < entry.sampledAt || now() - entry.sampledAt >= LEASE_MS) return null;
      return entry.clock.takeEvidence();
    },
    async close(): Promise<void> {
      closed = true; const previous = [...entries.values()]; entries.clear();
      await Promise.allSettled(previous.map(discard)); await Promise.allSettled(previous.map(entry => entry.running));
    },
  };
}
