import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { containerLifecycleReply, containerLifecycleRequest, type ContainerLifecycleReply, type ContainerLifecycleRequest } from '@ninedeploy/schemas';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';
import { spawnValidated } from './spawnValidated.js';

const queue = createKeyedOperationGuard<string>();
let active = 0;
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"status":{{json .State.Status}},"running":{{json .State.Running}}}';
const JOURNAL_SCHEMA = 'PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS lifecycle_head (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, request_hash TEXT NOT NULL, intent TEXT NOT NULL, receipt TEXT)';

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
      if (lines.some(line => /No such (object|container)/i.test(line))) return null;
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

/** The committed head is never rolled back with a failed or interrupted Docker effect. */
export function createNodeLifecycle(root: string) {
  const directory = resolve(root);
  return {
    async apply(params: unknown): Promise<ContainerLifecycleReply> {
      const input = containerLifecycleRequest.parse(params);
      if (active >= 16) throw new Error('Node lifecycle capacity is busy');
      active++;
      const deadline = performance.now() + input.timeoutMs;
      const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
      const current = () => { if (!remaining()) throw new Error('Node lifecycle deadline exceeded'); };
      const file = join(directory, `service-${input.serviceId}.sqlite`);
      // A timed-out caller cannot let the next command overtake an undrained child.
      const work = queue(file, async () => {
        current();
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (lstatSync(directory).isSymbolicLink() || existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Invalid node lifecycle journal path');
        // A dedicated native database closes its statements and file handles
        // deterministically; no panel schema or pooled libSQL connections.
        const database = new DatabaseSync(file);
        const write = async <T>(operation: () => Promise<T>): Promise<T> => {
          for (;;) {
            current();
            let begun = false;
            try {
              database.exec('BEGIN IMMEDIATE'); begun = true; current();
              const result = await operation(); current();
              database.exec('COMMIT'); begun = false; current(); return result;
            } catch (error) {
              if (begun) database.exec('ROLLBACK');
              if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5) throw error;
              current(); await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining())));
            }
          }
        };
        try {
          database.exec(JOURNAL_SCHEMA);
          current(); chmodSync(file, 0o600);
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
          });
          return await write(async () => {
            const latest = head(); current();
            if (!latest || Number(latest.revision) !== input.revision || latest.request_hash !== hash) throw new Error('Node lifecycle request is stale; superseded by a newer command');
            if (latest.receipt !== null) return containerLifecycleReply.parse(JSON.parse(String(latest.receipt)));
            const receipt = await applyDocker(input, remaining, current);
            current();
            database.prepare('UPDATE lifecycle_head SET receipt=? WHERE id=1 AND revision=? AND request_hash=?').run(JSON.stringify(receipt), input.revision, hash);
            return receipt;
          });
        } finally { database.close(); }
      }).finally(() => { active--; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Node lifecycle deadline exceeded')), Math.max(1, remaining()));
        })]);
      } finally { clearTimeout(timer); }
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
