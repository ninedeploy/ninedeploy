import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';

const directory = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const roots = ['letsencrypt-stg-root-x1.pem', 'letsencrypt-stg-root-x2.pem', 'gen-y/root-ye.pem', 'gen-y/root-yr.pem'];

export function stagingInputs(env) {
  const { N05_DNS_ZONE: zone, N05_DNS_SUFFIX: suffix, CLOUDFLARE_DNS_API_TOKEN: token } = env;
  const isDnsName = value => typeof value === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
  assert.ok(isDnsName(zone) && isDnsName(suffix) && (suffix === zone || suffix.endsWith(`.${zone}`)),
    'Set N05_DNS_ZONE and N05_DNS_SUFFIX to the authorized Cloudflare zone and test suffix');
  assert.ok(token, 'Set CLOUDFLARE_DNS_API_TOKEN using a zone-scoped token');
  return { zone, suffix, token };
}

export async function prepareStaging(ctx, source, target, input) {
  const { docker, owned, exec, runContainer, prefix, network, proof, host, api, poll, pass, report } = ctx;
  const visitor = `${prefix}-external-visitor`;
  const marker = `NineDeploy recovery drill ${prefix}`;
  const challenge = `_acme-challenge.${host}`;
  const result = { provider: 'Cloudflare', zone: input.zone, host, directory, dnsCleanup: false };
  report.externalCutover = result;
  assert.equal(host, `${prefix}.${input.suffix}`);

  async function call(path, method = 'GET', body) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method, signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok && data.success, `Cloudflare ${method} HTTP ${response.status}, codes ${(data.errors ?? []).map(item => item.code).join(',')}`);
    return data.result;
  }
  const zones = await call(`/zones?${new URLSearchParams({ name: input.zone, status: 'active' })}`);
  assert.equal(zones.length, 1, 'Expected exactly one authorized active Cloudflare zone');
  const zone = zones[0];
  assert.equal(zone.name, input.zone);
  assert.match(zone.id, /^[a-f0-9]{32}$/);
  const records = `/zones/${zone.id}/dns_records`;
  const list = async name => (await call(`${records}?${new URLSearchParams({ 'name.exact': name })}`)).filter(record => record.name === name);
  const ownedRecord = record => record.type === 'A' && record.name === host && record.comment === marker;
  assert.deepEqual(await list(host), [], 'The randomized test hostname already has direct records');
  assert.deepEqual(await list(challenge), [], 'The randomized ACME challenge name already has direct records');
  let recordId;
  let started = false;
  let challengeStarted = false;

  const recursive = new Resolver({ timeout: 2500, tries: 2 });
  recursive.setServers(['1.1.1.1']);
  const authorities = await Promise.all(zone.name_servers.map(async name => {
    const [address] = await recursive.resolve4(name);
    const resolver = new Resolver({ timeout: 2500, tries: 2 });
    resolver.setServers([address]);
    return { name, resolver };
  }));
  assert.ok(authorities.length > 0, 'Zone has no authoritative IPv4 nameservers');

  const ip = site => {
    const address = docker(['inspect', owned('container', site.daemon), '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']);
    assert.ok(isIPv4(address), 'A private recovery-daemon IPv4 address is required');
    const [a, b] = address.split('.').map(Number);
    assert.ok(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168), 'The test must use private Docker bridge addresses');
    return address;
  };
  const oldAddress = ip(source);
  const newAddress = ip(target);
  assert.notEqual(oldAddress, newAddress);

  const pem = await Promise.all(roots.map(async file => {
    const response = await fetch(`https://letsencrypt.org/certs/staging/${file}`, { signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `Could not load the official staging root ${file}`);
    const cert = await response.text();
    assert.match(cert, /^-----BEGIN CERTIFICATE-----/);
    return cert.trim();
  }));
  const trust = join(proof, 'staging-root-bundle.pem');
  writeFileSync(trust, `${pem.join('\n')}\n`);
  runContainer(visitor, ['--network', network, '--no-healthcheck', '--entrypoint', 'sleep',
    '--mount', `type=bind,src=${trust},dst=/staging-root-bundle.pem,readonly`, report.imageId, 'infinity']);

  const visit = (address, file, secure = false) => exec(visitor, ['curl', '-fsS', '--noproxy', '*', '--max-time', '7',
    '--resolve', `${host}:${secure ? 443 : 80}:${address}`, ...(secure ? ['--cacert', '/staging-root-bundle.pem'] : []),
    `${secure ? 'https' : 'http'}://${host}/${file.route}`]);

  async function convergence(expected) {
    return poll('Authoritative and recursive DNS agreement', async () => {
      const ns = [...authorities, { name: '1.1.1.1', resolver: recursive }];
      const answers = await Promise.all(ns.map(async ({ name, resolver }) => ({ name, answers: await resolver.resolve4(host, { ttl: true }) })));
      return answers.every(({ answers: records }) => records.length === 1 && records[0].address === expected) && answers;
    }, 210_000);
  }
  return {
    directory,
    async beforeBackup(_panel, file) {
      started = true;
      const created = await call(records, 'POST', { type: 'A', name: host, content: oldAddress, proxied: false, ttl: 60, comment: marker });
      assert.ok(ownedRecord(created));
      assert.match(created.id, /^[a-f0-9]{32}$/);
      recordId = created.id;
      result.beforeDns = await convergence(oldAddress);
      assert.equal(visit(result.beforeDns.at(-1).answers[0].address, file), file.value);
      pass('The authoritative Cloudflare record and public recursive DNS led the isolated visitor to the source');
    },
    fenced(file) {
      assert.throws(() => visit(oldAddress, file), /curl: \((7|28)\)/);
      pass('The source address stopped serving the application before the Cloudflare cutover');
    },
    async verify(panel, domainPath, volumes) {
      const start = Date.now();
      const [current] = await list(host);
      assert.ok(current && current.id === recordId && ownedRecord(current), 'The DNS record is no longer owned by the drill');
      const changed = await call(`${records}/${recordId}`, 'PATCH', { content: newAddress });
      assert.ok(ownedRecord(changed) && changed.content === newAddress);
      result.afterDns = await convergence(newAddress);
      const address = result.afterDns.at(-1).answers[0].address;
      await api(panel, '/v1/settings/dns', { method: 'PUT', body: { provider: 'cloudflare', token: input.token, wildcardApex: '' } });
      await api(panel, '/v1/settings/acme-email', { method: 'PUT', body: { email: `postmaster@${input.zone}` } });
      challengeStarted = true;
      assert.equal((await api(panel, domainPath, { method: 'PATCH', body: { ssl: true } })).ssl, true);
      for (const file of volumes) await poll('Staging TLS with verified hostname and restored payload', () => visit(address, file, true) === file.value, 240_000);
      result.certificate = { host, validation: 'dns-01', verified: true };
      result.dnsToTlsMs = Date.now() - start;
      pass('Cloudflare DNS cut over and a verified Let’s Encrypt staging DNS-01 certificate served both restored files');
    },
    async cleanup() {
      if (!started) return;
      const dnsRecords = (await list(host)).filter(ownedRecord);
      const challengeRecords = challengeStarted ? (await list(challenge)).filter(record => record.type === 'TXT') : [];
      for (const record of [...dnsRecords, ...challengeRecords]) {
        assert.match(record.id, /^[a-f0-9]{32}$/);
        await call(`${records}/${record.id}`, 'DELETE');
      }
      result.dnsCleanup = (await list(host)).filter(ownedRecord).length === 0 && (await list(challenge)).every(record => record.type !== 'TXT');
      assert.ok(result.dnsCleanup, 'Drill DNS records remain in Cloudflare');
    },
  };
}
