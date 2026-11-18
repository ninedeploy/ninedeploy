import assert from 'node:assert/strict';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pebbleImage = 'ghcr.io/letsencrypt/pebble:2.10.1';
const dnsImage = 'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1';
const enrolment = '/v1/settings/enrolment/rotate';
const servers = '/v1/servers';

// Resolve from the same private DNS server Pebble uses. Keep HTTP Host and TLS
// SNI on the original hostname, and trust only the fixture CA for HTTPS.
const visitorRequest = `
import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { readFileSync } from 'node:fs';
const [dns, host, path, tls] = process.argv.slice(1);
const resolver = new Resolver({ timeout: 1500, tries: 1 });
resolver.setServers([dns + ':8053']);
const records = await resolver.resolve4(host, { ttl: true });
assert.equal(records.length, 1);
const ipv6 = await resolver.resolve6(host).catch(error => {
  if (error.code === 'ENODATA') return [];
  throw error;
});
assert.deepEqual(ipv6, []);
const { address, ttl } = records[0];
if (!path) console.log(JSON.stringify({ address, ttl }));
else {
  const encrypted = tls === 'true';
  const send = encrypted ? https : http;
  const options = { host: address, path, headers: { Host: host }, signal: AbortSignal.timeout(3500),
    ...(encrypted ? { servername: host, ca: readFileSync('/fixture/issued-root.pem') } : {}) };
  const response = await new Promise((resolve, reject) => send(options, resolve).on('error', reject).end());
  const certificate = encrypted ? response.socket.getPeerCertificate() : undefined;
  let body = '';
  for await (const chunk of response) body += chunk;
  console.log(JSON.stringify({ address, ttl, status: response.statusCode, location: response.headers.location,
    body: body.trim(), fingerprint: certificate?.fingerprint256, names: certificate?.subjectaltname }));
}
`;

export async function prepareCutover(ctx, source, target, tls) {
  const { docker, runContainer, exec, inner, owned, remove, daemon, api, request, deployment, poll, pass, prefix, network, host, report } = ctx;
  const ca = `${prefix}-pebble`;
  const dns = `${prefix}-dns`;
  const visitor = `${prefix}-visitor`;
  const agent = `${prefix}-agent`;
  const node = await daemon('node');
  const trust = join(tls, 'trust');
  mkdirSync(trust);
  const imageId = image => docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  const ip = name => {
    const value = docker(['inspect', owned('container', name), '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']);
    assert.ok(isIPv4(value), `Invalid private address for ${name}`);
    return value;
  };
  const saved = { images: { pebble: imageId(pebbleImage), dns: imageId(dnsImage) } };
  report.cutover = saved;
  runContainer(dns, ['--network', network, saved.images.dns, '-defaultIPv4=', '-defaultIPv6=', '-http01=', '-https01=', '-tlsalpn01=', '-doh=']);
  runContainer(visitor, ['--network', network, '--no-healthcheck', '--mount', `type=bind,src=${trust},dst=/fixture,readonly`,
    '--entrypoint', 'sleep', report.imageId, 'infinity']);
  const caIP = ip(visitor);
  const dnsIP = ip(dns);
  const sourceIP = ip(source.daemon);
  const targetIP = ip(target.daemon);
  assert.notEqual(sourceIP, targetIP);

  // The HTTPS API certificate is distinct from the CA root that signs the
  // application certificate. Neither is trusted outside the fixture.
  exec(source.daemon, ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=N05 Pebble API',
    '-addext', `subjectAltName=IP:${caIP}`, '-keyout', '/tmp/n05-pebble-key.pem', '-out', '/tmp/n05-pebble-api.pem']);
  for (const name of ['key', 'api']) {
    const pem = exec(source.daemon, ['cat', `/tmp/n05-pebble-${name}.pem`]);
    assert.match(pem, /^-----BEGIN /);
    writeFileSync(join(tls, `pebble-${name}.pem`), `${pem}\n`, { mode: name === 'key' ? 0o600 : 0o644 });
    if (name === 'api') writeFileSync(join(trust, 'pebble-api.pem'), `${pem}\n`);
  }
  writeFileSync(join(tls, 'pebble.json'), JSON.stringify({ pebble: {
    listenAddress: '0.0.0.0:14000', managementListenAddress: '0.0.0.0:15000',
    certificate: '/fixture/pebble-api.pem', privateKey: '/fixture/pebble-key.pem', httpPort: 80, tlsPort: 443,
    externalAccountBindingRequired: false, retryAfter: { authz: 1, order: 1 },
  } }));
  runContainer(ca, ['--network', `container:${owned('container', visitor)}`, '--mount', `type=bind,src=${tls},dst=/fixture,readonly`,
    '-e', 'PEBBLE_VA_NOSLEEP=1', '-e', 'PEBBLE_WFE_NONCEREJECT=0', saved.images.pebble,
    '-config', '/fixture/pebble.json', '-dnsserver', `${dnsIP}:8053`]);
  const directory = `https://${caIP}:14000/dir`;
  const caGet = url => exec(visitor, ['curl', '-fsS', '--noproxy', '*', '--max-time', '4', '--cacert', '/fixture/pebble-api.pem', url]);
  const issuedRoot = await poll('Pebble signing root', () => caGet(`https://${caIP}:15000/roots/0`));
  assert.match(issuedRoot, /^-----BEGIN CERTIFICATE-----/);
  writeFileSync(join(trust, 'issued-root.pem'), `${issuedRoot}\n`);
  assert.ok(JSON.parse(caGet(directory)).newOrder);

  function dnsUpdate(action, body) {
    exec(visitor, ['curl', '-fsS', '--noproxy', '*', '--max-time', '4', '-H', 'content-type: application/json',
      '--data', JSON.stringify({ host: `${host}.`, ...body }), `http://${dnsIP}:8055/${action}`]);
  }
  function setAddress(address) {
    // The fixture API adds individual answers; clear the old RRset first.
    dnsUpdate('clear-a', {});
    dnsUpdate('add-a', { addresses: [address] });
  }
  const visit = (path = '', secure = false) => JSON.parse(exec(visitor, ['node', '--input-type=module', '-e', visitorRequest, dnsIP, host, path, String(secure)]));

  let sourceEnrolment, original, nodeService, workloadId, enrolledAt;
  const startAgent = (site, token) => runContainer(agent, ['--network', network, '-v', `${node.data}:/data`, '-w', '/data',
    '-e', 'NINEDEPLOY_AGENT=1', '-e', `DOCKER_HOST=tcp://${node.daemon}:2375`, '-e', `NINEDEPLOY_MASTER_URL=http://${site.panel}:3000`,
    '-e', 'NINEDEPLOY_NODE_NAME=N05 surviving node', '-e', `NINEDEPLOY_ADVERTISE_HOST=${agent}`,
    '-e', `NINEDEPLOY_ENROLMENT_TOKEN=${token}`, report.imageId, 'node', '/app/apps/server/dist/server.js']);
  const registry = site => api(site, servers);

  return {
    directory,
    async beforeBackup(site, file) {
      setAddress(sourceIP);
      const before = visit(`/${file.route}`);
      assert.deepEqual([before.address, before.status, before.body], [sourceIP, 200, file.value]);
      saved.sourceDns = { address: before.address, ttl: before.ttl };
      sourceEnrolment = (await api(site, enrolment, { body: {} })).token;
      startAgent(site, sourceEnrolment);
      original = await poll('Initial node announcement', async () => (await registry(site)).find(row => row.host === agent && row.status === 'pending'));
      await api(site, `${servers}/${original.id}/approve`, { body: {} });
      await api(site, `${servers}/${original.id}/test`, { body: {} });
      nodeService = await api(site, '/v1/services', { body: { name: 'surviving-node-workload', type: 'docker', image: 'nginx:1.27-alpine', port: 80, serverId: original.id } });
      const runtime = await deployment(site, nodeService);
      workloadId = inner(node, ['inspect', runtime, '--format', '{{.Id}}']);
      enrolledAt = (await registry(site)).find(row => row.id === original.id).lastSeenAt;
      // Keep the node's daemon, running workload and agent state. Replace only
      // the agent process to point the surviving identity at the new panel.
      remove('container', agent);
      pass('Private DNS routes to the source and the approved agent runs a node-pinned workload');
    },
    fenced(file) {
      assert.equal(visit().address, sourceIP);
      assert.throws(() => visit(`/${file.route}`), /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ABORT_ERR|ETIMEDOUT/);
      pass('The stale DNS record cannot serve application traffic after the source is fenced');
    },
    async reEnroll(site) {
      const before = await registry(site);
      assert.equal(before.length, 1);
      assert.equal(before[0].id, original.id);
      const token = (await api(site, enrolment, { body: {} })).token;
      assert.ok(token && token !== sourceEnrolment, 'Enrolment token was not rotated');
      const body = { name: original.name, host: agent, port: 4600, token: '0'.repeat(64) };
      const announce = secret => request(site, `${servers}/announce`, { body, token: '', headers: { 'x-ninedeploy-enrolment': secret } });
      const oldCredential = await announce(sourceEnrolment);
      assert.equal(oldCredential.status, 401);
      assert.equal(oldCredential.data.error.code, 'enrolment_invalid');
      const wrongAgent = await announce(token);
      assert.equal(wrongAgent.status, 401);
      assert.match(wrongAgent.data.error.message, /token mismatch/);
      startAgent(site, token);
      const restored = await poll('Surviving agent re-announcement', async () => (await registry(site)).find(row => row.id === original.id && row.lastSeenAt > enrolledAt));
      const result = await api(site, `${servers}/${restored.id}/test`, { body: {} });
      assert.equal(result.status, 'online');
      const rows = await registry(site);
      assert.equal(rows.length, 1);
      assert.ok(rows[0].agent?.capabilities.includes('docker.mutations'));
      const placement = await api(site, `/v1/services/${nodeService.id}`);
      assert.equal(placement.serverId, original.id);
      assert.equal(inner(node, ['inspect', workloadId, '--format', '{{.State.Running}}']), 'true');
      saved.node = { serverId: restored.id, serviceId: placement.id, workloadPreserved: true, oldEnrolmentRejected: true, wrongIdentityRejected: true };
      pass('The surviving agent re-enrolled with its original ID and workload after the old enrolment secret and a mismatched identity were refused');
    },
    async stageIngress() {
      // Install only the Pebble API trust anchor into this disposable Traefik
      // image on the recovery daemon. The panel still owns router/ACME config.
      const setup = 'set -eu; dir=$(mktemp -d); cat >"$dir/pebble.pem"; cd "$dir"; printf "%s\\n" "FROM traefik:3" "COPY pebble.pem /tmp/pebble.pem" "RUN cat /tmp/pebble.pem >> /etc/ssl/certs/ca-certificates.crt && rm /tmp/pebble.pem" > Dockerfile; docker -H tcp://127.0.0.1:2375 build -q -t traefik:3 .';
      saved.traefikImage = docker(['exec', '-i', owned('container', target.daemon), 'sh', '-ec', setup], 120_000,
        readFileSync(join(tls, 'pebble-api.pem'), 'utf8')).split('\n').at(-1);
      assert.match(saved.traefikImage, /^sha256:[a-f0-9]{64}$/);
    },
    async verify(site, domainPath, volumes) {
      const start = Date.now();
      assert.equal(visit().address, sourceIP);
      setAddress(targetIP);
      const after = await poll('Changed DNS record', () => { const answer = visit(); return answer.address === targetIP && answer; });
      saved.targetDns = after;
      const settings = await api(site, '/v1/settings/acme-email', { method: 'PUT', body: { email: 'operator@example.test' } });
      assert.equal(settings.acmeEmail, 'operator@example.test');
      assert.equal((await api(site, domainPath, { method: 'PATCH', body: { ssl: true } })).ssl, true);
      const first = await poll('CA-verified HTTPS through cutover DNS', () => {
        const response = visit(`/${volumes[0].route}`, true);
        return response.status === 200 && response.body === volumes[0].value && response;
      }, 120_000);
      assert.match(first.fingerprint, /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
      assert.equal(first.names, `DNS:${host}`);
      for (const v of volumes) {
        const response = visit(`/${v.route}`, true);
        assert.deepEqual([response.address, response.status, response.body, response.fingerprint], [targetIP, 200, v.value, first.fingerprint]);
      }
      const redirect = visit(`/${volumes[0].route}`);
      assert.equal(redirect.status, 302);
      assert.equal(redirect.location, `https://${host}/${volumes[0].route}`);
      const validation = docker(['logs', owned('container', ca)]);
      assert.ok(validation.includes(`Attempting to validate w/ HTTP: http://${host}:80/.well-known/acme-challenge/`));
      assert.match(validation, /authz \S+ set VALID by completed challenge/);
      saved.certificate = { host, fingerprint: first.fingerprint, validation: 'http-01', verified: true, redirectStatus: redirect.status };
      saved.dnsToTlsMs = Date.now() - start;
      pass('Changed DNS points to the recovery host, Pebble validates HTTP-01, and trusted HTTPS serves both recovered files');
    },
  };
}
