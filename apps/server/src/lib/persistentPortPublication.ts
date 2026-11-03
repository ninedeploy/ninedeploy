import { assertPersistentPortNftState, persistentPortFingerprint, persistentPortRules, persistentPortTable, type PersistentPortNftSpec } from './persistentPortNft.js';

type Target = PersistentPortNftSpec['target'];
export interface PersistentPortJournal {
  version: 3;
  committed: PersistentPortNftSpec | null;
  pending: PersistentPortNftSpec | null;
  source: PersistentPortNftSpec | null;
  retiring: Target | null;
  retained: Target[];
}

/** Every callback executes under exclusive, non-stealable host authority.
 * The journal writer must durably commit before resolving. A process-local
 * mutex or an expiring heartbeat alone does not fence kernel mutations. */
export interface PersistentPortAuthority {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  readJournal(): Promise<PersistentPortJournal | null>;
  saveJournal(journal: PersistentPortJournal): Promise<void>;
  /** Null only when this exact table is absent; probe/parse errors must throw. */
  installed(table: string): Promise<unknown | null>;
  /** Checks immutable container identity, address, generation and actual readiness. */
  ready(spec: PersistentPortNftSpec): Promise<void>;
  /** Add/retain grants; never remove old targets while preparing a handoff. */
  prepare(spec: PersistentPortNftSpec, retained: readonly Target[]): Promise<void>;
  publish(spec: PersistentPortNftSpec, replace: boolean): Promise<void>;
  /** Must acknowledge the exact candidate, not just a successful config write. */
  confirmWeb(spec: PersistentPortNftSpec): Promise<void>;
  drained(target: Target): Promise<boolean>;
  /** Idempotent immutable-ID retirement, including its forwarding grants. */
  retire(target: Target): Promise<void>;
}

export class PersistentPortPublicationPending extends Error {
  constructor(cause: unknown) {
    super('Persistent port publication is unresolved; retain all runtime generations', { cause });
    this.name = 'PersistentPortPublicationPending';
  }
}

const identity = (spec: PersistentPortNftSpec | null) => spec ? persistentPortFingerprint(spec) : null;
function matches(snapshot: unknown | null, spec: PersistentPortNftSpec | null): boolean {
  if (!spec) return snapshot === null;
  try { assertPersistentPortNftState(spec, snapshot); return true; } catch { return false; }
}

function sameClaim(a: PersistentPortNftSpec, b: PersistentPortNftSpec): boolean {
  return a.serviceId === b.serviceId && a.owner === b.owner && a.mark === b.mark &&
    JSON.stringify(persistentPortRules(a)) === JSON.stringify(persistentPortRules(b));
}

function journalCheck(journal: PersistentPortJournal, desired: PersistentPortNftSpec): void {
  persistentPortRules(desired);
  if (journal.version !== 3 || journal.source === undefined || journal.retiring === undefined || !Array.isArray(journal.retained) || journal.retained.length > 3) throw new Error('Invalid persistent port journal');
  if (!journal.committed && !journal.pending && journal.retained.length) throw new Error('Unowned retained runtimes in journal');
  for (const spec of [journal.committed, journal.pending, journal.source]) {
    if (spec && !sameClaim(spec, desired)) throw new Error('Persistent port ownership or binding claim changed');
    if (spec && !journal.retained.some(target => target.id === spec.target.id && target.ipv4 === spec.target.ipv4)) throw new Error('Journal lost a referenced runtime');
  }
  const ids = new Set<string>(), ips = new Set<string>();
  for (const target of journal.retained) {
    persistentPortRules({ ...desired, target });
    if (ids.has(target.id) || ips.has(target.ipv4)) throw new Error('Ambiguous retained runtime identity');
    ids.add(target.id); ips.add(target.ipv4);
  }
  if ((!journal.pending && journal.source) || (journal.source && (!journal.committed || journal.source.revision < journal.committed.revision))) throw new Error('Invalid publication source');
  if (journal.pending && (journal.pending.revision <= (journal.committed?.revision ?? 0) ||
    (journal.source && journal.source.revision >= journal.pending.revision))) throw new Error('Invalid pending publication revision');
  if (journal.retiring && (journal.pending || !journal.committed || journal.retiring.id === journal.committed.target.id ||
    !journal.retained.some(target => target.id === journal.retiring?.id && target.ipv4 === journal.retiring.ipv4))) {
    throw new Error('Invalid pending retirement');
  }
}

/** No activation switch: pipeline callers must also guard every failure/cleanup
 * path with this durable authority before this mode can be enabled. */
export class PersistentPortPublisher {
  constructor(private readonly authority: PersistentPortAuthority) {}

  async promote(input: PersistentPortNftSpec): Promise<PersistentPortJournal> {
    const desired = structuredClone(input);
    return this.authority.exclusive(async () => {
      const state = await this.authority.readJournal() ?? { version: 3 as const, committed: null, pending: null, source: null, retiring: null, retained: [] };
      journalCheck(state, desired);
      if (state.pending || state.retiring) throw new PersistentPortPublicationPending('Recover the existing intent before another deploy');
      if (desired.revision !== (state.committed?.revision ?? 0) + 1) throw new Error('Stale persistent port publication revision');
      await this.assertInstalled(state.committed, desired);
      await this.authority.ready(desired);
      const retained = state.retained.map(target => ({ ...target }));
      if (!retained.some(target => target.id === desired.target.id && target.ipv4 === desired.target.ipv4)) retained.push({ ...desired.target });
      if (retained.length > 3) throw new Error('Retained runtimes must drain before another publication');
      const pending: PersistentPortJournal = { ...state, pending: desired, source: state.committed, retained };
      journalCheck(pending, desired);
      try {
        // Even an ambiguous journal-write acknowledgement requires retention.
        await this.authority.saveJournal(pending);
        return await this.complete(pending, desired);
      } catch (error) { throw new PersistentPortPublicationPending(error); }
    });
  }

  /** Abandon an unresolved handoff only toward the last confirmed runtime.
   * The rollback is a new monotonic publication, not a replay of an old
   * revision. Both old and candidate flow owners remain retained. */
  async rollbackPending(input: PersistentPortNftSpec): Promise<PersistentPortJournal> {
    const desired = structuredClone(input);
    return this.authority.exclusive(async () => {
      const state = await this.authority.readJournal();
      if (!state) throw new Error('Persistent port journal is missing');
      journalCheck(state, desired);
      if (!state.pending || !state.committed || state.retiring) throw new Error('Rollback requires an unresolved publication and a committed target');
      if (desired.target.id !== state.committed.target.id || desired.target.ipv4 !== state.committed.target.ipv4) throw new Error('Rollback must select the committed target');
      if (desired.revision !== state.pending.revision + 1) throw new Error('Stale rollback publication revision');
      try {
        const installed = await this.authority.installed(persistentPortTable(desired));
        let source: PersistentPortNftSpec | null;
        if (matches(installed, state.pending)) source = state.pending;
        else if (matches(installed, state.source)) source = state.source;
        else throw new Error('Unknown persistent port kernel state; rollback cannot mutate it');
        await this.authority.ready(desired);
        const rollback = { ...state, pending: desired, source };
        journalCheck(rollback, desired);
        await this.authority.saveJournal(rollback);
        return await this.complete(rollback, desired);
      } catch (error) { throw new PersistentPortPublicationPending(error); }
    });
  }

  async recover(input: PersistentPortNftSpec): Promise<PersistentPortJournal> {
    const desired = structuredClone(input);
    return this.authority.exclusive(async () => {
      const state = await this.authority.readJournal();
      if (!state) throw new Error('Persistent port journal is missing');
      journalCheck(state, desired);
      if (state.retiring) throw new PersistentPortPublicationPending('Recover the pending retirement first');
      if (!state.pending && identity(state.committed) === identity(desired)) {
        try {
          await this.assertInstalled(desired, desired);
          await this.authority.ready(desired);
          await this.authority.confirmWeb(desired);
          await this.assertInstalled(desired, desired);
          return state;
        } catch (error) { throw new PersistentPortPublicationPending(error); }
      }
      if (!state.pending || identity(state.pending) !== identity(desired)) throw new Error('Recovery does not own the pending publication');
      try { return await this.complete(state, desired); }
      catch (error) { throw new PersistentPortPublicationPending(error); }
    });
  }

  private async assertInstalled(expected: PersistentPortNftSpec | null, desired: PersistentPortNftSpec): Promise<void> {
    const observed = await this.authority.installed(persistentPortTable(desired));
    if (!matches(observed, expected)) throw new Error('Persistent port kernel ownership or revision differs');
  }

  private async complete(state: PersistentPortJournal, desired: PersistentPortNftSpec): Promise<PersistentPortJournal> {
    const installed = await this.authority.installed(persistentPortTable(desired));
    if (!matches(installed, desired) && !matches(installed, state.source)) throw new Error('Unknown persistent port kernel state; no mutation permitted');
    await this.authority.ready(desired);
    await this.authority.prepare(desired, state.retained);
    if (!matches(installed, desired)) await this.authority.publish(desired, state.source !== null);
    await this.assertInstalled(desired, desired);
    await this.authority.confirmWeb(desired);
    // Recheck after asynchronous route acknowledgement before committing.
    await this.assertInstalled(desired, desired);
    const committed: PersistentPortJournal = { ...state, committed: desired, pending: null, source: null };
    await this.authority.saveJournal(committed);
    return committed;
  }

  async retireDrained(input: PersistentPortNftSpec, targetId: string): Promise<boolean> {
    const desired = structuredClone(input);
    return this.authority.exclusive(async () => {
      const state = await this.authority.readJournal();
      if (!state) throw new Error('Persistent port journal is missing');
      journalCheck(state, desired);
      if (state.pending || state.retiring) throw new PersistentPortPublicationPending('Retirement is blocked by an unresolved operation');
      if (identity(state.committed) !== identity(desired)) throw new Error('Retirement publication revision changed');
      if (targetId === desired.target.id) throw new Error('Cannot retire the serving runtime');
      await this.assertInstalled(desired, desired);
      const target = state.retained.find(target => target.id === targetId);
      if (!target) return false;
      if (!await this.authority.drained(target)) return false;
      await this.assertInstalled(desired, desired);
      const retiring = { ...state, retiring: target };
      try {
        await this.authority.saveJournal(retiring);
        await this.finishRetirement(retiring, desired);
      } catch (error) { throw new PersistentPortPublicationPending(error); }
      return true;
    });
  }

  async recoverRetirement(input: PersistentPortNftSpec): Promise<PersistentPortJournal> {
    const desired = structuredClone(input);
    return this.authority.exclusive(async () => {
      const state = await this.authority.readJournal();
      if (!state) throw new Error('Persistent port journal is missing');
      journalCheck(state, desired);
      if (state.pending || identity(state.committed) !== identity(desired)) throw new Error('Recovery does not own the retirement generation');
      try {
        await this.assertInstalled(desired, desired);
        return state.retiring ? await this.finishRetirement(state, desired) : state;
      } catch (error) { throw new PersistentPortPublicationPending(error); }
    });
  }

  private async finishRetirement(state: PersistentPortJournal, desired: PersistentPortNftSpec): Promise<PersistentPortJournal> {
    if (!state.retiring) throw new Error('Retirement intent is missing');
    await this.assertInstalled(desired, desired);
    await this.authority.retire(state.retiring);
    await this.assertInstalled(desired, desired);
    const committed = { ...state, retiring: null, retained: state.retained.filter(target => target.id !== state.retiring?.id) };
    await this.authority.saveJournal(committed);
    return committed;
  }
}
