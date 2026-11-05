// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Isolated GitHub-hosted acceptance fixture.
/**
 * R3 hosted acceptance: PostgreSQL point-in-time recovery through the panel's
 * own functions (engine/pitrArchive.ts, engine/postgresPitr.ts) against a real
 * `postgres:18` with WAL archiving. Every container and volume it creates is
 * named after a fresh owner id, labelled, and removed by name at the end.
 *
 * Cases: a recovery to a time and to the latest point (data checked in the
 * new database, the new password works, no recovery settings left), the
 * refusals (a time after the archive, a time before the first base backup, a
 * damaged segment), the retention, and that no recovery helper is left behind.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Every guard precedes the first Docker call. Never run against a local or self-hosted daemon.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use an isolated GitHub Actions runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock', 'Use only the hosted runner daemon');
assert.ok(!process.env.DOCKER_CONTEXT || process.env.DOCKER_CONTEXT === 'default', 'Use the default hosted Docker context');
assert.ok(process.env.NINEDEPLOY_DATA_DIR, 'Set NINEDEPLOY_DATA_DIR to a scratch directory');

const { encrypt } = await import('../apps/server/src/lib/crypto.js');
const { capture, run, sleep } = await import('../apps/server/src/lib/exec.js');
const { volumeExists } = await import('../apps/server/src/engine/database.js');
const { ensurePitrArchive, pitrServerArgs } = await import('../apps/server/src/engine/pitrArchive.js');
const pitr = await import('../apps/server/src/engine/postgresPitr.js');

const IMAGE = 'postgres:18';
const proof = resolve(process.argv.find((arg) => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/pitr');
await mkdir(proof, { recursive: true });
const owner = randomUUID();
const tag = owner.slice(0, 8);
const source = process.env.GITHUB_SHA;
assert.match(source ?? '', /^[a-f0-9]{40}$/);
const docker = (args: string[], timeoutMs = 60_000) => capture('docker', args, { timeoutMs, maxOutputBytes: 64 * 1024 });
const log = (line: string) => console.log(`  · ${line}`);

type Row = Parameters<typeof pitr.takePitrBaseBackup>[0];
const row = (slug: string, id: number): Row => ({
  id, slug, name: slug, engine: 'postgres', version: null, status: 'running', containerName: `nd-pitr-acc-${tag}-${slug}`, volumeName: `nd-pitr-acc-${tag}-${slug}-data`,
  username: 'nine', passwordEncrypted: encrypt(`pw-${slug}-${tag}`), dbName: 'app', memLimitMb: 0, cpuLimitMilli: 0, cpuShares: 0,
  ownerUserId: null, pitrEnabled: true, serverId: null, pitrRetentionDays: 7,
} as unknown as Row);
const src = row('src', 1);
const psql = (cn: string, sql: string, password?: string) =>
  password
    ? docker(['exec', '-e', `PGPASSWORD=${password}`, cn, 'psql', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app', '-Atc', sql])
    : docker(['exec', '-u', 'postgres', cn, 'psql', '-h', '/var/run/postgresql', '-U', 'nine', '-d', 'app', '-Atqc', sql]);

const report: {
  source: string | undefined; image: string | null; cases: Array<{ case: string; outcome: string; detail: string; restoreMs?: number }>;
  sourceUntouched: boolean; helpersLeft: number | null; cleanup: boolean; failure?: string; cleanupError?: string;
} = { source, image: null, cases: [], sourceUntouched: false, helpersLeft: null, cleanup: false };
const containers: string[] = [];
const volumes: string[] = [src.volumeName!, `${src.volumeName}-wal`];
let phase = 'setup';

async function recoverInto(slug: string, id: number, target: Date | null): Promise<{ outcome: string; detail: string; restoreMs?: number; rows?: string; auth?: boolean; leftover?: string }> {
  const t = row(slug, id);
  volumes.push(t.volumeName!);
  try {
    const out = await pitr.recoverPostgresToPoint(src, t, target, log);
    containers.push(t.containerName!);
    await run('docker', ['run', '-d', '--name', t.containerName!, '--label', `ninedeploy.pitr-proof=${owner}`, '--network', 'none', '-v', `${t.volumeName}:/var/lib/postgresql`, IMAGE], {}, log);
    let rows = '';
    for (let i = 0; i < 60; i++) { try { rows = (await psql(t.containerName!, "SELECT string_agg(v, ',' ORDER BY at) FROM t")).trim(); break; } catch { await sleep(1000); } }
    const auth = (await psql(t.containerName!, 'SELECT 1', `pw-${slug}-${tag}`)).trim() === '1';
    const leftover = (await docker(['exec', '-u', 'postgres', t.containerName!, 'sh', '-c', 'grep -c "^recovery_target\\|^restore_command" "$PGDATA/postgresql.auto.conf" || true'])).trim();
    return { outcome: 'recovered', detail: `${out.recoveredTo} from ${out.baseBackup}`, restoreMs: out.restoreMs, rows, auth, leftover };
  } catch (err) {
    return { outcome: err instanceof pitr.PitrRefusal ? 'refused' : 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

try {
  const helpersBefore = (await docker(['ps', '-a', '-q', '--filter', 'label=ninedeploy.role=pitr-recovery'])).trim();
  phase = 'image-pull';
  await docker(['pull', IMAGE], 300_000);
  report.image = (await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE])).trim();
  phase = 'source-create';
  await ensurePitrArchive(src, IMAGE, log, volumeExists);
  containers.push(src.containerName!);
  await run('docker', ['run', '-d', '--name', src.containerName!, '--label', `ninedeploy.pitr-proof=${owner}`, '--network', 'none',
    '-e', 'POSTGRES_USER=nine', '-e', `POSTGRES_PASSWORD=pw-src-${tag}`, '-e', 'POSTGRES_DB=app',
    '-v', `${src.volumeName}:/var/lib/postgresql`, '-v', `${src.volumeName}-wal:/nd-wal-archive`, IMAGE, ...pitrServerArgs()], {}, log);
  phase = 'source-readiness';
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) { try { await psql(src.containerName!, 'SELECT 1'); ready = true; } catch { await sleep(1000); } }
  assert.equal(ready, true, 'source did not become ready');
  phase = 'preflight';
  assert.equal(await pitr.pitrPreflight(src), null);
  phase = 'seed-and-base-backup';
  await psql(src.containerName!, "CREATE TABLE t(v text, at timestamptz DEFAULT clock_timestamp()); INSERT INTO t(v) VALUES ('one')");
  const label = await pitr.takePitrBaseBackup(src, log);
  phase = 'writes';
  await psql(src.containerName!, "INSERT INTO t(v) VALUES ('two')");
  await sleep(1500);
  const point = new Date();
  await sleep(1500);
  await psql(src.containerName!, "INSERT INTO t(v) VALUES ('three')");
  await psql(src.containerName!, "INSERT INTO t(v) VALUES ('four')");
  await psql(src.containerName!, 'SELECT pg_switch_wal()');
  phase = 'archiving';
  let archived = false;
  for (let i = 0; i < 60 && !archived; i++) {
    const stats = await pitr.pitrArchiverStats(src);
    archived = !!stats && stats.archivedCount >= 4 && !pitr.archivingFailing(stats);
    if (!archived) await sleep(1000);
  }
  assert.equal(archived, true, 'the segments were not archived');
  const inv = await pitr.readPitrInventory(src);
  assert.deepEqual(inv.baseBackups.map((b) => b.label), [label]);
  assert.equal(pitr.recoverableRanges(inv).length, 1);
  const sourceRows = (await psql(src.containerName!, "SELECT string_agg(v, ',' ORDER BY at) FROM t")).trim();

  phase = 'recover-to-time';
  const toTime = await recoverInto('point', 2, point);
  report.cases.push({ case: phase, outcome: toTime.outcome, detail: toTime.detail, restoreMs: toTime.restoreMs });
  assert.equal(toTime.outcome, 'recovered', toTime.detail);
  assert.equal(toTime.rows, 'one,two');
  assert.equal(toTime.auth, true);
  assert.equal(toTime.leftover, '0');

  phase = 'recover-to-latest';
  const latest = await recoverInto('latest', 3, null);
  report.cases.push({ case: phase, outcome: latest.outcome, detail: latest.detail, restoreMs: latest.restoreMs });
  assert.equal(latest.outcome, 'recovered', latest.detail);
  assert.equal(latest.rows, 'one,two,three,four');
  assert.equal(latest.auth, true);

  phase = 'refuse-future';
  const future = await recoverInto('future', 4, new Date(Date.now() + 60 * 60_000));
  report.cases.push({ case: phase, outcome: future.outcome, detail: future.detail });
  assert.equal(future.outcome, 'refused');
  assert.match(future.detail, /Nothing after .* has been archived yet/);

  phase = 'refuse-before-base-backup';
  const early = await recoverInto('early', 5, new Date(Date.now() - 60 * 60_000));
  report.cases.push({ case: phase, outcome: early.outcome, detail: early.detail });
  assert.equal(early.outcome, 'refused');
  assert.match(early.detail, /No base backup finished before/);

  phase = 'source-untouched';
  report.sourceUntouched = (await psql(src.containerName!, "SELECT string_agg(v, ',' ORDER BY at) FROM t")).trim() === sourceRows && sourceRows === 'one,two,three,four';
  assert.equal(report.sourceUntouched, true);

  phase = 'refuse-damaged-segment';
  const newest = inv.segments.at(-1)!.name;
  await docker(['exec', '-u', 'postgres', src.containerName!, 'sh', '-c', `head -c 2000 /nd-wal-archive/wal/${newest}.gz > /tmp/x && cat /tmp/x > /nd-wal-archive/wal/${newest}.gz`]);
  const damaged = await recoverInto('damaged', 6, null);
  report.cases.push({ case: phase, outcome: damaged.outcome, detail: damaged.detail });
  assert.equal(damaged.outcome, 'refused');
  assert.match(damaged.detail, new RegExp(`Segment ${newest} in the archive is damaged`));

  phase = 'retention';
  await sleep(1100);
  await psql(src.containerName!, "INSERT INTO t(v) VALUES ('five')");
  const second = await pitr.takePitrBaseBackup(src, log);
  const pruned = await pitr.prunePitrArchive(src, 0, log);
  const after = await pitr.readPitrInventory(src);
  report.cases.push({ case: phase, outcome: 'pruned', detail: `removed ${pruned.removedBases.join(',')}; kept ${after.baseBackups.map((b) => b.label).join(',')}; ${after.segments.length} segment(s) left` });
  assert.deepEqual(pruned.removedBases, [label]);
  assert.deepEqual(after.baseBackups.map((b) => b.label), [second]);
  assert.ok(after.segments.every((s) => s.name >= after.baseBackups[0]!.startSegment));

  phase = 'helpers';
  const helpersAfter = (await docker(['ps', '-a', '-q', '--filter', 'label=ninedeploy.role=pitr-recovery'])).trim();
  report.helpersLeft = helpersAfter.split('\n').filter(Boolean).length - helpersBefore.split('\n').filter(Boolean).length;
  assert.equal(report.helpersLeft, 0);
} catch (error) {
  report.failure = phase;
  console.error(error);
} finally {
  let cleanup = true;
  for (const name of containers) {
    try {
      const label = (await docker(['inspect', '--format', '{{index .Config.Labels "ninedeploy.pitr-proof"}}', name])).trim();
      assert.equal(label, owner);
      await docker(['rm', '-f', name]);
    } catch (error) {
      cleanup = false;
      if (error instanceof Error) report.cleanupError = error.message.slice(-1000);
    }
  }
  for (const volume of volumes) {
    // Only this run's names; a refused recovery never created its volume.
    if (!volume.startsWith(`nd-pitr-acc-${tag}-`)) { cleanup = false; continue; }
    try { if (await volumeExists(volume)) await docker(['volume', 'rm', volume]); }
    catch (error) { cleanup = false; if (error instanceof Error) report.cleanupError = error.message.slice(-1000); }
  }
  report.cleanup = cleanup;
  await writeFile(join(proof, 'postgres-pitr.json'), `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(report.failure, undefined, `PITR acceptance failed at ${report.failure}; inspect the receipt`);
assert.equal(report.cleanup, true, 'Owned cleanup was not confirmed');
console.log(JSON.stringify({ source, cases: report.cases.map((c) => `${c.case}:${c.outcome}`), cleanup: report.cleanup }));
