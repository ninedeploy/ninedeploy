// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Isolated GitHub-hosted acceptance fixture.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { capture, sleep } from '../apps/server/src/lib/exec.js';
import { verifyPostgresRestore, verifyRestore, type RestoreVerificationResult } from '../apps/server/src/lib/backupRestoreVerification.js';
import { dumpCommands } from '../apps/server/src/lib/databaseCommands.js';

/** The managed engines' default images (ENGINES in engine/database.ts). */
const MYSQL_FAMILY = [
  { engine: 'mysql', image: 'mysql:9.7', client: 'mysql', rootEnv: 'MYSQL_ROOT_PASSWORD', dbEnv: 'MYSQL_DATABASE' },
  { engine: 'mariadb', image: 'mariadb:12.3', client: 'mariadb', rootEnv: 'MARIADB_ROOT_PASSWORD', dbEnv: 'MARIADB_DATABASE' },
] as const;
const MONGO_IMAGE = 'mongo:8.0';

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
const report: { source: string | undefined; publicApi: boolean; engines: string[]; images: Record<string, string>; cases: Array<{ case: string; verification: RestoreVerificationResult }>; sourceUntouched: boolean; backupBytesUnchanged: boolean; helperInventoryUnchanged: boolean; cleanup: boolean; failure?: string; setupError?: string; cleanupError?: string } = {
  source, publicApi: false, engines: ['postgres', ...MYSQL_FAMILY.map(f => f.engine), 'mongo'], images: {}, cases: [], sourceUntouched: false,
  backupBytesUnchanged: false, helperInventoryUnchanged: false, cleanup: false,
};
let scratch: string | undefined;
const files: string[] = [];
let created = false;
/** MySQL-family sources this run created (cleaned up like the PostgreSQL one). */
const familySources: string[] = [];
let phase = 'setup';
try {
  const helpersBefore = (await docker(['ps', '-a', '--no-trunc', '-q', '--filter', 'label=ninedeploy.role=restore-verification'])).trim().split('\n').filter(Boolean).sort();
  phase = 'image-pull';
  await docker(['pull', 'postgres:18'], 180_000);
  const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', 'postgres:18'])).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/); report.images.postgres = imageId;
  phase = 'source-create';
  created = true;
  await docker(['run', '-d', '--name', name, '--label', `ninedeploy.restore-proof=${owner}`, '--network', 'none',
    '--user', 'postgres', '--tmpfs', '/tmp:mode=1777,size=256m', '--tmpfs', '/var/run/postgresql:mode=1777',
    '-e', 'PGDATA=/tmp/nd-source/data', '-e', 'POSTGRES_USER=nine', '-e', 'POSTGRES_DB=app',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', imageId]);
  phase = 'source-readiness';
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await query('SELECT 1'); ready = true; break; } catch { await sleep(1000); }
  }
  assert.equal(ready, true, 'Source did not become ready');
  phase = 'source-seed';
  await query("CREATE TABLE restore_sentinel(id integer PRIMARY KEY, value text); INSERT INTO restore_sentinel VALUES (1,'before');");
  scratch = await mkdtemp(join(tmpdir(), 'nd-restore-proof-'));
  const dumps: Array<{ file: string; digest: string }> = [];
  for (const format of ['plain', 'custom']) {
    phase = `source-dump-${format}`;
    const target = `/tmp/backup-${format}.dump`;
    await docker(['exec', name, 'pg_dump', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app', '--clean', '--if-exists', `--format=${format}`, `--file=${target}`]);
    const file = join(scratch, `${format}.dump`); files.push(file);
    // These tiny synthetic dumps are captured binary-safe. docker cp cannot
    // read user-created tmpfs mounts; production input uses bounded streaming.
    const bytes = await capture('docker', ['exec', name, 'cat', target], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024, captureEncoding: 'base64' });
    await writeFile(file, Buffer.from(bytes, 'base64'), { mode: 0o600 });
    dumps.push({ file, digest: await hash(file) });
  }
  phase = 'source-mutate';
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
  assert.equal((await query(sql)).trim(), 'after');
  for (const dump of dumps) assert.equal(await hash(dump.file), dump.digest);
  for (const { engine, image, client, rootEnv, dbEnv } of MYSQL_FAMILY) {
    const sourceName = `nd-restore-source-${engine}-${owner}`;
    const password = randomUUID();
    const familySql = (statement: string) => docker(['exec', sourceName, client, '-uroot', `--password=${password}`, '-h', '127.0.0.1', '--protocol=tcp', '--batch', '--raw', '--skip-column-names', '--database=app', '-e', statement]);
    phase = `${engine}-image-pull`;
    await docker(['pull', image], 300_000);
    const familyImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
    assert.match(familyImage, /^sha256:[a-f0-9]{64}$/); report.images[engine] = familyImage;
    phase = `${engine}-source-create`;
    familySources.push(sourceName);
    await docker(['run', '-d', '--name', sourceName, '--label', `ninedeploy.restore-proof=${owner}`, '--network', 'none',
      '-e', `${rootEnv}=${password}`, '-e', `${dbEnv}=app`, familyImage]);
    phase = `${engine}-source-readiness`;
    let familyReady = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      // The entrypoint's initialization server is socket-only: TCP means the final server.
      try { await familySql('SELECT 1'); familyReady = true; break; } catch { await sleep(2000); }
    }
    assert.equal(familyReady, true, `${engine} source did not become ready`);
    phase = `${engine}-source-seed`;
    await familySql("CREATE TABLE restore_sentinel(id int PRIMARY KEY, value text); INSERT INTO restore_sentinel VALUES (1,'before'),(2,NULL);");
    phase = `${engine}-source-dump`;
    // The panel's own backup argv: --all-databases, so the restore also
    // replaces the helper's grant tables on disk, exactly as in production.
    const plan = dumpCommands(engine, sourceName, '/tmp/nd-backup.sql', password);
    await docker(plan.dump, 180_000);
    const familyDump = join(scratch, `${engine}.sql`); files.push(familyDump);
    await docker(['cp', `${sourceName}:${plan.file}`, familyDump], 120_000);
    const digest = await hash(familyDump);
    phase = `${engine}-source-mutate`;
    await familySql("UPDATE restore_sentinel SET value='after' WHERE id=1");
    const probe = 'SELECT id, value FROM restore_sentinel ORDER BY id';
    phase = `${engine}-restore`;
    const restored = await verifyRestore(engine, { file: familyDump, image: familyImage, query: probe, expected: '1\tbefore\n2\tNULL' });
    report.cases.push({ case: phase, verification: restored });
    assert.equal(restored.status, 'passed'); assert.equal(restored.cleanupConfirmed, true);
    phase = `${engine}-wrong-data-refusal`;
    const wrong = await verifyRestore(engine, { file: familyDump, image: familyImage, query: probe, expected: '1\tafter\n2\tNULL' });
    report.cases.push({ case: phase, verification: wrong }); assert.equal(wrong.status, 'failed');
    phase = `${engine}-invalid-sql-refusal`;
    const invalid = join(scratch, `${engine}-invalid.sql`); files.push(invalid);
    await writeFile(invalid, "CREATE DATABASE IF NOT EXISTS app;\nUSE app;\nCREATE TABLE x(id int);\nINSERT INTO x VALUES ('not-an-integer');\n");
    const refused = await verifyRestore(engine, { file: invalid, image: familyImage, query: probe, expected: '1\tbefore\n2\tNULL' });
    report.cases.push({ case: phase, verification: refused }); assert.equal(refused.status, 'failed');
    phase = `${engine}-source-verification`;
    assert.equal((await familySql('SELECT value FROM restore_sentinel WHERE id=1')).trim(), 'after');
    assert.equal(await hash(familyDump), digest);
  }
  {
    // MongoDB: the managed default image, a root user like production's, and
    // the panel's own `mongodump --archive --gzip` argv.
    const mongoSource = `nd-restore-source-mongo-${owner}`;
    const mongoPassword = randomUUID();
    const mongoEval = (script: string) => docker(['exec', mongoSource, 'mongosh', '--quiet', '--norc', '--host', '127.0.0.1', '--eval', script]);
    phase = 'mongo-image-pull';
    await docker(['pull', MONGO_IMAGE], 300_000);
    const mongoImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', MONGO_IMAGE])).trim();
    assert.match(mongoImage, /^sha256:[a-f0-9]{64}$/); report.images.mongo = mongoImage;
    phase = 'mongo-source-create';
    familySources.push(mongoSource);
    // No MONGO_INITDB_* variables: an initialization server would also listen
    // on 127.0.0.1 and race the readiness ping. The root user production's
    // dump authenticates as is created below, so the archive carries it too.
    await docker(['run', '-d', '--name', mongoSource, '--label', `ninedeploy.restore-proof=${owner}`, '--network', 'none', mongoImage]);
    phase = 'mongo-source-readiness';
    let mongoReady = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { if ((await mongoEval('db.adminCommand({ ping: 1 }).ok')).trim() === '1') { mongoReady = true; break; } } catch { /* not ready yet */ }
      await sleep(2000);
    }
    assert.equal(mongoReady, true, 'mongo source did not become ready');
    phase = 'mongo-source-seed';
    await mongoEval(`db.getSiblingDB('admin').createUser({ user: 'nine', pwd: '${mongoPassword}', roles: ['root'] })`);
    await mongoEval("db.getSiblingDB('shop').orders.insertMany([{ _id: 1, v: 'before' }, { _id: 2, v: null }])");
    phase = 'mongo-source-dump';
    const plan = dumpCommands('mongo', mongoSource, '/tmp/nd-backup.archive', mongoPassword);
    await docker(plan.dump, 180_000);
    const mongoDump = join(scratch, 'mongo.archive'); files.push(mongoDump);
    await docker(['cp', `${mongoSource}:${plan.file}`, mongoDump], 120_000);
    const digest = await hash(mongoDump);
    phase = 'mongo-source-mutate';
    await mongoEval("db.getSiblingDB('shop').orders.updateOne({ _id: 1 }, { $set: { v: 'after' } })");
    const probe = "EJSON.stringify(db.getSiblingDB('shop').orders.find().sort({ _id: 1 }).toArray())";
    phase = 'mongo-restore';
    const restored = await verifyRestore('mongo', { file: mongoDump, image: mongoImage, query: probe, expected: '[{"_id":1,"v":"before"},{"_id":2,"v":null}]' });
    report.cases.push({ case: phase, verification: restored });
    assert.equal(restored.status, 'passed'); assert.equal(restored.cleanupConfirmed, true);
    phase = 'mongo-wrong-data-refusal';
    const wrong = await verifyRestore('mongo', { file: mongoDump, image: mongoImage, query: probe, expected: '[{"_id":1,"v":"after"},{"_id":2,"v":null}]' });
    report.cases.push({ case: phase, verification: wrong }); assert.equal(wrong.status, 'failed');
    phase = 'mongo-truncated-archive-refusal';
    const truncated = join(scratch, 'mongo-truncated.archive'); files.push(truncated);
    const archive = await readFile(mongoDump);
    await writeFile(truncated, archive.subarray(0, Math.floor(archive.length / 2)), { mode: 0o600 });
    const refused = await verifyRestore('mongo', { file: truncated, image: mongoImage, query: probe, expected: '[]' });
    report.cases.push({ case: phase, verification: refused }); assert.equal(refused.status, 'failed');
    phase = 'mongo-source-verification';
    assert.equal((await mongoEval("db.getSiblingDB('shop').orders.findOne({ _id: 1 }).v")).trim(), 'after');
    assert.equal(await hash(mongoDump), digest);
  }
  phase = 'helper-inventory-verification';
  report.sourceUntouched = true;
  report.backupBytesUnchanged = true;
  const helpersAfter = (await docker(['ps', '-a', '--no-trunc', '-q', '--filter', 'label=ninedeploy.role=restore-verification'])).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(helpersAfter, helpersBefore); report.helperInventoryUnchanged = true;
} catch (error) {
  report.failure = phase;
  // Only fixed synthetic source commands are eligible: never retain the
  // verifier's SQL, data, probe output or any production database diagnostic.
  if (['image-pull', 'source-create', 'source-dump-plain', 'source-dump-custom', 'mysql-image-pull', 'mysql-source-create', 'mariadb-image-pull', 'mariadb-source-create', 'mongo-image-pull', 'mongo-source-create'].includes(phase) && error instanceof Error) report.setupError = error.message.slice(-1000);
} finally {
  let cleanup = true;
  for (const owned of [...(created ? [name] : []), ...familySources]) {
    try {
      const label = (await docker(['inspect', '--format', '{{index .Config.Labels "ninedeploy.restore-proof"}}', owned])).trim();
      assert.equal(label, owner);
      await docker(['rm', '-f', '-v', owned]);
      assert.equal((await docker(['ps', '-a', '-q', '--filter', `name=^/${owned}$`])).trim(), '');
    } catch (error) {
      cleanup = false;
      if (error instanceof Error) report.cleanupError = error.message.slice(-1000);
    }
  }
  for (const file of files) {
    try { await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanup = false; }
  }
  if (scratch) { try { await rmdir(scratch); } catch { cleanup = false; } }
  report.cleanup = cleanup;
  await writeFile(join(proof, 'restore-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(report.failure, undefined, 'Restore acceptance failed; inspect the public phase receipt');
assert.equal(report.cleanup, true, 'Owned cleanup was not confirmed');
console.log(JSON.stringify({ source, cases: report.cases.length, cleanup: report.cleanup, sourceUntouched: report.sourceUntouched }));
