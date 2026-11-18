/** Isolated acceptance fixture, including a closed SQL control endpoint that is never shipped as an agent operation. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const input = JSON.parse(await readFile('/tmp/node-fixture.json', 'utf8'));
if (process.argv[2] === 'agent') {
  const { buildAgentApp } = await import('../../apps/server/dist/agentApp.js');
  const { agentRoutes } = await import('../../apps/server/dist/agent.js');
  const { capture } = await import('../../apps/server/dist/lib/exec.js');
  const app = await buildAgentApp();
  await app.register(agentRoutes, { tokenHash: input.tokenHash, nonceFile: '/tmp/fixture-nonces' });
  const statements = new Set([
    'SELECT 1', 'SELECT clock_timestamp()', 'SELECT pg_switch_wal()', "SELECT string_agg(v, ',' ORDER BY v) FROM proof",
    "CREATE TABLE proof(v text); INSERT INTO proof VALUES ('one')",
    ...['two', 'three', 'four', 'five', 'six', 'seven'].map((v) => `INSERT INTO proof VALUES ('${v}')`),
  ]);
  app.post('/fixture/sql', async (req, reply) => {
    if (req.headers['x-fixture-control'] !== input.control) return reply.code(403).send({ error: 'fixture control' });
    const sql = req.body?.sql;
    if (!statements.has(sql)) return reply.code(400).send({ error: 'fixture statement' });
    const out = await capture('docker', ['exec', '-u', 'postgres', '-e', 'PGPASSWORD=source-only-password', 'nd-db-source', 'psql', '-h', '127.0.0.1', '-U', 'nine', '-d', 'app', '-X', '-Atqc', sql], { timeoutMs: 10000 });
    return { out };
  });
  app.post('/fixture/pitr-switch', async (req, reply) => {
    if (req.headers['x-fixture-control'] !== input.control || typeof req.body?.off !== 'boolean') return reply.code(403).send({ error: 'fixture control' });
    if (req.body.off) process.env.NINEDEPLOY_AGENT_PITR = 'off'; else delete process.env.NINEDEPLOY_AGENT_PITR;
    return { changed: true };
  });
  await app.listen({ host: '0.0.0.0', port: 4600 });
} else if (process.argv[2] === 'produce') {
  const started = Date.now();
  const { migrate } = createRequire('/app/apps/server/package.json')('drizzle-orm/libsql/migrator');
  const { createDb, servers, databases, users, backupDestinations } = await import('../../packages/db/dist/index.js');
  const { encrypt } = await import('../../apps/server/dist/lib/crypto.js');
  const { capture, sleep } = await import('../../apps/server/dist/lib/exec.js');
  const { agentOp } = await import('../../apps/server/dist/lib/agentClient.js');
  const { databaseRuntime } = await import('../../apps/server/dist/lib/databaseRuntime.js');
  const { setPitr, pitrBusy, runPitrBaseBackup } = await import('../../apps/server/dist/lib/pitr.js');
  const { nodePitrInventory, nodePitrDeps } = await import('../../apps/server/dist/lib/nodePitr.js');
  const remote = await import('../../apps/server/dist/lib/pitrRemote.js');
  const { s3Request } = await import('../../apps/server/dist/lib/s3.js');
  const { produceStream } = await import('./pitr-stream-produce.mjs');
  const { db, client } = createDb({ url: 'file:/tmp/source-panel.db' });
  const log = console.log;
  const control = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:4600/fixture/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-control': input.control }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Fixture control failed (${response.status}): ${await response.text()}`);
    await response.text();
  };
  const sql = async (statement) => {
    const response = await fetch('http://127.0.0.1:4600/fixture/sql', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-control': input.control }, body: JSON.stringify({ sql: statement }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Fixture SQL failed (${response.status})`);
    return (await response.json()).out;
  };
  try {
    await migrate(db, { migrationsFolder: '/app/packages/db/src/migrations' });
    const actor = (await db.insert(users).values({ email: 'node-proof@example.test', passwordHash: 'x', isInstanceOperator: true }).returning())[0].id;
    const serverId = (await db.insert(servers).values({ name: 'proof node', host: '127.0.0.1', port: 4600, tokenEncrypted: encrypt(input.token), status: 'online' }).returning())[0].id;
    let source = (await db.insert(databases).values({ name: 'source', slug: 'source', engine: 'postgres', status: 'running', version: '18', serverId,
      containerName: null, volumeName: null, nodeContainerName: 'nd-db-source', nodeVolumeName: 'nd-db-source-data', username: 'nine', dbName: 'app', passwordEncrypted: encrypt('source-only-password'), ownerUserId: actor }).returning())[0];
    await assert.rejects(capture('docker', ['info'], { timeoutMs: 3000 }), undefined, 'the panel fixture must not have access to a Docker daemon');
    for (let n = 0; ; n++) {
      try { await agentOp(db, serverId, 'agent.ping', {}, () => undefined); break; }
      catch (err) { if (n >= 30) throw err; await sleep(500); }
    }
    await databaseRuntime(db, source).start(log);
    for (let n = 0; ; n++) { try { await sql('SELECT 1'); break; } catch (err) { if (n >= 90) throw err; await sleep(500); } }
    await sql("CREATE TABLE proof(v text); INSERT INTO proof VALUES ('one')");
    source = await setPitr(db, source, { enabled: true }, actor, log);
    for (let n = 0; ; n++) {
      if (!pitrBusy.baseBackup(source.id) && (await nodePitrInventory(db, source)).baseBackups.length) break;
      if (n >= 180) throw new Error('The node first base backup did not finish'); await sleep(500);
    }
    const pitr = { readPitrInventory: () => nodePitrInventory(db, source), takePitrBaseBackup: (_d, logger) => runPitrBaseBackup(db, source, actor, logger) };
    await produceStream({ db, source, actor, sql, pitr, remote, log, started, sleep, backupDestinations, encrypt });
    const receipt = JSON.parse(await readFile('/tmp/receipt.json', 'utf8'));
    const cfg = { endpoint: 'https://pitr-store:9443', region: 'us-east-1', bucket: 'archive', accessKeyId: 'fixture', secretAccessKey: 'fixture-secret' };
    const before = (await s3Request(cfg, 'HEAD', receipt.key)).headers.get('etag');
    await control('pitr-switch', { off: true });
    await assert.rejects(remote.runRemotePitrCheckpoint(db, source, log));
    assert.equal((await s3Request(cfg, 'HEAD', receipt.key)).headers.get('etag'), before);
    await control('pitr-switch', { off: false });
    await remote.configureRemotePitr(db, source, { enabled: true, destinationId: receipt.status.settings.destinationId, intervalMinutes: 15, mode: 'checkpoint' }, actor);
    const checkpoint = await remote.runRemotePitrCheckpoint(db, source, log);
    assert.match(checkpoint.key, /\.ndpc$/);
    source = await setPitr(db, source, { enabled: false }, actor, log);
    assert.equal(await nodePitrDeps(db, source).archiveExists(source), false);
    assert.equal((await s3Request(cfg, 'HEAD', receipt.key)).status, 200);
    let rows;
    for (let n = 0; ; n++) { try { rows = (await sql("SELECT string_agg(v, ',' ORDER BY v) FROM proof")).trim(); break; } catch (err) { if (n >= 60) throw err; await sleep(500); } }
    assert.equal(rows, receipt.checkpointRows);
    Object.assign(receipt, { nodeArchive: true, nodeCheckpointVerified: true, nodeKillSwitchRefused: true, nodeDisableVerified: true, nodeLocalDockerUnavailable: true, nodeCheckpointKey: checkpoint.key });
    await writeFile('/tmp/receipt.json', JSON.stringify(receipt, null, 2));
    console.log('NODE_REMOTE_ARCHIVE_VERIFIED');
  } finally { client.close(); }
} else throw new Error('Unknown node fixture mode');
