// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone hosted acceptance is not a cached Turbo task.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The panel's own domain does not depend on the address its port is published on
 * (competitive roadmap A2, the follow-up its first proof found).
 *
 * On an isolated daemon (Docker-in-Docker) the panel image starts the way install.sh
 * runs it: the Docker socket mounted, a panel domain set, its data on a volume. One
 * difference is the point: its port is not published at all. The panel creates its
 * network and its Traefik as in production, joins the network under its alias at boot,
 * and its domain answers through Traefik, over HTTPS as every domain's router
 * is TLS-only. Nothing could reach it by the host address its router used to
 * take, because there is no such address.
 *
 * On a developer's machine pass --local-daemon as well. Only this run's own labelled
 * daemon, data volume and image archive are created there, and removed at the end.
 */
const hosted = process.env.GITHUB_ACTIONS === 'true';
if (hosted) {
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a GitHub-hosted runner');
  assert.equal(process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock', 'unix:///var/run/docker.sock', 'Use only the hosted runner daemon');
} else {
  assert.ok(process.argv.includes('--local-daemon'), 'Pass --local-daemon to run on this machine\'s daemon');
}
const image = process.argv.find(arg => arg.startsWith('--image='))?.slice(8);
assert.ok(image && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image), 'Pass --image=<candidate>');
const proof = resolve(process.argv.find(arg => arg.startsWith('--proof='))?.slice(8) ?? '.temp_files/panel-domain');
mkdirSync(proof, { recursive: true });

const suffix = randomBytes(8).toString('hex');
const daemon = `nd-panel-domain-${suffix}`, panel = `nd-panel-domain-panel-${suffix}`, data = `nd-panel-domain-data-${suffix}`;
const domain = `panel.${suffix}.test`;
const TRAEFIK = 'ninedeploy-traefik', NETWORK = 'ninedeploy', ALIAS = 'ninedeploy-panel';
const archive = resolve(proof, 'image.tar');
const cases = [], cleanup = [];
let failure;

/** A command that must succeed. */
const run = (args, options = {}) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 240_000, maxBuffer: 64 << 20, windowsHide: true, ...options });
  assert.equal(result.status, 0, `${args.slice(0, 5).join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
/** Docker inside the isolated daemon. */
const inner = args => run(['exec', daemon, 'docker', ...args]);
/** One HTTPS request to Traefik from inside the daemon, with the given Host. The router of a domain is TLS-only, as every router with a tls section is; the certificate is Traefik's own here (no ACME account), so it is not checked: the route is. */
const request = host => {
  const result = spawnSync('docker', ['exec', daemon, 'wget', '--no-check-certificate', '-S', '-q', '-O', '-', '-T', '5', '--header', `Host: ${host}`, 'https://127.0.0.1/health'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const status = Number(/HTTP\/[\d.]+ (\d{3})/.exec(result.stderr ?? '')?.[1] ?? 0);
  return { status, body: (result.stdout ?? '').trim() };
};
/** Wait for a probe to return something truthy. A probe may be async; the diagnosis runs only when the wait is over. */
const until = async (what, probe, ms, diagnose = () => '') => {
  for (const deadline = Date.now() + ms; ; await new Promise(r => setTimeout(r, 500))) {
    let answer;
    try { answer = await probe(); } catch { answer = null; }
    if (answer) return answer;
    if (Date.now() >= deadline) {
      const notes = diagnose();
      assert.fail(`${what} did not happen in ${Math.round(ms / 1000)} s${notes ? `:\n${notes}` : ''}`);
    }
  }
};

try {
  run(['run', '-d', '--name', daemon, '--label', `ninedeploy.proof=${suffix}`, '--privileged', '-e', 'DOCKER_TLS_CERTDIR=', 'docker:28-dind', 'dockerd', '--host=unix:///var/run/docker.sock', '--tls=false']);
  cleanup.push({ kind: 'container', id: daemon });
  await until('the isolated daemon', () => spawnSync('docker', ['exec', daemon, 'docker', 'info'], { encoding: 'utf8', timeout: 30_000 }).status === 0, 60_000);
  // The image travels by its reference: daemons with different image stores (a
  // developer's containerd store, the classic one in the isolated daemon) give one
  // image different IDs. The isolated daemon's own ID is what the panel then runs.
  run(['save', '-o', archive, image]);
  run(['cp', archive, `${daemon}:/root/panel-image.tar`]);
  rmSync(archive, { force: true });
  inner(['load', '-i', '/root/panel-image.tar']);
  const imageId = inner(['image', 'inspect', image, '--format', '{{.Id}}']);
  inner(['volume', 'create', '--label', `ninedeploy.proof=${suffix}`, data]);

  // The panel as install.sh runs it, with no published port.
  const socketGroup = run(['exec', daemon, 'stat', '-c', '%g', '/var/run/docker.sock']);
  inner(['run', '-d', '--name', panel, '--label', `ninedeploy.proof=${suffix}`, '-e', 'NODE_ENV=production',
    '-e', `NINEDEPLOY_JWT_SECRET=${randomBytes(32).toString('hex')}`, '-e', `NINEDEPLOY_DOMAIN=${domain}`, '-e', `NINEDEPLOY_PUBLIC_URL=http://${domain}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '--group-add', socketGroup, '-v', `${data}:/data`, imageId]);
  const healthy = "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))";
  await until('the panel', () => spawnSync('docker', ['exec', daemon, 'docker', 'exec', panel, 'node', '-e', healthy], { encoding: 'utf8', timeout: 30_000 }).status === 0, 120_000,
    () => { try { return inner(['logs', '--tail', '40', panel]); } catch { return ''; } });

  const info = JSON.parse(inner(['inspect', panel]))[0];
  assert.equal(info.NetworkSettings.Ports['3000/tcp'] ?? null, null, `the panel port is published: ${JSON.stringify(info.NetworkSettings.Ports)}`);
  assert.deepEqual(info.HostConfig.PortBindings ?? {}, {});
  cases.push({ name: 'panel-port-not-published', passed: true });

  const networks = info.NetworkSettings.Networks;
  assert.ok(networks[NETWORK], `the panel is not on ${NETWORK}: ${Object.keys(networks).join(', ')}`);
  assert.ok(networks[NETWORK].Aliases.includes(ALIAS), `no ${ALIAS} alias: ${JSON.stringify(networks[NETWORK].Aliases)}`);
  cases.push({ name: 'panel-joined-the-proxy-network-under-its-alias', passed: true, aliases: networks[NETWORK].Aliases });

  const routes = inner(['exec', TRAEFIK, 'cat', '/etc/traefik/dynamic/ninedeploy.yml']);
  const service = /svc_ninedeploy_panel:\n\s+loadBalancer:\n\s+servers:\n\s+- url: "([^"]+)"/.exec(routes);
  assert.equal(service?.[1], `http://${ALIAS}:3000`, `the panel service of Traefik:\n${routes.slice(0, 400)}`);
  cases.push({ name: 'router-of-the-panel-domain-takes-the-alias', passed: true, url: service[1] });

  // Kept for the diagnosis below: what Traefik answered last, and from where it was asked.
  let last = { status: 0, body: '' };
  const viaTraefik = async () => { last = request(domain); return last.status === 200 ? last : null; };
  const say = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true }); return `${(r.stdout ?? '').trim()} ${(r.stderr ?? '').trim()}`.trim(); };
  const diagnose = () => [
    `Traefik answered the domain: HTTP ${last.status || 'nothing'} ${last.body.slice(0, 200)}`,
    `from Traefik to the alias: ${say(['exec', daemon, 'docker', 'exec', TRAEFIK, 'wget', '-q', '-O', '-', '-T', '3', `http://${ALIAS}:3000/health`])}`,
    `on the proxy network: ${say(['exec', daemon, 'docker', 'network', 'inspect', NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'])}`,
    `Traefik's log:\n${say(['exec', daemon, 'docker', 'logs', '--tail', '25', TRAEFIK])}`,
  ].join('\n');
  const answer = await until('the panel behind its domain', viaTraefik, 60_000, diagnose);
  assert.match(answer.body, /"ok"/i);
  cases.push({ name: 'domain-answers-through-traefik', passed: true, status: answer.status });

  // The address the router took before this change has nothing behind it on this install.
  const old = spawnSync('docker', ['exec', daemon, 'docker', 'exec', TRAEFIK, 'wget', '-q', '-O', '/dev/null', '-T', '3', 'http://host.docker.internal:3000/health'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(old.status, 0, 'the host address answered: the port is published after all');
  cases.push({ name: 'host-address-has-nothing-behind-it', passed: true });

  const other = request(`other.${suffix}.test`);
  assert.equal(other.status, 404, `another hostname was served: ${other.status} ${other.body.slice(0, 80)}`);
  cases.push({ name: 'another-hostname-is-not-the-panel', passed: true, status: other.status });
} catch (error) { failure = String(error); process.exitCode = 1; }
finally {
  // A failed local run can leave its daemon for a look (--keep; never on a hosted runner).
  const keep = !hosted && process.argv.includes('--keep') && failure;
  if (keep) console.error(`kept for a look: docker exec ${daemon} docker ps`);
  for (const entry of keep ? [] : cleanup.reverse()) {
    try {
      const label = run(['inspect', entry.id, '--format', '{{index .Config.Labels "ninedeploy.proof"}}']);
      assert.equal(label, suffix);
      run(['rm', '-fv', entry.id]);
      entry.removed = true;
    } catch (error) { failure ??= String(error); process.exitCode = 1; entry.removed = false; }
  }
  rmSync(archive, { force: true });
  const result = { image, source: process.env.GITHUB_SHA, realDocker: true, cases, cleanup, accepted: !failure, ...(failure ? { failure } : {}) };
  writeFileSync(resolve(proof, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
