// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Isolated GitHub-hosted acceptance fixture.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { capture, sleep } from '../apps/server/src/lib/exec.js';
import { verifyPostgresRestore, type RestoreVerificationResult } from '../apps/server/src/lib/backupRestoreVerification.js';

// Every guard precedes the first Docker call. Never run against a local or self-hosted daemon.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use an isolated GitHub Actions runner');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
assert.equal(process.env.DOCKER_HOST, 'unix:///var/run/docker.sock', 'Use only the hosted runner daemon');
assert.ok(!process.env.DOCKER_CONTEXT || process.env.DOCKER_CONTEXT === 'default', 'Use the default hosted Docker context');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/restore-verification');
await mkdir(proof, { recursive: true });
const owner = randomUUID();
const name = `nd-restore-source-${owner}`;
const source = process.env.GITHUB_SHA;
assert.match(source ?? '', /^[a-f0-9]{40}$/);
const docker = (args: string[], timeoutMs = 30_000) => capture('docker', args, { timeoutMs, maxOutputBytes: 64 * 1024 });
const query = (sql: string) => docker(['exec', name, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app', '-c', sql]);
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const report: { source: string | undefined; publicApi: boolean; engine: string; imageId?: string; cases: Array<{ case: string; verification: RestoreVerificationResult }>; sourceUntouched: boolean; backupBytesUnchanged: boolean; helperInventoryUnchanged: boolean; cleanup: boolean; failure?: string } = {
  source, publicApi: false, engine: 'postgres', cases: [], sourceUntouched: false,
  backupBytesUnchanged: false, helperInventoryUnchanged: false, cleanup: false,
};
let scratch: string | undefined;
const files: string[] = [];
let created = false;
let phase = 'setup';
try {
  const helpersBefore = (await docker(['ps', '-a', '--no-trunc', '-q', '--filter', 'label=ninedeploy.role=restore-verification'])).trim().split('\n').filter(Boolean).sort();
  await docker(['pull', 'postgres:18'], 180_000);
  const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', 'postgres:18'])).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/); report.imageId = imageId;
  created = true;
  await docker(['run', '-d', '--name', name, '--label', `ninedeploy.restore-proof=${owner}`, '--network', 'none',
    '--user', 'postgres', '--tmpfs', '/tmp:mode=1777,size=256m', '--tmpfs', '/var/run/postgresql:mode=1777',
    '-e', 'PGDATA=/tmp/nd-source/data', '-e', 'POSTGRES_USER=nine', '-e', 'POSTGRES_DB=app',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', imageId]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await query('SELECT 1'); ready = true; break; } catch { await sleep(1000); }
  }
  assert.equal(ready, true, 'Source did not become ready');
  await query("CREATE TABLE restore_sentinel(id integer PRIMARY KEY, value text); INSERT INTO restore_sentinel VALUES (1,'before');");
  scratch = await mkdtemp(join(tmpdir(), 'nd-restore-proof-'));
  const dumps: Array<{ file: string; digest: string }> = [];
  for (const format of ['plain', 'custom']) {
    const target = `/tmp/backup-${format}.dump`;
    await docker(['exec', name, 'pg_dump', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app', '--clean', '--if-exists', `--format=${format}`, `--file=${target}`]);
    const file = join(scratch, `${format}.dump`); files.push(file);
    await docker(['cp', `${name}:${target}`, file]);
    dumps.push({ file, digest: await hash(file) });
  }
  await query("UPDATE restore_sentinel SET value='after' WHERE id=1");
  const sql = 'SELECT value FROM restore_sentinel WHERE id=1';
  for (const [index, dump] of dumps.entries()) {
    phase = index === 0 ? 'plain-restore' : 'custom-restore';
    const verification = await verifyPostgresRestore({ file: dump.file, image: imageId, query: sql, expected: 'before' });
    report.cases.push({ case: phase, verification });
    assert.equal(verification.status, 'passed'); assert.equal(verification.cleanupConfirmed, true);
  }
  phase = 'wrong-data-refusal';
  const mismatch = await verifyPostgresRestore({ file: dumps[0]!.file, image: imageId, query: sql, expected: 'after' });
  report.cases.push({ case: phase, verification: mismatch }); assert.equal(mismatch.status, 'failed');
  for (const [testCase, body] of [
    ['invalid-sql-refusal', '-- PostgreSQL database dump\nSET statement_timeout=0;\nCREATE TABLE x(id integer); INSERT INTO x VALUES (\'not-an-integer\');\n-- PostgreSQL database dump complete\n'],
    ['missing-extension-refusal', '-- PostgreSQL database dump\nCREATE EXTENSION ninedeploy_missing_extension;\n-- PostgreSQL database dump complete\n'],
  ]) {
    phase = testCase!;
    const file = join(scratch, `${phase}.sql`); files.push(file); await writeFile(file, body!);
    const verification = await verifyPostgresRestore({ file, image: imageId, query: sql, expected: 'before' });
    report.cases.push({ case: phase, verification }); assert.equal(verification.status, 'failed');
  }
  phase = 'source-and-cleanup-verification';
  assert.equal((await query(sql)).trim(), 'after'); report.sourceUntouched = true;
  for (const dump of dumps) assert.equal(await hash(dump.file), dump.digest);
  report.backupBytesUnchanged = true;
  const helpersAfter = (await docker(['ps', '-a', '--no-trunc', '-q', '--filter', 'label=ninedeploy.role=restore-verification'])).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(helpersAfter, helpersBefore); report.helperInventoryUnchanged = true;
} catch {
  report.failure = phase;
} finally {
  let cleanup = true;
  if (created) {
    try {
      const label = (await docker(['inspect', '--format', '{{index .Config.Labels "ninedeploy.restore-proof"}}', name])).trim();
      assert.equal(label, owner);
      await docker(['rm', '-f', '-v', name]);
      assert.equal((await docker(['ps', '-a', '-q', '--filter', `name=^/${name}$`])).trim(), '');
    } catch { cleanup = false; }
  }
  for (const file of files) { try { await unlink(file); } catch { cleanup = false; } }
  if (scratch) { try { await rmdir(scratch); } catch { cleanup = false; } }
  report.cleanup = cleanup;
  await writeFile(join(proof, 'restore-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(report.failure, undefined, 'Restore acceptance failed; inspect the public phase receipt');
assert.equal(report.cleanup, true, 'Owned cleanup was not confirmed');
console.log(JSON.stringify({ source, cases: report.cases.length, cleanup: report.cleanup, sourceUntouched: report.sourceUntouched }));
