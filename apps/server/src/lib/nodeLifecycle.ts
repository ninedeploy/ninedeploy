import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { containerLifecycleReply, containerLifecycleRequest, containerLifecycleRetireRequest, containerLifecycleRetireReply, type ContainerLifecycleReply, type ContainerLifecycleRequest } from '@ninedeploy/schemas';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';
import { spawnValidated } from './spawnValidated.js';
import { confirmsMissingContainer } from './dockerContainerAbsence.js';

const queue = createKeyedOperationGuard<string>();
let active = 0;
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"status":{{json .State.Status}},"running":{{json .State.Running}}}';
const JOURNAL_SCHEMA = 'PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS lifecycle_head (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, request_hash TEXT NOT NULL, intent TEXT NOT NULL, receipt TEXT)';
const CREATE_FENCE_SCHEMA = 'CREATE TABLE IF NOT EXISTS legacy_create_fence (id INTEGER PRIMARY KEY CHECK(id=1), deployment_id INTEGER NOT NULL)';

export function assertLegacyNodeMutationAllowed(database: DatabaseSync): void {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_protocol'").get();
  if (!table) return;
  const mode = database.prepare('SELECT version FROM runtime_protocol WHERE id=1').get();
  if (!mode) return;
  if (mode.version !== 1) throw new Error('Unsupported runtime journal protocol; retained for review');
  throw new Error('Unversioned container mutation is fenced by ordered runtime ownership; update the panel');
}

/** Compatibility entry point; ordered commands must also fence old agent callers. */
export async function runLegacyNodeLifecycle(root: string, action: 'start' | 'stop', name: string, graceSeconds: number,
  onLine: (line: string) => void): Promise<number> {
  if (!['start', 'stop'].includes(action) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) ||
    !Number.isInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 300) throw new Error('Invalid legacy lifecycle operands');
  if (active >= 16) throw new Error('Node lifecycle capacity is busy');
  active++;
  const deadline = performance.now() + (action === 'stop' ? Math.max(30_000, (graceSeconds + 10) * 1000) : 30_000);
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const current = () => { if (!remaining()) throw new Error('Node lifecycle deadline exceeded'); };
  const inspect = async (reference: string): Promise<Record<string, unknown> | null> => {
    current(); const lines: string[] = []; let bytes = 0;
    const code = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', INSPECT, reference], line => {
      bytes += Buffer.byteLength(line); if (bytes <= 64 * 1024) lines.push(line);
    }, { timeoutMs: remaining() });
    current();
    if (bytes > 64 * 1024) throw new Error('Legacy lifecycle identity unavailable');
    if (code !== 0) {
      if (confirmsMissingContainer(lines, reference)) return null;
      throw new Error('Legacy lifecycle identity unavailable');
    }
    if (lines.length !== 1) throw new Error('Legacy lifecycle identity unavailable');
    const value: unknown = JSON.parse(lines[0]!);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Legacy lifecycle identity unavailable');
    const row = value as Record<string, unknown>;
    const actualName = typeof row.name === 'string' ? row.name.replace(/^\//, '') : '';
    if (typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.id) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(actualName) ||
      (/^[a-f0-9]{64}$/.test(reference) ? row.id !== reference : actualName !== reference) ||
      typeof row.running !== 'boolean' || typeof row.status !== 'string') throw new Error('Legacy lifecycle identity changed');
    return { ...row, name: actualName };
  };
  const work = (async () => {
    const target = await inspect(name);
    if (!target) { onLine(`Error: No such container: ${name}`); return 1; }
    const effect = async () => {
      const before = await inspect(String(target.id));
      if (!before || before.id !== target.id || ['name', 'managed', 'serviceId', 'deploymentId'].some(key => before[key] !== target[key])) throw new Error('Legacy lifecycle identity changed');
      current();
      const result = await spawnValidated('docker', action === 'start' ? ['start', String(target.id)] : ['stop', '-t', String(graceSeconds), String(target.id)], onLine, { timeoutMs: remaining() });
      current(); if (result !== 0) return result;
      const after = await inspect(String(target.id));
      if (!after || after.id !== target.id || ['name', 'managed', 'serviceId', 'deploymentId'].some(key => after[key] !== target[key]) ||
        (action === 'start' ? after.status !== 'running' || !after.running : after.running || !['created', 'exited', 'dead'].includes(String(after.status)))) throw new Error('Legacy lifecycle Docker state is unconfirmed');
      return result;
    };
    // Compose and other non-service runtimes retain their compatibility path,
    // but their effects still use the inspected ID rather than a reusable name.
    if (target.serviceId == null && target.managed !== 'service' || typeof target.composeProject === 'string' && /^ndcmp-[A-Za-z0-9_.-]+$/.test(target.composeProject)) return effect();
    if (typeof target.serviceId !== 'string' || !/^[1-9]\d*$/.test(target.serviceId) || !Number.isSafeInteger(Number(target.serviceId))) throw new Error('Legacy lifecycle ownership is unconfirmed');
    const directory = resolve(root), file = join(directory, `service-${target.serviceId}.sqlite`);
    return queue(file, async () => {
      current(); mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink() || existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Invalid node lifecycle journal path');
      const database = new DatabaseSync(file);
      try {
        database.exec(JOURNAL_SCHEMA); current(); chmodSync(file, 0o600);
        for (;;) {
          current(); let begun = false;
          try {
            database.exec('BEGIN IMMEDIATE'); begun = true; current();
            assertLegacyNodeMutationAllowed(database);
            const head = database.prepare('SELECT intent FROM lifecycle_head WHERE id=1').get();
            if (head) {
              const intent: unknown = JSON.parse(String(head.intent));
              const recorded = intent && typeof intent === 'object' ? containerLifecycleRequest.safeParse({ ...intent, timeoutMs: 1 }) : null;
              if (!recorded?.success || action === 'start' || String(recorded.data.deploymentId) === target.deploymentId ||
                recorded.data.targets.some(item => String(item.deploymentId) === target.deploymentId) ||
                typeof target.deploymentId !== 'string' || !/^[1-9]\d*$/.test(target.deploymentId)) {
                throw new Error('Legacy Docker lifecycle is fenced by ordered lifecycle; update the panel to use docker.lifecycle');
              }
            }
            const result = await effect(); current();
            database.exec('COMMIT'); begun = false; current(); return result;
          } catch (error) {
            if (begun) database.exec('ROLLBACK');
            if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5) throw error;
            current(); await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining())));
          }
        }
      } finally { database.close(); }
    });
  })().finally(() => { active--; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Node lifecycle deadline exceeded')), Math.max(1, remaining()));
    })]);
  } finally { clearTimeout(timer); }
}

export interface NodeServiceJournal {
  database: DatabaseSync;
  remaining(): number;
  current(): void;
  write<T>(operation: () => Promise<T>): Promise<T>;
}

/** One native SQLite lock drains managed creation and lifecycle effects across processes. */
export async function withNodeServiceJournal<T>(root: string, serviceId: number, timeoutMs: number,
  operation: (journal: NodeServiceJournal) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(serviceId) || serviceId < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 595_000) throw new Error('Invalid node lifecycle journal request');
  if (active >= 16) throw new Error('Node lifecycle capacity is busy');
  active++;
  const deadline = performance.now() + timeoutMs;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const current = () => { if (!remaining()) throw new Error('Node lifecycle deadline exceeded'); };
  const directory = resolve(root), file = join(directory, 'service-' + serviceId + '.sqlite');
  // A timed-out caller cannot let the next command overtake an undrained child.
  const work = queue(file, async () => {
    current(); mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Invalid node lifecycle journal path');
    const database = new DatabaseSync(file);
    const write = async <Result>(effect: () => Promise<Result>): Promise<Result> => {
      for (;;) {
        current(); let begun = false;
        try {
          database.exec('BEGIN IMMEDIATE'); begun = true; current();
          const result = await effect(); current();
          database.exec('COMMIT'); begun = false; current(); return result;
        } catch (error) {
          if (begun) database.exec('ROLLBACK');
          if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5) throw error;
          current(); await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining())));
        }
      }
    };
    try {
      database.exec(JOURNAL_SCHEMA); current(); chmodSync(file, 0o600);
      return await operation({ database, remaining, current, write });
    } finally { database.close(); }
  }).finally(() => { active--; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Node lifecycle deadline exceeded')), Math.max(1, remaining()));
    })]);
  } finally { clearTimeout(timer); }
}

/** Drain the complete admitted create/network/Start sequence before acknowledging a lifecycle effect. */
export function runNodeCreation<T>(root: string, serviceId: number,
  operation: (remaining: () => number, current: () => void) => Promise<T>, deploymentId?: number): Promise<T> {
  return withNodeServiceJournal(root, serviceId, 595_000, ({ database, write, remaining, current }) => write(async () => {
    assertLegacyNodeMutationAllowed(database);
    database.exec(CREATE_FENCE_SCHEMA);
    const fence = database.prepare('SELECT deployment_id FROM legacy_create_fence WHERE id=1').get();
    if (fence) {
      const high = Number(fence.deployment_id);
      if (!Number.isSafeInteger(high) || high < 1 || !Number.isSafeInteger(deploymentId) || deploymentId! <= high) {
        throw new Error('Node creation is stale or its deployment identity is fenced by Stop');
      }
    }
    return operation(remaining, current);
  }));
}

/** The committed head is never rolled back with a failed or interrupted Docker effect. */
export function createNodeLifecycle(root: string) {
  const directory = resolve(root);
  return {
    async apply(params: unknown): Promise<ContainerLifecycleReply> {
      const input = containerLifecycleRequest.parse(params);
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, async ({ database, write, remaining, current }) => {
        const { timeoutMs: _timeout, ...intent } = input;
        const payload = JSON.stringify(intent), hash = createHash('sha256').update(payload).digest('hex');
        const head = () => database.prepare('SELECT revision, request_hash, receipt FROM lifecycle_head WHERE id=1').get();
        await write(async () => {
          const existing = head(); current();
          if (existing && Number(existing.revision) > input.revision) throw new Error('Node lifecycle request is stale; superseded by a newer command');
          if (existing && Number(existing.revision) === input.revision && existing.request_hash !== hash) throw new Error('Node lifecycle revision conflicts with a different intent');
          if (!existing || Number(existing.revision) < input.revision) database.prepare(
            'INSERT INTO lifecycle_head (id, revision, request_hash, intent, receipt) VALUES (1, ?, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, request_hash=excluded.request_hash, intent=excluded.intent, receipt=NULL',
          ).run(input.revision, hash, payload);
          if (input.action === 'stop') {
            database.exec(CREATE_FENCE_SCHEMA);
            const high = Math.max(input.deploymentId, ...input.targets.map(target => target.deploymentId ?? input.deploymentId));
            database.prepare('INSERT INTO legacy_create_fence(id,deployment_id) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET deployment_id=MAX(deployment_id,excluded.deployment_id)').run(high);
          }
        });
        return write(async () => {
          const latest = head(); current();
          if (!latest || Number(latest.revision) !== input.revision || latest.request_hash !== hash) throw new Error('Node lifecycle request is stale; superseded by a newer command');
          if (latest.receipt !== null) return containerLifecycleReply.parse(JSON.parse(String(latest.receipt)));
          const receipt = await applyDocker(input, remaining, current); current();
          database.prepare('UPDATE lifecycle_head SET receipt=? WHERE id=1 AND revision=? AND request_hash=?').run(JSON.stringify(receipt), input.revision, hash);
          return receipt;
        });
      });
    },
    async retire(params: unknown) {
      const input = containerLifecycleRetireRequest.parse(params);
      return withNodeServiceJournal(directory, input.serviceId, input.timeoutMs, async journal => {
        const { timeoutMs: _timeout, ...intent } = input;
        const hash = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
        const verify = () => {
          const head = journal.database.prepare('SELECT revision,request_hash,intent,receipt FROM lifecycle_head WHERE id=1').get();
          if (!head || Number(head.revision) !== input.revision || typeof head.intent !== 'string' ||
            createHash('sha256').update(head.intent).digest('hex') !== head.request_hash || head.receipt === null) throw new Error('Stop retirement ownership is stale or unconfirmed');
          const recorded = containerLifecycleRequest.parse({ ...JSON.parse(head.intent), timeoutMs: 1 });
          const receipt = containerLifecycleReply.parse(JSON.parse(String(head.receipt)));
          if (recorded.action !== 'stop' || recorded.requestId !== input.requestId || recorded.serviceId !== input.serviceId || recorded.revision !== input.revision ||
            receipt.requestId !== recorded.requestId || receipt.serviceId !== recorded.serviceId || receipt.deploymentId !== recorded.deploymentId ||
            receipt.revision !== recorded.revision || receipt.action !== 'stop' || receipt.items.length !== recorded.targets.length ||
            recorded.targets.some(target => !receipt.items.some(item => item.id === target.id && item.name === target.name && item.deploymentId === target.deploymentId && !item.running)) ||
            input.targets.some(target => !recorded.targets.some(item => item.id === target.id && item.name === target.name && (item.deploymentId ?? recorded.deploymentId) === target.deploymentId) ||
              !receipt.items.some(item => item.id === target.id && item.name === target.name && (item.deploymentId ?? recorded.deploymentId) === target.deploymentId && !item.running))) {
            throw new Error('Stop retirement ownership or target coverage changed');
          }
        };
        const table = 'CREATE TABLE IF NOT EXISTS lifecycle_retirement (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, request_hash TEXT NOT NULL)';
        await journal.write(async () => {
          verify(); journal.database.exec(table);
          const old = journal.database.prepare('SELECT revision,request_hash FROM lifecycle_retirement WHERE id=1').get();
          if (old && Number(old.revision) > input.revision) throw new Error('Stop retirement request is stale');
          if (old && Number(old.revision) === input.revision && old.request_hash !== hash) throw new Error('Stop retirement request conflicts with the recorded intent');
          journal.database.prepare('INSERT INTO lifecycle_retirement(id,revision,request_hash) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,request_hash=excluded.request_hash').run(input.revision, hash);
        });
        return journal.write(async () => {
          verify();
          const saved = journal.database.prepare('SELECT revision,request_hash FROM lifecycle_retirement WHERE id=1').get();
          if (!saved || Number(saved.revision) !== input.revision || saved.request_hash !== hash) throw new Error('Stop retirement request is stale');
          const inspect = async (target: typeof input.targets[number]) => {
            const lines: string[] = []; let bytes = 0;
            const code = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', INSPECT, target.id], line => {
              bytes += Buffer.byteLength(line); if (bytes <= 16_384) lines.push(line);
            }, { timeoutMs: journal.remaining() });
            journal.current();
            if (bytes > 16_384) throw new Error('Stop retirement identity unavailable');
            if (code !== 0) {
              if (confirmsMissingContainer(lines, target.id)) return false;
              throw new Error('Stop retirement identity unavailable');
            }
            if (lines.length !== 1) throw new Error('Stop retirement identity unavailable');
            const row = JSON.parse(lines[0]!) as Record<string, unknown>;
            if (row.id !== target.id || row.name !== target.name && row.name !== `/${target.name}` || row.managed !== 'service' ||
              row.serviceId !== String(input.serviceId) || row.deploymentId !== String(target.deploymentId) || row.running !== false ||
              !['created', 'exited', 'dead'].includes(String(row.status))) throw new Error('Stop retirement identity or state changed');
            return true;
          };
          const present: boolean[] = [];
          for (const target of input.targets) present.push(await inspect(target));
          for (const [index, target] of input.targets.entries()) {
            if (!present[index]) continue;
            journal.current();
            if (await spawnValidated('docker', ['rm', target.id], () => {}, { timeoutMs: journal.remaining() }) !== 0) throw new Error('Stop retirement removal unconfirmed');
            journal.current();
            if (await inspect(target)) throw new Error('Stop retirement removal unconfirmed');
          }
          return containerLifecycleRetireReply.parse({ requestId: input.requestId, serviceId: input.serviceId, revision: input.revision,
            complete: true, items: input.targets.map(target => ({ ...target, removed: true })) });
        });
      });
    },
  };
}

async function applyDocker(input: ContainerLifecycleRequest, remaining: () => number, current: () => void): Promise<ContainerLifecycleReply> {
  if (input.targets.length === 0) return containerLifecycleReply.parse({ requestId: input.requestId, serviceId: input.serviceId, deploymentId: input.deploymentId,
    revision: input.revision, action: input.action, complete: true, items: [] });
  const inspect = async () => {
    current();
    let bytes = 0, invalid = false;
    const rows: Record<string, unknown>[] = [];
    const code = await spawnValidated('docker', ['inspect', '--type', 'container', '--format', INSPECT, ...input.targets.map(t => t.id)], line => {
      bytes += Buffer.byteLength(line);
      if (bytes > 64 * 1024 || rows.length >= input.targets.length) { invalid = true; return; }
      try {
        const row = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) invalid = true;
        else rows.push(row);
      } catch { invalid = true; }
    }, { timeoutMs: remaining() });
    current();
    if (invalid || code !== 0 || rows.length !== input.targets.length || new Set(rows.map(row => row.id)).size !== input.targets.length) throw new Error('Node lifecycle identity inspection unavailable');
    for (const target of input.targets) {
      const row = rows.find(row => row.id === target.id);
      if (!row || row.name !== target.name && row.name !== `/${target.name}` || row.managed !== 'service' || row.serviceId !== String(input.serviceId) || row.deploymentId !== String(target.deploymentId ?? input.deploymentId)) throw new Error('Node lifecycle identity or generation changed');
      if (typeof row.running !== 'boolean' || !['running', 'created', 'exited', 'dead', 'paused', 'restarting'].includes(String(row.status))) throw new Error('Node lifecycle state unavailable');
    }
    return rows;
  };
  const before = await inspect();
  if (input.action === 'start' && before.some(row => !['running', 'created', 'exited'].includes(String(row.status)))) throw new Error('Node lifecycle state cannot be started');
  const ids = before.filter(row => input.action === 'start' ? row.status !== 'running' || !row.running : row.running || row.status === 'restarting').map(row => String(row.id));
  if (ids.length > 0) {
    current();
    const code = await spawnValidated('docker', input.action === 'start' ? ['start', ...ids] : ['stop', '-t', '5', ...ids], () => undefined, { timeoutMs: remaining() });
    current(); if (code !== 0) throw new Error('Node lifecycle Docker effect is unconfirmed');
  }
  const after = await inspect();
  if (after.some(row => input.action === 'start' ? row.status !== 'running' || !row.running : row.running || !['created', 'exited', 'dead'].includes(String(row.status)))) throw new Error('Node lifecycle Docker state is unconfirmed');
  return containerLifecycleReply.parse({ requestId: input.requestId, serviceId: input.serviceId, deploymentId: input.deploymentId,
    revision: input.revision, action: input.action, complete: true,
    items: input.targets.map(target => ({ ...target, running: after.find(row => row.id === target.id)!.running })) });
}
