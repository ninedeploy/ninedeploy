import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { containerLifecycleReply, containerLifecycleRequest, type ContainerLifecycleReply, type ContainerLifecycleRequest } from '@ninedeploy/schemas';
import { createKeyedOperationGuard } from './keyedOperationGuard.js';
import { spawnValidated } from './spawnValidated.js';

const queue = createKeyedOperationGuard<string>();
let active = 0;
const INSPECT = '{"id":{{json .Id}},"name":{{json .Name}},"managed":{{json (index .Config.Labels "ninedeploy.managed")}},"serviceId":{{json (index .Config.Labels "ninedeploy.service")}},"deploymentId":{{json (index .Config.Labels "ninedeploy.deployment")}},"status":{{json .State.Status}},"running":{{json .State.Running}}}';

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
          database.exec('PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS lifecycle_head (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, request_hash TEXT NOT NULL, intent TEXT NOT NULL, receipt TEXT)');
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
      if (!row || row.name !== target.name && row.name !== `/${target.name}` || row.managed !== 'service' || row.serviceId !== String(input.serviceId) || row.deploymentId !== String(input.deploymentId)) throw new Error('Node lifecycle identity or generation changed');
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
