import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const domain = 'node-recovery.test';
const payload = { file: 'drill.txt', value: 'protected node content' };
const select = 'SELECT value FROM drill_state ORDER BY id';
const protectedRows = 'node-order-first\nnode-order-second';
const bootstrapPath = '/v1/servers/ssh-bootstrap';

export function prepareLostNode(ctx, image) {
  const { docker, daemon, exec, inner, remove, absent, api, request, deployment, poll, pass, prefix, report,
    query, fileInVolume, appQuery } = ctx;
  const host = `${prefix}-node`;
  const fixtureImage = docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  const result = { fixtureImage };
  report.nodeReplacement = result;
  let source, serverId, db, service, volume, sshKey, publicKey, originalFingerprint, originalCredential, lostAt;

  function startSsh(node) {
    // A new SSH host key is generated on each node. The operator authorizes the
    // replacement using the fingerprint read directly from its console.
    const prepare = 'set -eu; umask 077; chmod 700 /root/.ssh; printf "%s\\n" "$1" >/root/.ssh/authorized_keys; '
      + 'printf "root:%s\\n" "$(openssl rand -hex 32)" | chpasswd; '
      + 'ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key; ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub';
    const fingerprint = exec(node.daemon, ['sh', '-ec', prepare, 'fixture', publicKey]).split(/\s+/)[1];
    assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    exec(node.daemon, ['sh', '-ec', 'nohup /usr/sbin/sshd -D -e -h /etc/ssh/ssh_host_ed25519_key -o PermitRootLogin=prohibit-password -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no </dev/null >/tmp/n05-sshd.log 2>&1 &']);
    return fingerprint;
  }
  const input = fingerprint => ({ name: 'N05 stateful node', host, sshUser: 'root', sshKey, hostKeyFingerprint: fingerprint, installDocker: false });
  const bootstrap = (panel, fingerprint) => api(panel, bootstrapPath, { body: input(fingerprint), timeout: 240_000 });
  function credentialDigest(node) {
    const hash = inner(node, ['exec', 'ninedeploy-agent', 'printenv', 'NINEDEPLOY_AGENT_TOKEN']);
    assert.ok(/^[a-f0-9]{64}$/.test(hash), 'Agent was not provisioned with a sealed credential');
    return createHash('sha256').update(hash).digest('hex');
  }
  function readApp(panel) {
    return exec(panel.panel, ['curl', '--noproxy', '*', '-fsS', '--max-time', '4', '-H', `Host: ${domain}`, `http://${host}/${payload.file}`]);
  }

  return {
    async capture(panel) {
      source = await daemon('old-node', { image: fixtureImage, alias: host, socket: true });
      exec(source.daemon, ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', '/tmp/n05-operator']);
      sshKey = `${exec(source.daemon, ['cat', '/tmp/n05-operator'])}\n`;
      publicKey = exec(source.daemon, ['cat', '/tmp/n05-operator.pub']);
      exec(source.daemon, ['rm', '/tmp/n05-operator', '/tmp/n05-operator.pub']);
      originalFingerprint = startSsh(source);
      serverId = (await bootstrap(panel, originalFingerprint)).serverId;
      assert.ok(Number.isSafeInteger(serverId) && serverId > 0);
      originalCredential = credentialDigest(source);
      await api(panel, `/v1/servers/${serverId}/test`, { body: {} });
      db = await api(panel, '/v1/databases', { body: { name: 'node-orders', engine: 'postgres', version: '18', serverId } });
      await poll('Node PostgreSQL readiness', () => query(source, db, 'SELECT 1') === '1');
      query(source, db, "CREATE TABLE drill_state(id integer PRIMARY KEY, value text); INSERT INTO drill_state VALUES (1,'node-order-first'), (2,'node-order-second');");
      service = await api(panel, '/v1/services', { body: { name: 'node-recovery', type: 'docker', image: 'nginx:1.27-alpine',
        port: 80, volumeMount: '/usr/share/nginx/html', serverId } });
      const servicePath = `/v1/services/${service.id}`;
      await api(panel, `${servicePath}/attachments`, { body: { databaseId: db.id, envAlias: 'NODE_ORDERS_DATABASE_URL' } });
      const runtime = await deployment(panel, service);
      await api(panel, `${servicePath}/domains`, { body: { hostname: domain, ssl: false } });
      volume = inner(source, ['inspect', runtime, '--format', '{{range .Mounts}}{{if eq .Destination "/usr/share/nginx/html"}}{{.Name}}{{end}}{{end}}']);
      assert.match(volume, /^nd-svc-/);
      fileInVolume(source, volume, payload.file, payload.value);
      await poll('Source node route', () => readApp(panel) === payload.value);
      assert.equal(appQuery(source, runtime, 'NODE_ORDERS_DATABASE_URL'), protectedRows);
      pass('The original node serves a volume-backed workload and its managed PostgreSQL attachment');

      const dbBackup = await api(panel, `/v1/databases/${db.id}/backups`, { body: {} });
      const volBackup = await api(panel, `/v1/volumes/${volume}/backups?serverId=${serverId}`, { body: { label: 'n05-node-loss' } });
      assert.equal(dbBackup.status, 'completed');
      assert.equal(volBackup.status, 'completed');
      assert.equal(volBackup.hasRemoteCopy, true);
      db.backup = dbBackup;
      result.volumeBackup = { id: volBackup.id, sizeBytes: volBackup.sizeBytes };
      result.databaseBackup = { id: dbBackup.id, sizeBytes: dbBackup.sizeBytes };
      return [{ name: db.slug, backup: dbBackup, extension: '.dump' }, { name: volume, backup: volBackup, extension: '.tar.gz' }];
    },
    lose(panel) {
      fileInVolume(source, volume, payload.file, 'node write after backup');
      query(source, db, "INSERT INTO drill_state VALUES (3,'node write after backup');");
      assert.equal(readApp(panel), 'node write after backup');
      assert.match(query(source, db, select), /node write after backup$/);
      remove('container', source.daemon);
      remove('volume', source.data);
      assert.ok(absent('container', source.daemon) && absent('volume', source.data));
      lostAt = Date.now();
      result.sourceRemoved = true;
      pass('The original node daemon, workloads, volumes and agent state were removed after later writes');
    },
    async restore(panel) {
      const node = await daemon('replacement', { image: fixtureImage, alias: host, socket: true });
      assert.equal(inner(node, ['ps', '-aq']), '');
      assert.equal(inner(node, ['volume', 'ls', '-q']), '');
      assert.equal(exec(node.daemon, ['sh', '-ec', 'test ! -e /var/lib/ninedeploy-agent && echo empty']), 'empty');
      const fingerprint = startSsh(node);
      assert.notEqual(fingerprint, originalFingerprint);
      const stale = await request(panel, bootstrapPath, { body: input(originalFingerprint) });
      assert.equal(stale.status, 400);
      assert.match(stale.data.error.message, /not the expected SHA256:/);
      assert.equal(inner(node, ['ps', '-aq']), '');
      const restored = await bootstrap(panel, fingerprint);
      assert.equal(restored.serverId, serverId);
      assert.notEqual(credentialDigest(node), originalCredential);
      const servers = await api(panel, '/v1/servers');
      assert.equal(servers.filter(server => server.host === host).length, 1);
      assert.equal((await api(panel, `/v1/servers/${serverId}/test`, { body: {} })).status, 'online');
      assert.equal((await api(panel, `/v1/services/${service.id}`)).serverId, serverId);
      assert.equal((await api(panel, `/v1/databases/${db.id}`)).serverId, serverId);
      result.serverId = serverId;
      result.sshFingerprintVerified = true;
      result.credentialRotated = true;
      pass('Pinned SSH re-bootstrap rejected the old host key and retained the server ID with a new agent credential');

      const dbPath = `/v1/databases/${db.id}`;
      await api(panel, '/v1/volumes', { body: { name: volume, serverId } });
      await api(panel, `/v1/volumes/${volume}/backups/${result.volumeBackup.id}/restore?serverId=${serverId}`, { body: {} });
      await api(panel, `${dbPath}/start`, { body: {} });
      await poll('Replacement PostgreSQL readiness', () => query(node, db, 'SELECT 1') === '1');
      assert.equal(query(node, db, "SELECT to_regclass('public.drill_state') IS NULL"), 't');
      await api(panel, `${dbPath}/backups/${db.backup.id}/restore`, { body: {} });
      assert.equal(query(node, db, select), protectedRows);
      const runtime = await deployment(panel, service);
      await poll('Recovered node application route', () => readApp(panel) === payload.value);
      assert.equal(appQuery(node, runtime, 'NODE_ORDERS_DATABASE_URL'), protectedRows);
      assert.equal(exec(panel.panel, ['find', '/data/backups', '-name', '*.remote']), '');
      result.recoveryMs = Date.now() - lostAt;
      pass('The clean node restored its remote volume and PostgreSQL dump and served both through the redeployed application');
    },
  };
}
