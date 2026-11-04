import { randomBytes } from 'node:crypto';
import type { PersistentPortHostContext } from './persistentPortHostAuthority.js';
import { withPersistentPortJournalStore } from './persistentPortJournalStore.js';
import { persistentPortFingerprint, persistentPortRules, type PersistentPortNftSpec } from './persistentPortNft.js';
import { PersistentPortPublisher, type PersistentPortJournal } from './persistentPortPublication.js';

type Target = PersistentPortNftSpec['target'];
export interface PersistentPortWebChallenge {
  readonly version: 1;
  readonly token: string;
  readonly serviceId: number;
  readonly owner: string;
  readonly revision: number;
  readonly targetId: string;
  readonly fingerprint: string;
}
export type PersistentPortWebConfirmer = (challenge: PersistentPortWebChallenge, signal: AbortSignal) => Promise<unknown>;
export type PersistentPortWorkerRequest = {
  version: 1;
  kind: 'promote' | 'recover' | 'rollback' | 'retire' | 'recover-retirement' | 'inspect';
  spec: PersistentPortNftSpec;
  targetId?: string;
};
export interface PersistentPortWorkerRuntime {
  installed(context: PersistentPortHostContext, table: string): Promise<unknown | null>;
  ready(context: PersistentPortHostContext, spec: PersistentPortNftSpec): Promise<void>;
  prepare(context: PersistentPortHostContext, spec: PersistentPortNftSpec, retained: readonly Target[]): Promise<void>;
  publish(context: PersistentPortHostContext, spec: PersistentPortNftSpec, replace: boolean): Promise<void>;
  drained(context: PersistentPortHostContext, target: Target): Promise<boolean>;
  retire(context: PersistentPortHostContext, target: Target): Promise<void>;
}

function control(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Persistent port worker control channel closed');
}
function deadline(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('Invalid persistent port web acknowledgement deadline');
}

/** The coordinator must call the existing routing transaction and acknowledge
 * this exact challenge only after the target actually loads. Merely writing
 * a file, a stale ACK, EOF or an unbounded callback is never confirmation. */
export async function confirmPersistentPortWebPublication(
  input: PersistentPortNftSpec,
  confirm: PersistentPortWebConfirmer,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const signal = options.signal;
  const spec = structuredClone(input), timeout = options.timeoutMs ?? 10_000;
  persistentPortRules(spec); deadline(timeout); control(signal);
  const challenge: PersistentPortWebChallenge = Object.freeze({ version: 1, token: randomBytes(16).toString('hex'),
    serviceId: spec.serviceId, owner: spec.owner, revision: spec.revision, targetId: spec.target.id, fingerprint: persistentPortFingerprint(spec) });
  await new Promise<void>((resolve, reject) => {
    const controller = new AbortController(); let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', canceled);
      if (error) { controller.abort(); reject(error); } else resolve();
    };
    const canceled = () => finish(new Error('Persistent port worker control channel closed'));
    signal?.addEventListener('abort', canceled, { once: true });
    timer = setTimeout(() => finish(new Error('Persistent port web acknowledgement timed out')), timeout);
    Promise.resolve().then(() => {
      if (settled) return undefined;
      return confirm(challenge, controller.signal);
    }).then(response => {
      if (settled) return;
      try {
        const ack = response as Record<string, unknown>;
        if (!ack || typeof ack !== 'object' || Array.isArray(ack) || Object.keys(ack).length !== 8 || Object.keys(ack).some(key => key !== 'loaded' && !Object.hasOwn(challenge, key)) || ack.loaded !== true ||
          Object.entries(challenge).some(([key, value]) => ack[key] !== value)) {
          throw new Error('Persistent port web acknowledgement does not match publication');
        }
        finish();
      } catch { finish(new Error('Persistent port web acknowledgement does not match publication')); }
    }, () => finish(new Error('Persistent port web acknowledgement was not confirmed')));
  });
}

/** Must execute inside the target host network namespace. Runtime kernel
 * mutators must use the supplied context.run locally, not Docker API exec.
 * This is the worker engine; production keeper/IPC/pipeline adoption is still
 * a separate gate and no deployment activation option is added here. */
export async function runPersistentPortHostWorker(options: {
  directory: string;
  request: PersistentPortWorkerRequest;
  runtime: PersistentPortWorkerRuntime;
  confirmWeb: PersistentPortWebConfirmer;
  acknowledgementTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ version: 1; kind: PersistentPortWorkerRequest['kind']; journal: PersistentPortJournal | null; retired?: boolean }> {
  const { directory, runtime, confirmWeb, signal } = options;
  const request = structuredClone(options.request), timeout = options.acknowledgementTimeoutMs ?? 10_000;
  if (!request || request.version !== 1 || !['promote', 'recover', 'rollback', 'retire', 'recover-retirement', 'inspect'].includes(request.kind) ||
    Object.keys(request).some(key => !['version', 'kind', 'spec', 'targetId'].includes(key)) ||
    (request.kind === 'retire' ? !/^[a-f0-9]{64}$/.test(request.targetId ?? '') : request.targetId !== undefined)) {
    throw new Error('Invalid persistent port worker request');
  }
  persistentPortRules(request.spec); deadline(timeout); control(signal);
  return withPersistentPortJournalStore(directory, request.spec, async store => {
    control(signal);
    const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
      control(signal); const result = await operation(); control(signal); return result;
    };
    const context = store.context;
    const publisher = new PersistentPortPublisher({
      // Host authority is already held by the outer journal scope. No second
      // process-local mutex substitutes for the target worker's OS lock.
      exclusive: async operation => operation(),
      readJournal: async () => { control(signal); return store.read(); },
      saveJournal: async state => { control(signal); store.save(state); },
      installed: table => invoke(() => runtime.installed(context, table)),
      ready: spec => invoke(() => runtime.ready(context, spec)),
      prepare: (spec, retained) => invoke(() => runtime.prepare(context, spec, retained)),
      publish: (spec, replace) => invoke(() => runtime.publish(context, spec, replace)),
      confirmWeb: spec => confirmPersistentPortWebPublication(spec, confirmWeb, { timeoutMs: timeout, signal: signal }),
      drained: target => invoke(() => runtime.drained(context, target)),
      retire: target => invoke(() => runtime.retire(context, target)),
    });
    let journal: PersistentPortJournal | null, retired: boolean | undefined;
    switch (request.kind) {
      case 'inspect': journal = store.read(); break;
      case 'promote': journal = await publisher.promote(request.spec); break;
      case 'recover': journal = await publisher.recover(request.spec); break;
      case 'rollback': journal = await publisher.rollbackPending(request.spec); break;
      case 'recover-retirement': journal = await publisher.recoverRetirement(request.spec); break;
      case 'retire': retired = await publisher.retireDrained(request.spec, request.targetId!); journal = store.read(); break;
    }
    return structuredClone({ version: 1 as const, kind: request.kind, journal, ...(retired === undefined ? {} : { retired }) });
  });
}
