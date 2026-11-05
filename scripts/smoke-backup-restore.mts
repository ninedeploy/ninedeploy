// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Isolated GitHub-hosted acceptance fixture.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, unlink, rmdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { capture, sleep } from '../apps/server/src/lib/exec.js';
import { verifyPostgresRestore, verifyRestore, type RestoreVerificationResult } from '../apps/server/src/lib/backupRestoreVerification.js';
import { dumpCommands } from '../apps/server/src/lib/databaseCommands.js';
import { backupClickhouse } from '../apps/server/src/engine/extraEngineBackups.js';

/** The managed engines' default images (ENGINES in engine/database.ts). */
const MYSQL_FAMILY = [
  { engine: 'mysql', image: 'mysql:9.7', client: 'mysql', rootEnv: 'MYSQL_ROOT_PASSWORD', dbEnv: 'MYSQL_DATABASE' },
  { engine: 'mariadb', image: 'mariadb:12.3', client: 'mariadb', rootEnv: 'MARIADB_ROOT_PASSWORD', dbEnv: 'MARIADB_DATABASE' },
] as const;
const MONGO_IMAGE = 'mongo:8.0';
/** The Redis family's default images; hosted runners are x86_64 (KeyDB's tags are per architecture). */
const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:25.8';
const REDIS_FAMILY = [
  { engine: 'redis', image: 'redis:8.8', server: 'redis-server', cli: 'redis-cli', flags: ['--dir', '/data'] },
  { engine: 'valkey', image: 'valkey/valkey:9.1', server: 'valkey-server', cli: 'valkey-cli', flags: ['--dir', '/data'] },
  { engine: 'keydb', image: 'eqalpha/keydb:x86_64_v6.3.4', server: 'keydb-server', cli: 'keydb-cli', flags: ['--dir', '/data'] },
  // Dragonfly ships redis-cli and needs the managed snapshot flags to write /data/dump.rdb.
  { engine: 'dragonfly', image: 'ghcr.io/dragonflydb/dragonfly:v1.34.2', server: 'dragonfly', cli: 'redis-cli', flags: ['--logtostderr', '--dir=/data', '--dbfilename=dump', '--df_snapshot_format=false'] },
] as const;

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
  source, publicApi: false, engines: ['postgres', ...MYSQL_FAMILY.map(f => f.engine), 'mongo', 'clickhouse', ...REDIS_FAMILY.map(f => f.engine)], images: {}, cases: [], sourceUntouched: false,
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
    // rseq=1: hosted runners run Linux 6.19+, where mongod 8.0 refuses to
    // start with the image's own rseq=0 (SERVER-121912). Run 41926197835's
    // source exited with exactly that message.
    await docker(['run', '-d', '--name', mongoSource, '--label', `ninedeploy.restore-proof=${owner}`, '--network', 'none',
      '-e', 'GLIBC_TUNABLES=glibc.pthread.rseq=1', mongoImage]);
    phase = 'mongo-source-readiness';
    let mongoReady = false;
    let lastPing = '';
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        lastPing = (await mongoEval('db.adminCommand({ ping: 1 }).ok')).trim();
        if (lastPing === '1') { mongoReady = true; break; }
      } catch (error) { lastPing = error instanceof Error ? error.message : String(error); }
      await sleep(2000);
    }
    if (!mongoReady) {
      // A synthetic source with no data or credentials yet: its state and
      // log tail are safe to keep in the public receipt.
      const state = await docker(['inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} {{.State.Error}}', mongoSource]).catch((error: unknown) => String(error));
      const logs = await docker(['logs', '--tail', '25', mongoSource]).catch((error: unknown) => String(error));
      throw new Error(`mongo source did not become ready; log tail: ${logs.slice(-1800)}; state: ${state.trim()}; last ping: ${lastPing.slice(-400)}`);
    }
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
  {
    // ClickHouse: configured like a managed database (CLICKHOUSE_USER /
    // PASSWORD / DB=app) and backed up by the panel's own `backupClickhouse`.
    const chSource = `nd-restore-source-clickhouse-${owner}`;
    const chPassword = randomUUID();
    const chClient = (query: string) => docker(['exec', chSource, 'clickhouse-client', '-u', 'nine', `--password=${chPassword}`, '-q', query]);
    phase = 'clickhouse-image-pull';
    await docker(['pull', CLICKHOUSE_IMAGE], 300_000);
    const chImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', CLICKHOUSE_IMAGE])).trim();
    assert.match(chImage, /^sha256:[a-f0-9]{64}$/); report.images.clickhouse = chImage;
    phase = 'clickhouse-source-create';
    familySources.push(chSource);
    await docker(['run', '-d', '--name', chSource, '--label', `ninedeploy.restore-proof=${owner}`, '--network', 'none',
      '-e', 'CLICKHOUSE_USER=nine', '-e', `CLICKHOUSE_PASSWORD=${chPassword}`, '-e', 'CLICKHOUSE_DB=app', chImage]);
    phase = 'clickhouse-source-readiness';
    let chReady = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try { if ((await chClient('SELECT 1')).trim() === '1') { chReady = true; break; } } catch { /* not ready yet */ }
      await sleep(2000);
    }
    assert.equal(chReady, true, 'clickhouse source did not become ready');
    phase = 'clickhouse-source-seed';
    await chClient('CREATE TABLE app.sentinel (id UInt32, v Nullable(String)) ENGINE = MergeTree ORDER BY id');
    await chClient("INSERT INTO app.sentinel VALUES (1, 'before'), (2, NULL)");
    phase = 'clickhouse-source-dump';
    const chDump = join(scratch, 'clickhouse.zip'); files.push(chDump);
    await backupClickhouse({ cn: chSource, password: chPassword, username: 'nine' }, chDump, () => undefined);
    const digest = await hash(chDump);
    phase = 'clickhouse-source-mutate';
    await chClient("ALTER TABLE app.sentinel UPDATE v = 'after' WHERE id = 1 SETTINGS mutations_sync = 1");
    const probe = 'SELECT id, v FROM sentinel ORDER BY id';
    const known = '1\tbefore\n2\t\\N';
    phase = 'clickhouse-restore';
    const restored = await verifyRestore('clickhouse', { file: chDump, image: chImage, query: probe, expected: known });
    report.cases.push({ case: phase, verification: restored });
    assert.equal(restored.status, 'passed'); assert.equal(restored.cleanupConfirmed, true);
    phase = 'clickhouse-wrong-data-refusal';
    const wrong = await verifyRestore('clickhouse', { file: chDump, image: chImage, query: probe, expected: known.replace('before', 'after') });
    report.cases.push({ case: phase, verification: wrong }); assert.equal(wrong.status, 'failed');
    phase = 'clickhouse-truncated-archive-refusal';
    const truncated = join(scratch, 'clickhouse-truncated.zip'); files.push(truncated);
    const zip = await readFile(chDump);
    await writeFile(truncated, zip.subarray(0, Math.floor(zip.length / 2)), { mode: 0o600 });
    const refused = await verifyRestore('clickhouse', { file: truncated, image: chImage, query: probe, expected: known });
    report.cases.push({ case: phase, verification: refused }); assert.equal(refused.status, 'failed');
    phase = 'clickhouse-source-verification';
    assert.equal((await chClient("SELECT v FROM app.sentinel WHERE id = 1")).trim(), 'after');
    assert.equal(await hash(chDump), digest);
  }
  for (const { engine, image, server, cli, flags } of REDIS_FAMILY) {
    // A password like production's (`--requirepass`), the panel's own SAVE
    // argv, and its fixed RDB path.
    const redisSource = `nd-restore-source-${engine}-${owner}`;
    const redisPassword = randomUUID();
    const redisCli = (...command: string[]) => docker(['exec', redisSource, cli, '-a', redisPassword, '--no-auth-warning', ...command]);
    phase = `${engine}-image-pull`;
    await docker(['pull', image], 300_000);
    const redisImage = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
    assert.match(redisImage, /^sha256:[a-f0-9]{64}$/); report.images[engine] = redisImage;
    phase = `${engine}-source-create`;
    familySources.push(redisSource);
    await docker(['run', '-d', '--name', redisSource, '--label', `ninedeploy.restore-proof=${owner}`, '--network', 'none',
      '--entrypoint', server, redisImage, '--requirepass', redisPassword, ...flags]);
    phase = `${engine}-source-readiness`;
    let redisReady = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await redisCli('ping')).trim() === 'PONG') { redisReady = true; break; } } catch { /* not ready yet */ }
      await sleep(1000);
    }
    assert.equal(redisReady, true, `${engine} source did not become ready`);
    phase = `${engine}-source-seed`;
    await redisCli('SET', 'greeting', 'before');
    await redisCli('RPUSH', 'queue', 'a', 'b', 'c');
    phase = `${engine}-source-dump`;
    const plan = dumpCommands(engine, redisSource, '', redisPassword);
    assert.equal((await docker(plan.dump, 120_000)).trim(), 'OK');
    const redisDump = join(scratch, `${engine}.rdb`); files.push(redisDump);
    await docker(['cp', `${redisSource}:${plan.file}`, redisDump], 120_000);
    const digest = await hash(redisDump);
    phase = `${engine}-source-mutate`;
    await redisCli('SET', 'greeting', 'after');
    // One command per line; replies print raw, an empty line for nil.
    const probe = ['GET greeting', 'LRANGE queue 0 -1', 'GET missing'].join('\n');
    const known = ['before', 'a', 'b', 'c', ''].join('\n');
    phase = `${engine}-restore`;
    const restored = await verifyRestore(engine, { file: redisDump, image: redisImage, query: probe, expected: known });
    report.cases.push({ case: phase, verification: restored });
    assert.equal(restored.status, 'passed'); assert.equal(restored.cleanupConfirmed, true);
    phase = `${engine}-wrong-data-refusal`;
    const wrong = await verifyRestore(engine, { file: redisDump, image: redisImage, query: probe, expected: known.replace('before', 'after') });
    report.cases.push({ case: phase, verification: wrong }); assert.equal(wrong.status, 'failed');
    phase = `${engine}-truncated-rdb-refusal`;
    const truncated = join(scratch, `${engine}-truncated.rdb`); files.push(truncated);
    const rdb = await readFile(redisDump);
    await writeFile(truncated, rdb.subarray(0, Math.floor(rdb.length / 2)), { mode: 0o600 });
    const refused = await verifyRestore(engine, { file: truncated, image: redisImage, query: probe, expected: known });
    report.cases.push({ case: phase, verification: refused }); assert.equal(refused.status, 'failed');
    phase = `${engine}-source-verification`;
    assert.equal((await redisCli('GET', 'greeting')).trim(), 'after');
    assert.equal(await hash(redisDump), digest);
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
  if (['image-pull', 'source-create', 'source-dump-plain', 'source-dump-custom', 'mysql-image-pull', 'mysql-source-create', 'mariadb-image-pull', 'mariadb-source-create', 'mongo-image-pull', 'mongo-source-create', 'mongo-source-readiness', 'redis-image-pull', 'valkey-image-pull', 'keydb-image-pull', 'redis-source-create', 'valkey-source-create', 'keydb-source-create', 'dragonfly-image-pull', 'dragonfly-source-create', 'clickhouse-image-pull', 'clickhouse-source-create'].includes(phase) && error instanceof Error) report.setupError = error.message.slice(-2500);
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
