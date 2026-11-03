/** Internal R3 adapter. Public drill integration and native acceptance are separate gates. */
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, ExecOutputTooLargeError, ExecTimeoutError, sleep } from './exec.js';

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
  let scratch: string | undefined;
  let copy: string | undefined;
  let phase: 'setup' | 'restore' | 'query' = 'setup';
  const docker = (args: string[], timeoutMs = QUICK_MS, maxOutputBytes = 4096) =>
    capture('docker', args, { timeoutMs, maxOutputBytes });
  try {
    const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', input.image])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Missing immutable image identity');
    result.imageId = imageId;
    const handle = await open(input.file, 'r');
    try {
      const header = Buffer.alloc(5);
      const { bytesRead } = await handle.read(header, 0, 5, 0);
      result.format = bytesRead === 5 && header.toString('ascii') === 'PGDMP' ? 'custom' : 'plain';
    } finally { await handle.close(); }
    // docker cp may retain the panel's uid. Make only our private copy readable
    // by the helper's postgres user; the parent remains 0700 and source stays intact.
    scratch = await mkdtemp(join(tmpdir(), 'nd-restore-verification-'));
    await chmod(scratch, 0o700);
    copy = join(scratch, 'source.dump');
    await copyFile(input.file, copy);
    await chmod(copy, 0o644);
    createAttempted = true;
    await docker([
      'create', '--name', name, '--label', 'ninedeploy.role=restore-verification',
      '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--user', 'postgres', '--pids-limit', '128', '--memory', '1536m', '--cpus', '1',
      '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=1g',
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
    await docker(['cp', copy, `${name}:${DUMP}`], 30_000);
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
    const unavailable = phase === 'setup' || error instanceof ExecTimeoutError || error instanceof ExecOutputTooLargeError;
    result.status = unavailable ? 'unverifiable' : 'failed';
    result.error = unavailable ? `Restore verification could not complete during ${phase}` : `Restore verification failed during ${phase}`;
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
    if (copy) { try { await unlink(copy); } catch { cleanup = false; } }
    if (scratch) { try { await rmdir(scratch); } catch { cleanup = false; } }
    result.cleanupConfirmed = cleanup;
    if (!cleanup) {
      result.status = 'unverifiable';
      result.error = 'Restore verification cleanup could not be confirmed';
    }
    result.durationMs = Date.now() - started;
  }
  return result;
}
