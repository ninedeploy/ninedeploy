/** Internal R3 adapter. Public drill integration and native acceptance are separate gates. */
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { capture, ExecOutputTooLargeError, ExecTimeoutError, sleep } from './exec.js';
import { streamFileToCommand } from './fileCommandInput.js';

export interface PostgresRestoreProbe {
  /** Already decrypted, caller-owned backup. Never modified or removed here. */
  file: string;
  /** Managed engine image; resolved to its immutable config ID before use. */
  image: string;
  query: string;
  /** Exact unaligned psql output, excluding its final newline. Never persisted by this adapter. */
  expected: string;
}
export interface RestoreVerificationResult {
  status: 'passed' | 'failed' | 'unverifiable';
  engine: 'postgres';
  format: 'plain' | 'custom' | null;
  imageId: string | null;
  durationMs: number;
  restoreMs: number | null;
  queryMs: number | null;
  queryMatched: boolean;
  cleanupConfirmed: boolean;
  /** Fixed diagnostic only: no engine stderr, SQL, expected value or restored data. */
  error: string | null;
}
const QUICK_MS = 10_000;
const DUMP = '/tmp/nd-restore-source.dump';
/** The helper's only data filesystem holds both the dump and PGDATA. */
const SCRATCH_MIB = 1024;
/** A dump above half the scratch cannot fit beside its own restored data. */
export const RESTORE_VERIFICATION_MAX_DUMP_BYTES = (SCRATCH_MIB / 2) * 1024 * 1024;
const HELPER_ROLE = 'ninedeploy.role=restore-verification';
const HELPER_NAME = /^\/?ninedeploy-restore-check-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Engine messages that mean the bounded helper ran out of room, not that the
 * backup is bad. Only this boolean is used; stderr itself is never kept. */
const CAPACITY_ERROR = /No space left on device|could not extend file|out of memory|Cannot allocate memory/i;

/**
 * Restore and query a backup inside an ephemeral, networkless PostgreSQL server.
 * No source database identity/credentials enter this API. Its only writable
 * filesystems are bounded tmpfs mounts. No bind mounts, sockets or published
 * ports; anonymous image volumes are removed as well. A cleanup failure cannot
 * produce a passing result. This verifies the supplied probe, not all data.
 */
export async function verifyPostgresRestore(input: PostgresRestoreProbe): Promise<RestoreVerificationResult> {
  if (!input.query.trim() || Buffer.byteLength(input.query) > 16_384 || Buffer.byteLength(input.expected) > 16_384) {
    throw new Error('A restore probe requires a query and an expected result of at most 16384 bytes each');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_@-]*$/.test(input.image)) throw new Error('Invalid restore engine image');
  const started = Date.now();
  const result: RestoreVerificationResult = {
    status: 'unverifiable', engine: 'postgres', format: null, imageId: null,
    durationMs: 0, restoreMs: null, queryMs: null, queryMatched: false,
    cleanupConfirmed: false, error: 'Restore verification did not complete',
  };
  const name = `ninedeploy-restore-check-${randomUUID()}`;
  let createAttempted = false;
  let phase: 'setup' | 'restore' | 'query' = 'setup';
  let oversized = false;
  const docker = (args: string[], timeoutMs = QUICK_MS, maxOutputBytes = 4096) =>
    capture('docker', args, { timeoutMs, maxOutputBytes });
  try {
    const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', input.image])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Missing immutable image identity');
    result.imageId = imageId;
    const handle = await open(input.file, 'r');
    try {
      // Refuse before any helper exists: an oversized dump cannot fit the
      // bounded scratch, and that says nothing about whether it restores.
      if ((await handle.stat()).size > RESTORE_VERIFICATION_MAX_DUMP_BYTES) {
        oversized = true;
        throw new Error('Backup exceeds the bounded restore verification capacity');
      }
      const header = Buffer.alloc(5);
      const { bytesRead } = await handle.read(header, 0, 5, 0);
      result.format = bytesRead === 5 && header.toString('ascii') === 'PGDMP' ? 'custom' : 'plain';
    } finally { await handle.close(); }
    // The caller's private staged file is streamed through exec stdin, read by
    // this process: no second plaintext copy on the panel's disk (a crash
    // between copy and cleanup left one that no housekeeping sweep matched),
    // and Docker's archive API never resolves a path inside the helper's tmpfs.
    createAttempted = true;
    await docker([
      'create', '--name', name, '--label', 'ninedeploy.role=restore-verification',
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--user', 'postgres', '--pids-limit', '128', '--memory', '1536m', '--cpus', '1',
      '--tmpfs', `/tmp:rw,nosuid,nodev,mode=1777,size=${SCRATCH_MIB}m`,
      '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,mode=1777,size=16m',
      '--tmpfs', '/var/lib/postgresql:rw,nosuid,nodev,mode=1777,size=1m',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,mode=1777,size=1m',
      '--env', 'PGDATA=/tmp/nd-restore/data', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '--env', 'POSTGRES_USER=nine', '--env', 'POSTGRES_DB=app',
      '--pull', 'never', imageId,
    ]);
    await docker(['start', name]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        // The entrypoint's temporary initialization server listens on a Unix
        // socket only. Require TCP so it cannot race the final server startup.
        await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app'], 1000);
        ready = true; break;
      } catch { await sleep(1000); }
    }
    if (!ready) throw new Error('Restore helper did not become ready');
    await streamFileToCommand('docker', ['exec', '-i', name, 'sh', '-c', 'umask 077; cat > "$1"', 'restore-copy', DUMP], input.file, 60_000);
    phase = 'restore';
    const restoreStarted = Date.now();
    const connection = ['-h', '127.0.0.1', '-U', 'nine', '-d', 'app'];
    const restore = result.format === 'custom'
      ? ['pg_restore', '--exit-on-error', '--single-transaction', ...connection, DUMP]
      : ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', ...connection, '-f', DUMP];
    await docker(['exec', name, ...restore], 300_000, 64 * 1024);
    result.restoreMs = Date.now() - restoreStarted;
    phase = 'query';
    const queryStarted = Date.now();
    const output = await docker(['exec', name, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...connection, '-c', input.query], 15_000, 16_386);
    result.queryMs = Date.now() - queryStarted;
    result.queryMatched = output.replace(/\r?\n$/, '') === input.expected;
    result.status = result.queryMatched ? 'passed' : 'failed';
    result.error = result.queryMatched ? null : 'Restored data did not match the expected probe result';
  } catch (error) {
    // Exhausting the bounded helper (scratch or memory) is not evidence that
    // the backup is broken: an operator reads 'failed' as "does not restore".
    const exhausted = phase !== 'setup' && !(error instanceof ExecTimeoutError) && !(error instanceof ExecOutputTooLargeError)
      && await helperExhausted(error, name, docker);
    const unavailable = phase === 'setup' || exhausted || error instanceof ExecTimeoutError || error instanceof ExecOutputTooLargeError;
    result.status = unavailable ? 'unverifiable' : 'failed';
    result.error = oversized || exhausted
      ? 'Backup exceeds the bounded restore verification capacity'
      : unavailable ? `Restore verification could not complete during ${phase}` : `Restore verification failed during ${phase}`;
  } finally {
    let cleanup = true;
    if (createAttempted) {
      try {
        // Use the preallocated random name even if create's reply was lost.
        await docker(['rm', '-f', '-v', name]);
        const retained = await docker(['ps', '-a', '--no-trunc', '-q', '--filter', `name=^/${name}$`]);
        cleanup = retained.trim() === '';
      } catch { cleanup = false; }
    }
    result.cleanupConfirmed = cleanup;
    if (!cleanup) {
      result.status = 'unverifiable';
      result.error = 'Restore verification cleanup could not be confirmed';
    }
    result.durationMs = Date.now() - started;
  }
  return result;
}

/** True when a restore/query failure is explained by the helper's bounds:
 * an engine out-of-space/out-of-memory message, or a cgroup OOM kill. If the
 * helper's state cannot be read, it cannot be shown to have been healthy, so
 * the failure is not attributed to the backup either. */
async function helperExhausted(
  error: unknown,
  name: string,
  docker: (args: string[], timeoutMs?: number, maxOutputBytes?: number) => Promise<string>,
): Promise<boolean> {
  if (error instanceof Error && CAPACITY_ERROR.test(error.message)) return true;
  try {
    return (await docker(['inspect', '--format', '{{.State.OOMKilled}}', name])).trim() === 'true';
  } catch {
    return true;
  }
}

/**
 * Remove restore helpers a crashed panel left behind. A helper holds the
 * decrypted dump and the restored database in tmpfs, and a process that died
 * between create and cleanup (OOM, restart, self-update) never removes it —
 * the same exposure r302 closed for drill scratch files. Only containers with
 * the helper label AND the exact generated name pattern, older than `maxAgeMs`
 * (far above one verification's bounded lifetime), are removed. Best-effort per
 * container; returns the count removed.
 */
export async function pruneRestoreVerificationHelpers(maxAgeMs: number, now = Date.now()): Promise<number> {
  const quick = { timeoutMs: QUICK_MS, maxOutputBytes: 64 * 1024 };
  const ids = (await capture('docker', ['ps', '-a', '--no-trunc', '-q', '--filter', `label=${HELPER_ROLE}`], quick))
    .split('\n').map((line) => line.trim()).filter((id) => /^[a-f0-9]{64}$/.test(id));
  let removed = 0;
  for (const id of ids) {
    try {
      const [created = '', containerName = ''] = (await capture('docker', ['inspect', '--format', '{{.Created}} {{.Name}}', id], quick)).trim().split(' ');
      const createdMs = Date.parse(created);
      if (!HELPER_NAME.test(containerName) || !Number.isFinite(createdMs) || now - createdMs < maxAgeMs) continue;
      await capture('docker', ['rm', '-f', '-v', id], quick);
      removed++;
    } catch {
      /* best effort: the container vanished, or one daemon call failed */
    }
  }
  return removed;
}
