#!/usr/bin/env node
// Multi-node smoke (0.15.x series, design T9): a panel and a second host
// running the node agent, on throwaway containers. It proves on real images
// what the unit tests can only mock: enrolment, deploys through the agent,
// builds and private clones on the node, build placement with image transfer,
// node volumes and databases, Docker Swarm, and the capability refusals.
//
// Modes:
//   (a) fresh:    node scripts/smoke-multinode.mjs --image=<candidate image> [--version=X.Y.Z]
//       The candidate panel with a candidate agent. Asserts:
//         - enrolment: POST /v1/servers, the agent answers /test, GET /v1/servers
//           reports its version and every feature except Swarm (opt-in);
//         - an image service deploys to the node and is routed by the node's proxy;
//         - a Dockerfile build on the node clones a private repository with a PAT:
//           refused while the source does not allow nodes (400), step-up on the
//           toggle (403 for a wrong password), then green, and the PAT is nowhere
//           under the agent's data directory; ssh is in the image (D3);
//         - build_on=panel ships the image to the node (an image_transfers row,
//           completed, with bytes and sha256; the node holds ninedeploy/<slug>:<sha7>-b<id>);
//         - build_on=server builds a panel service on the node (build-server role)
//           and ships it back to the panel;
//         - a node volume: create (409 when it exists), file manager refused (422),
//           attach, back up over the stream channel, restore refused while in use
//           (409), restore after a stop, the file is back;
//         - a node database (§5.9): created on the node only, Studio / PgBouncer /
//           public access 422 remote_database, client terminal 422, a shell
//           terminal runs psql, attached to the node service (env + name
//           resolution), a panel attachment 409, backup → drop → restore, a
//           plain-SQL import, and DELETE /v1/servers/:id?force=true 409;
//         - D4: a panel-host database attached to a panel service resolves by name;
//         - Swarm (§7.9): join refused until the agent opts in (422), init (409 on a
//           second init), enable, a 2-replica service routed by Traefik 20/20, the
//           agent restarted with NINEDEPLOY_AGENT_SWARM_MANAGER, join, leave;
//         - every journal migration (0072 included) recorded once.
//   (b) upgrade:  --from=v0.15.1 --to=<candidate tag> --to-image=<local image>
//       The FROM panel enrols a FROM agent and deploys an image service to the
//       node; the TO panel boots on the same data; with the FROM agent the image
//       service redeploys and every newer feature answers 422 node_agent_outdated
//       (the agent is asked nothing but agent.ping, nothing is written); then the
//       agent restarts from the TO image and (a)'s feature checks run.
//   (c) rollback: --from=<candidate tag> --from-image=<local image> --to=v0.15.1
//       The candidate panel and agent seed every feature; then v0.15.1 boots on
//       the same data while the candidate agent keeps running, and docs/ROLLBACK.md's
//       "0.15.x multi-node rollback" holds: 0072 stays recorded, the node image
//       service redeploys, the PAT / build-on-panel / volume services are refused
//       and their containers keep running, the node database is refused and
//       nothing appears on the panel host while it keeps its data on the node,
//       a candidate backup still downloads, the Swarm route keeps answering, the
//       next deploy runs it as a container, and the runbook commands work.
//
// Flags: --with-builds adds Nixpacks and Railpack builds (heavy: large base
// images and the Railpack frontend): Nixpacks on the node; Railpack refused
// with the fix on the node, whose DinD uses Docker's classic image store
// (Railpack's frontend needs the containerd image store); then a second node
// DinD (nd-mn-node2-<hex>, its own agent) with the containerd image store,
// where Railpack builds. --no-swarm skips Swarm, which
// needs IPsec (xfrm) in the DinD kernel for encrypted overlays; Docker Desktop
// may lack it, and init then answers swarm_overlay_unavailable — the smoke fails
// and says so rather than skipping. --panel-port=<n> (default 4643).
//
// Topology (all names nd-mn-<role>-<hex>; nothing else is touched, in
// particular not the host's ninedeploy-traefik):
//   - network nd-mn-net-<hex>;
//   - the panel's DinD (docker:28-dind, TCP 2375) with the panel data volume at
//     /data, and the panel container with DOCKER_HOST=tcp://<dind>:2375 and
//     NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1, as smoke-upgrade.mjs runs it;
//   - the node's DinD with the agent's data volume at /var/lib/ninedeploy-agent;
//   - the agent container from the given image, NINEDEPLOY_AGENT=1, the token
//     hash from POST /v1/servers, the same volume at the same path (so the bind
//     mounts it hands the node's daemon resolve), and --network container:<node
//     DinD>: agent, node daemon and node proxy share ONE address, as on a real
//     host. That address is the server's host, which Swarm's join check compares
//     with the address the worker reaches the manager from. Its DOCKER_HOST is
//     therefore tcp://127.0.0.1:2375, the node DinD's own daemon;
//   - a dumb-HTTP Git server (nginx with basic auth) holding the test repositories.
// Cleanup (finally) removes every container (with its anonymous volumes),
// volume and network the run created.
//
// Node 22+ (global fetch and WebSocket for the database terminal).

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── arguments ───────────────────────────────────────────────────────────────

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const repoVersion = /export const VERSION = '([^']*)';/.exec(read('../apps/server/src/version.ts'))?.[1] ?? null;
const capsSrc = read('../apps/server/src/lib/agentCapabilities.ts');
const constVersion = (name) => {
  const v = new RegExp(`export const ${name} = '([^']+)'`).exec(capsSrc)?.[1];
  if (!v) throw new Error(`could not read ${name} from apps/server/src/lib/agentCapabilities.ts`);
  return v;
};
/** The first agent release of each multi-node capability (lib/agentCapabilities.ts). */
const AGENT_MULTI_NODE = constVersion('AGENT_MULTI_NODE_VERSION');
const AGENT_DB_MANAGE = constVersion('AGENT_DB_MANAGE_VERSION');
const AGENT_SWARM = constVersion('AGENT_SWARM_VERSION');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => process.argv.includes(`--${name}`);
const IMAGE = arg('image');
const FROM = arg('from');
const TO = arg('to');
const FROM_IMAGE = arg('from-image');
const TO_IMAGE = arg('to-image');
const WITH_BUILDS = flag('with-builds');
const NO_SWARM = flag('no-swarm');
const PANEL_PORT = Number(arg('panel-port') ?? 4643);

const semver = (tag) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '') ?? []).slice(1).map(Number);
const olderThan = (tag, min) => {
  const [a, b, c] = semver(min);
  const [x = 0, y = 0, z = 0] = semver(tag);
  return x !== a ? x < a : y !== b ? y < b : z < c;
};
const bare = (tag) => tag.replace(/^v/, '');
const USAGE =
  'usage: node scripts/smoke-multinode.mjs --image=<candidate> [--version=X.Y.Z]\n' +
  '   or: --from=v0.15.1 --to=<candidate tag> --to-image=<local image>          (upgrade)\n' +
  '   or: --from=<candidate tag> --from-image=<local image> --to=v0.15.1        (rollback rehearsal)\n' +
  '   plus: [--with-builds] [--no-swarm] [--panel-port=4643]';

let MODE;
if (IMAGE && !FROM && !TO) MODE = 'fresh';
else if (!IMAGE && FROM && TO && semver(FROM).length === 3 && semver(TO).length === 3) MODE = olderThan(FROM, TO) ? 'upgrade' : 'rollback';
else {
  console.error(USAGE);
  process.exit(2);
}
const CANDIDATE_VERSION = MODE === 'fresh' ? (arg('version') ?? repoVersion) : MODE === 'upgrade' ? bare(TO) : bare(FROM);
if (!CANDIDATE_VERSION) {
  console.error('could not derive the candidate version from apps/server/src/version.ts — pass --version=X.Y.Z');
  process.exit(2);
}
if (MODE === 'upgrade' && olderThan(FROM, '0.15.0')) {
  console.error(`the upgrade run needs a FROM whose node agent seals and opens terminals (v0.15.0 or later), got ${FROM}`);
  process.exit(2);
}
if (MODE === 'upgrade' && olderThan(TO, AGENT_MULTI_NODE)) {
  console.error(`the upgrade run needs a TO with multi-node features (v${AGENT_MULTI_NODE} or later), got ${TO}`);
  process.exit(2);
}
if (MODE === 'rollback' && (olderThan(FROM, AGENT_MULTI_NODE) || !olderThan(TO, AGENT_MULTI_NODE))) {
  console.error(`the rollback rehearsal goes from a multi-node release (v${AGENT_MULTI_NODE} or later) to one before it (v0.15.1 or earlier); got ${FROM} → ${TO}`);
  process.exit(2);
}

const image = (tag) => {
  if (MODE === 'fresh') return IMAGE;
  if (tag === TO && TO_IMAGE) return TO_IMAGE;
  if (tag === FROM && FROM_IMAGE) return FROM_IMAGE;
  return `ghcr.io/ninedeploy/ninedeploy:${tag}`;
};
/** The image the candidate side (panel and agent) runs. */
const CANDIDATE_IMAGE = MODE === 'fresh' ? IMAGE : MODE === 'upgrade' ? image(TO) : image(FROM);
/** Does the candidate have a feature first shipped in `min`? */
const candidateHas = (min) => !olderThan(CANDIDATE_VERSION, min);

// ── names ───────────────────────────────────────────────────────────────────

const suffix = randomBytes(4).toString('hex');
const NET = `nd-mn-net-${suffix}`;
const DIND = `nd-mn-dind-${suffix}`;
const PANEL = `nd-mn-panel-${suffix}`;
const NODE = `nd-mn-node-${suffix}`;
const AGENT = `nd-mn-agent-${suffix}`;
const GIT = `nd-mn-git-${suffix}`;
const GIT_INIT = `nd-mn-gitinit-${suffix}`;
const DATA = `nd-mn-data-${suffix}`;
const AGENT_DATA = `nd-mn-agentdata-${suffix}`;
const GIT_DATA = `nd-mn-gitdata-${suffix}`;
// --with-builds: a second node whose Docker uses the containerd image store (Railpack's frontend needs it).
const NODE2 = `nd-mn-node2-${suffix}`;
const AGENT2 = `nd-mn-agent2-${suffix}`;
const AGENT2_DATA = `nd-mn-agent2data-${suffix}`;
const CONTAINERS = [AGENT, AGENT2, PANEL, GIT, GIT_INIT, NODE, NODE2, DIND];
const VOLUMES = [DATA, AGENT_DATA, AGENT2_DATA, GIT_DATA];
/** The first node and its agent; --with-builds adds a second (`node2`). */
const NODE_1 = { node: NODE, agent: AGENT, data: AGENT_DATA };
const NODE_2 = { node: NODE2, agent: AGENT2, data: AGENT2_DATA };
/** Every name the run creates, and nothing else, may be removed. */
const owned = (name) => name.startsWith('nd-mn-') && name.endsWith(suffix);

const AGENT_HOME = '/var/lib/ninedeploy-agent';
const AGENT_PORT = 4600;
const DIND_IMAGE = 'docker:28-dind';
const APP_IMAGE = 'nginx:1.27-alpine';
const JWT = randomBytes(32).toString('hex');
const MASTER = randomBytes(32).toString('hex');
const PAT = `ndpat${randomBytes(16).toString('hex')}`;
const PAT_USER = 'x-access-token'; // lib/nodeGitCredential.ts staticTokenUsername: every source type but gitlab
const MARKER = `nd-mn-dockerfile-${suffix}`;
const BASE = `http://127.0.0.1:${PANEL_PORT}`;
const journal = JSON.parse(read('../packages/db/src/migrations/meta/_journal.json'));
const MIGRATION_0072 = journal.entries.find((e) => e.tag.startsWith('0072_')) ?? null;

// ── helpers (the smoke-upgrade.mjs conventions) ─────────────────────────────

const docker = (args, opts = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 300_000, maxBuffer: 32 << 20 });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`docker ${args.join(' ')} -> ${r.status}: ${(r.stderr || r.error?.message || '').slice(0, 400)}`);
  return (r.stdout ?? '').trim();
};
/** A command against a DinD daemon: exit status, stdout, and stdout+stderr. */
const daemonRun = (host, args, timeout = 180_000) => {
  const r = spawnSync('docker', ['exec', host, 'docker', '-H', 'tcp://127.0.0.1:2375', ...args], { encoding: 'utf8', timeout, maxBuffer: 32 << 20 });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), all: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
};
const panelDaemon = (args, timeout) => daemonRun(DIND, args, timeout);
const nodeDaemon = (args, timeout) => daemonRun(NODE, args, timeout);
const node2Daemon = (args, timeout) => daemonRun(NODE2, args, timeout);
/** A command inside a container on the HOST daemon (the panel, the agent). */
const inContainer = (name, args, timeout = 120_000) => {
  const r = spawnSync('docker', ['exec', name, ...args], { encoding: 'utf8', timeout, maxBuffer: 32 << 20 });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), all: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exitCode = 1; throw new Error(msg); };
const step = (s) => console.log(`  ${s}`);
const section = (s) => console.log(`\n── ${s}`);
const errorCode = (r) => r.json?.error?.code ?? r.json?.code ?? null;
const short = (r) => `${r.status} ${r.text.slice(0, 400)}`;
const served = (code) => /^[23]\d\d$/.test(code);

/** The operator session; `api` signs in again once when the access token expired (15 min by default). */
const session = { email: `mn-${suffix}@nd.local`, password: `Multinode-${suffix}-0123!`, token: null };

async function rawApi(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text };
}
async function login() {
  const r = await rawApi('/v1/auth/login', { method: 'POST', body: { email: session.email, password: session.password } });
  if (r.status !== 200 || !r.json?.tokens?.accessToken) fail(`operator login failed: ${short(r)}`);
  session.token = r.json.tokens.accessToken;
}
/** An authenticated call as the operator (`anon: true` for none). */
async function api(p, { method = 'GET', body, anon = false } = {}) {
  if (anon) return rawApi(p, { method, body });
  let r = await rawApi(p, { method, body, token: session.token });
  if (r.status === 401 && session.token) {
    await login();
    r = await rawApi(p, { method, body, token: session.token });
  }
  return r;
}
/** Retry `fn` until it returns a truthy value (or the deadline passes); returns the last value. */
async function until(fn, { ms = 60_000, every = 1000 } = {}) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) return last;
    await sleep(every);
  }
}
const waitFor = (pred, ms) => until(() => pred(), { ms, every: 100 });

function startPanel(tag) {
  docker(['rm', '-f', '-v', PANEL], { allowFail: true });
  docker(['run', '-d', '--name', PANEL, '--network', NET, '-p', `127.0.0.1:${PANEL_PORT}:3000`,
    '-v', `${DATA}:/data`,
    '-e', `NINEDEPLOY_JWT_SECRET=${JWT}`,
    '-e', `NINEDEPLOY_MASTER_KEY=${MASTER}`,
    '-e', `DOCKER_HOST=tcp://${DIND}:2375`,
    // The Git server and the node are on the smoke's private network.
    '-e', 'NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1',
    image(tag)]);
}

async function waitHealthy(wantVersion) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await rawApi('/health');
      if (r.status === 200 && r.json?.status === 'ok') {
        if (r.json.version !== wantVersion) fail(`/health reports ${r.json.version}, expected ${wantVersion}`);
        return r.json;
      }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  console.log(docker(['logs', '--tail', '40', PANEL], { allowFail: true }));
  return fail(`panel ${wantVersion} never answered /health ok`);
}

/** The address of a container on the smoke network. */
function ipOn(container) {
  const nets = JSON.parse(docker(['inspect', container, '--format', '{{json .NetworkSettings.Networks}}']) || '{}');
  const ip = nets[NET]?.IPAddress;
  if (!ip) fail(`${container} has no address on ${NET}: ${JSON.stringify(nets).slice(0, 200)}`);
  return ip;
}

function pullOrFail(ref, why) {
  const r = spawnSync('docker', ['pull', ref], { encoding: 'utf8', timeout: 900_000, maxBuffer: 8 << 20 });
  if (r.status === 0) return;
  // A registry hiccup must not fail the smoke when the image is already here.
  if (spawnSync('docker', ['image', 'inspect', ref], { encoding: 'utf8' }).status === 0) {
    step(`${ref}: pull failed, using the local copy (${(r.stderr || r.error?.message || '').trim().split(/\r?\n/).pop()})`);
    return;
  }
  fail(`${ref} cannot be pulled (${(r.stderr || r.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ')}) — ${why}`);
}

async function startDind(name, volumeMount, { containerdStore = false } = {}) {
  // The containerd image store is a daemon.json feature; the image's entrypoint then starts dockerd as usual.
  const cmd = containerdStore
    ? ['sh', '-c', `mkdir -p /etc/docker && printf '%s' '{"features":{"containerd-snapshotter":true}}' > /etc/docker/daemon.json && exec dockerd-entrypoint.sh dockerd --host=tcp://0.0.0.0:2375`]
    : ['dockerd', '--host=tcp://0.0.0.0:2375'];
  docker(['run', '-d', '--name', name, '--network', NET, '--privileged', '-v', volumeMount, DIND_IMAGE, ...cmd]);
  const ok = await until(() => daemonRun(name, ['version', '--format', '{{.Server.Version}}']).stdout, { ms: 60_000 });
  if (!ok) fail(`the DinD daemon ${name} never became reachable: ${docker(['logs', '--tail', '20', name], { allowFail: true })}`);
}

// ── deploys ─────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['running', 'failed', 'cancelled', 'superseded']);

/** The tail of a deployment's build log (best effort, for failure messages). */
async function deployLogTail(serviceId, depId, n = 40) {
  try {
    const r = await fetch(`${BASE}/v1/services/${serviceId}/deploys/${depId}/logs/download`, { headers: { authorization: `Bearer ${session.token}` } });
    if (!r.ok) return `(build log unavailable: ${r.status})`;
    return (await r.text()).trim().split(/\r?\n/).slice(-n).join('\n');
  } catch (err) {
    return `(build log unavailable: ${err?.message ?? err})`;
  }
}

/** Wait for one deployment to settle; fail with its log tail unless it ends as `expect`. */
async function waitDeployment(serviceId, depId, label, { expect = 'running', ms = 30 * 60_000 } = {}) {
  let row = null;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await api(`/v1/services/${serviceId}/deploys`);
    const list = Array.isArray(r.json) ? r.json : (r.json?.deploys ?? []);
    row = list.find((d) => d.id === depId) ?? row;
    if (row && TERMINAL_STATUSES.has(row.status)) break;
    await sleep(2000);
  }
  if (!row || !TERMINAL_STATUSES.has(row.status)) fail(`${label}: deployment #${depId} never finished (last status ${row?.status ?? 'unknown'})\n${await deployLogTail(serviceId, depId)}`);
  if (expect && row.status !== expect) fail(`${label}: deployment #${depId} ended as '${row.status}' (wanted ${expect})\n--- build log tail ---\n${await deployLogTail(serviceId, depId)}`);
  return row;
}

/** POST /deploys and wait for the deployment to run. */
async function deploy(serviceId, label, opts) {
  const r = await api(`/v1/services/${serviceId}/deploys`, { method: 'POST', body: {} });
  if (r.status !== 200 || typeof r.json?.deploymentId !== 'number') fail(`${label}: POST /v1/services/${serviceId}/deploys answered ${short(r)}`);
  return waitDeployment(serviceId, r.json.deploymentId, label, opts);
}

/** A deploy the panel must refuse at queue time: the status, the code, and no deployment row. */
async function refusedDeploy(serviceId, label, { status, code, match } = {}) {
  const before = (await api(`/v1/services/${serviceId}/deploys`)).json?.length ?? 0;
  const r = await api(`/v1/services/${serviceId}/deploys`, { method: 'POST', body: {} });
  if ((status !== undefined ? r.status !== status : r.status < 400 || r.status >= 500) || (code && errorCode(r) !== code)) {
    fail(`${label}: the deploy answered ${short(r)} (wanted ${status ?? '4xx'}${code ? ` ${code}` : ''})`);
  }
  if (match && !match.test(r.json?.error?.message ?? r.json?.message ?? r.text)) fail(`${label}: the refusal does not say ${match}: ${r.text.slice(0, 400)}`);
  const after = (await api(`/v1/services/${serviceId}/deploys`)).json?.length ?? 0;
  if (after !== before) fail(`${label}: a refused deploy left a deployment row (${before} → ${after})`);
  return r;
}

async function createService(body, label) {
  const r = await api('/v1/services', { method: 'POST', body });
  const id = r.json?.id ?? r.json?.service?.id;
  if (!id) fail(`${label}: service create answered ${short(r)}`);
  return id;
}
const serviceRow = async (id) => {
  const r = await api(`/v1/services/${id}`);
  if (r.status !== 200) fail(`GET /v1/services/${id} answered ${short(r)}`);
  return r.json;
};

async function addDomain(serviceId, hostname) {
  const r = await api(`/v1/services/${serviceId}/domains`, { method: 'POST', body: { hostname } });
  if (r.status !== 200 && r.status !== 201) fail(`domain ${hostname} on service #${serviceId} answered ${short(r)}`);
}

/** What `http://127.0.0.1:<port>/` answers inside a container (busybox wget, or node's fetch). */
function containerHttp(daemon, container, port, { node = false } = {}) {
  const cmd = node
    ? ['exec', container, 'node', '-e', `fetch('http://127.0.0.1:${port}/').then(r=>r.text()).then(t=>console.log(t),e=>{console.error(e.message);process.exit(1)})`]
    : ['exec', container, 'wget', '-qO-', `http://127.0.0.1:${port}/`];
  return daemon(cmd);
}
const containerRunning = (daemon, name) => daemon(['inspect', '-f', '{{.State.Running}}', name]).stdout === 'true';

/** HTTP codes of `n` requests for `hostname`, sent from the panel container to `host`:80 (curl does not follow redirects). */
function routeStatuses(host, hostname, n) {
  const r = inContainer(PANEL, ['sh', '-c', `for i in $(seq 1 ${n}); do curl -s -o /dev/null -m 5 -w '%{http_code}\\n' -H 'Host: ${hostname}' http://${host}:80/; done`]);
  return r.stdout.split(/\s+/).filter(Boolean);
}
async function routeServes(host, hostname, label, { ms = 60_000 } = {}) {
  let codes = [];
  const ok = await until(() => {
    codes = routeStatuses(host, hostname, 1);
    return served(codes[0] ?? '');
  }, { ms, every: 2000 });
  if (!ok) fail(`${label}: ${hostname} through ${host}:80 answered ${codes.join(',') || 'nothing'} for ${ms / 1000}s`);
  return codes[0];
}

// ── the agent ───────────────────────────────────────────────────────────────

/** (Re)start the node agent from `ref` with the token hash, the shared data dir and any extra env. */
function startAgent(ref, tokenSha256, extraEnv = {}, host = NODE_1) {
  docker(['rm', '-f', host.agent], { allowFail: true });
  const env = {
    NINEDEPLOY_AGENT: '1',
    NINEDEPLOY_AGENT_PORT: String(AGENT_PORT),
    NINEDEPLOY_AGENT_TOKEN: tokenSha256,
    // The agent shares the node DinD's network namespace (see the header).
    DOCKER_HOST: 'tcp://127.0.0.1:2375',
    ...extraEnv,
  };
  docker(['run', '-d', '--name', host.agent, '--network', `container:${host.node}`, '--user', '0:0',
    '-v', `${host.data}:${AGENT_HOME}`, '-w', AGENT_HOME,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ref, 'node', '/app/apps/server/dist/agent.js']);
}

/** POST /v1/servers/:id/test until the agent answers (it marks the node online and refreshes the capability cache). */
async function waitAgent(serverId, label, agentName = AGENT) {
  let last = null;
  const ok = await until(async () => {
    last = await api(`/v1/servers/${serverId}/test`, { method: 'POST' });
    return last.status === 200;
  }, { ms: 90_000, every: 2000 });
  if (!ok) fail(`${label}: POST /v1/servers/${serverId}/test never answered 200 (last ${short(last)})\n--- agent log ---\n${docker(['logs', '--tail', '30', agentName], { allowFail: true })}`);
}

const serverEntry = async (serverId) => {
  const r = await api('/v1/servers');
  const row = Array.isArray(r.json) ? r.json.find((s) => s.id === serverId) : null;
  if (!row) fail(`GET /v1/servers has no server #${serverId}: ${short(r)}`);
  return row;
};

// ── terminals (protocol v1, as smoke-upgrade.mjs drives it) ─────────────────

const TERMINAL_PROTOCOL = 'ninedeploy.terminal.v1';
const TERMINAL_TICKET_PREFIX = 'ninedeploy.ticket.';

function terminalAttach(created) {
  if (typeof WebSocket !== 'function') fail('the database terminal check needs Node 22+ (global WebSocket)');
  const ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}${created.attachPath}`, [TERMINAL_PROTOCOL, `${TERMINAL_TICKET_PREFIX}${created.ticket}`]);
  ws.binaryType = 'arraybuffer';
  const state = { out: '', ready: null, exit: null, close: null, notices: [] };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { /* not ours */ }
      if (msg?.t === 'ready') state.ready = msg;
      else if (msg?.t === 'exit') state.exit = msg;
      else if (msg?.t === 'notice') state.notices.push(msg.message);
    } else {
      state.out += Buffer.from(ev.data).toString('utf8');
    }
  };
  ws.onclose = (ev) => { state.close = { code: ev.code, reason: ev.reason }; };
  ws.onerror = () => { /* surfaced through onclose */ };
  return {
    ws,
    state,
    type: (text) => ws.send(Buffer.from(text, 'utf8')),
    async ready(label) {
      await waitFor(() => state.ready || state.close, 30_000);
      if (!state.ready) fail(`${label}: no ready frame (close ${state.close?.code ?? 'none'} ${state.close?.reason ?? ''}; notices: ${state.notices.join(' | ') || 'none'})`);
    },
  };
}

// ── the Git server ──────────────────────────────────────────────────────────

/** Files of each test repository (a bare repo `<name>.git` on the Git server). */
function repositories() {
  const repos = {
    dockerfile: {
      Dockerfile: `FROM ${APP_IMAGE}\nCOPY index.html /usr/share/nginx/html/index.html\n`,
      'index.html': `${MARKER}\n`,
    },
  };
  if (WITH_BUILDS) {
    const app = (name) => ({
      'package.json': `${JSON.stringify({ name, version: '1.0.0', private: true, scripts: { start: 'node index.js' }, engines: { node: '22' } }, null, 2)}\n`,
      'index.js': `require('http').createServer((q, s) => s.end('${name}-${suffix}')).listen(Number(process.env.PORT) || 3000);\n`,
    });
    repos.nixpacks = app('nd-mn-nixpacks');
    repos.railpack = app('nd-mn-railpack');
  }
  return repos;
}

async function startGitServer() {
  // The repositories, the nginx config and the htpasswd file are written into
  // the Git volume by a one-shot container of the candidate image (it ships git).
  const lines = ['set -e', 'mkdir -p /srv/repos /tmp/work'];
  for (const [name, files] of Object.entries(repositories())) {
    lines.push(`mkdir -p /tmp/work/${name}`, `cd /tmp/work/${name}`, 'git init -q -b main .');
    for (const [file, content] of Object.entries(files)) {
      lines.push(`cat > '${file}' <<'ND_EOF'\n${content.replace(/\n$/, '')}\nND_EOF`);
    }
    lines.push(
      'git add -A',
      `git -c user.email=smoke@nd.local -c user.name=smoke commit -qm 'nd-mn ${name}'`,
      `git clone -q --bare . /srv/repos/${name}.git`,
      `git -C /srv/repos/${name}.git update-server-info`,
    );
  }
  lines.push(
    `printf '%s\\n' '${PAT_USER}:{PLAIN}${PAT}' > /srv/htpasswd`,
    "cat > /srv/nginx.conf <<'ND_EOF'\nworker_processes 1;\nevents { worker_connections 64; }\nhttp {\n  server {\n    listen 80;\n    location / {\n      root /srv/repos;\n      auth_basic \"nd-mn\";\n      auth_basic_user_file /srv/htpasswd;\n    }\n  }\n}\nND_EOF",
    'chmod -R a+rX /srv',
  );
  const init = spawnSync('docker', ['run', '--rm', '--name', GIT_INIT, '--user', '0:0', '-v', `${GIT_DATA}:/srv`, '--entrypoint', 'sh', CANDIDATE_IMAGE, '-c', lines.join('\n')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (init.status !== 0) fail(`writing the test repositories failed (${init.status}): ${(init.stderr || init.stdout || '').slice(0, 600)}`);
  docker(['run', '-d', '--name', GIT, '--network', NET, '-v', `${GIT_DATA}:/srv:ro`, APP_IMAGE, 'nginx', '-c', '/srv/nginx.conf', '-g', 'daemon off;']);
  return ipOn(GIT);
}

/** The Git server answers 401 without the PAT and 200 with it, from the panel container. */
async function checkGitServer(gitIp) {
  const url = `http://${gitIp}/dockerfile.git/info/refs`;
  const code = (extra) => inContainer(PANEL, ['sh', '-c', `curl -s -o /dev/null -m 5 -w '%{http_code}' ${extra} ${url}`]).stdout;
  const anon = await until(() => {
    const c = code('');
    return c === '401' ? c : null;
  }, { ms: 30_000 });
  if (anon !== '401') fail(`the Git server at ${url} answered ${code('')} without credentials (wanted 401)`);
  const authed = code(`-u '${PAT_USER}:${PAT}'`);
  if (authed !== '200') fail(`the Git server at ${url} answered ${authed} with the PAT (wanted 200)`);
  step(`Git server ${GIT} (${gitIp}): dumb HTTP with basic auth (401 without the PAT, 200 with it)`);
}

// ── the database file ───────────────────────────────────────────────────────

/** Copy the stopped panel's SQLite file out and query it with the repo's libSQL client. */
async function inspectDb(queries) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nd-mn-'));
  const file = path.join(dir, 'ninedeploy.db');
  docker(['cp', `${PANEL}:/data/ninedeploy.db`, file]);
  const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: `file:${file.replace(/\\/g, '/')}` });
  try {
    const out = {};
    for (const [key, sql] of Object.entries(queries)) out[key] = (await client.execute(sql)).rows;
    return out;
  } finally {
    client.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
  }
}

const migrationQueries = {
  migrations: 'SELECT count(*) AS n FROM __drizzle_migrations',
  distinct: 'SELECT count(DISTINCT hash) AS n FROM __drizzle_migrations',
  m0072: MIGRATION_0072 ? `SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at = ${Number(MIGRATION_0072.when)}` : 'SELECT 0 AS n',
  transfersTable: "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'image_transfers'",
};
const n = (rows) => Number(rows?.[0]?.n ?? -1);

// ── node features (mode a, and mode b after the agent update) ───────────────

/** A docker image service on the node, routed by the node's proxy. */
async function nodeImageService(ctx, label) {
  const name = `mn-img-${suffix}`;
  const id = await createService({ name, type: 'docker', image: APP_IMAGE, port: 80, serverId: ctx.serverId }, label);
  const hostname = `${name}.test`;
  await addDomain(id, hostname);
  const dep = await deploy(id, `${label}: node image service`);
  const svc = await serviceRow(id);
  if (!svc.runtimeId || !containerRunning(nodeDaemon, svc.runtimeId)) fail(`${label}: service #${id} has no running container on the node (runtimeId ${svc.runtimeId})`);
  if (panelDaemon(['ps', '-a', '--filter', `name=^${svc.runtimeId}$`, '--format', '{{.Names}}']).stdout) fail(`${label}: ${svc.runtimeId} exists on the panel host too`);
  const page = containerHttp(nodeDaemon, svc.runtimeId, 80);
  if (!/nginx/i.test(page.stdout)) fail(`${label}: ${svc.runtimeId} on the node does not serve nginx: ${page.all.slice(0, 200)}`);
  const code = await routeServes(ctx.nodeIp, hostname, `${label}: node proxy`);
  step(`${label}: image service #${id} deployed to the node (#${dep.id}, ${svc.runtimeId}, only there); the node's proxy routes ${hostname} (${code})`);
  return { id, hostname, runtimeId: svc.runtimeId };
}

/** The PAT source (type custom: any host) the private repositories need. */
async function patSource(label) {
  const r = await api('/v1/sources', { method: 'POST', body: { name: `mn-pat-${suffix}-${label}`, type: 'custom', token: PAT, defaultBranch: 'main' } });
  if ((r.status !== 200 && r.status !== 201) || !r.json?.id || r.json.hasToken !== true) fail(`PAT source create answered ${short(r)}`);
  return r.json.id;
}

async function setAllowOnNodes(sourceId, on, label) {
  const r = await api(`/v1/sources/${sourceId}`, { method: 'PATCH', body: on ? { allowOnNodes: true, password: session.password } : { allowOnNodes: false } });
  if (r.status !== 200 || r.json?.allowOnNodes !== on) fail(`${label}: PATCH /v1/sources/${sourceId} allowOnNodes=${on} answered ${short(r)}`);
}

const repoUrl = (ctx, name) => `http://${ctx.gitIp}/${name}.git`;
const repoService = (ctx, name, { serverId, sourceId, buildPack = 'dockerfile', port = 80, repo = 'dockerfile' }) =>
  createService({ name, type: 'docker', repoUrl: repoUrl(ctx, repo), branch: 'main', ...(sourceId ? { sourceId } : {}), ...(serverId ? { serverId } : {}), port, build: { buildPack } }, name);

/** Private clone on the node with a PAT (design §3). */
async function patCloneChecks(ctx) {
  const label = 'PAT clone on the node';
  const id = await repoService(ctx, `mn-pat-${suffix}`, { serverId: ctx.serverId, sourceId: ctx.sourceId });
  await setAllowOnNodes(ctx.sourceId, false, label);
  await refusedDeploy(id, `${label} (allowOnNodes off)`, { status: 400, code: 'remote_deploy_unsupported', match: /Allow on nodes/ });
  const wrong = await api(`/v1/sources/${ctx.sourceId}`, { method: 'PATCH', body: { allowOnNodes: true, password: 'not-the-password' } });
  if (wrong.status !== 403 || errorCode(wrong) !== 'invalid_password') fail(`${label}: allowOnNodes with a wrong password answered ${short(wrong)} (wanted 403 invalid_password)`);
  await setAllowOnNodes(ctx.sourceId, true, label);
  const dep = await deploy(id, label);
  const svc = await serviceRow(id);
  const page = containerHttp(nodeDaemon, svc.runtimeId, 80);
  if (!page.stdout.includes(MARKER)) fail(`${label}: ${svc.runtimeId} on the node does not serve the repository's index.html: ${page.all.slice(0, 200)}`);
  // The PAT reaches the node for the clone only: never on disk under the agent's data dir.
  // -s: sockets and vanished files are not findings; any file name printed is.
  const leak = inContainer(AGENT, ['grep', '-rIls', '--', PAT, AGENT_HOME]);
  if (leak.stdout) fail(`${label}: the PAT is on disk on the node: ${leak.stdout.slice(0, 300)}`);
  const ssh = inContainer(AGENT, ['sh', '-c', 'command -v ssh']);
  if (ssh.status !== 0 || !ssh.stdout) fail(`D3: the agent image has no ssh client (deploy-key clones need it): ${ssh.all.slice(0, 200)}`);
  step(`${label}: refused while the source does not allow nodes (400, names "Allow on nodes"); a wrong step-up password 403; allowed → Dockerfile build on the node green (#${dep.id}), serving ${MARKER}; the PAT is nowhere under ${AGENT_HOME}; D3: ssh at ${ssh.stdout}`);
  return { id };
}

/** One image_transfers row of a deployment, checked. */
async function transferOf(serviceId, depId, want, label) {
  const r = await api(`/v1/services/${serviceId}/image-transfers`);
  if (r.status !== 200 || !Array.isArray(r.json)) fail(`${label}: GET /v1/services/${serviceId}/image-transfers answered ${short(r)}`);
  const row = r.json.find((t) => t.deploymentId === depId);
  if (!row) fail(`${label}: no image transfer for deployment #${depId}: ${r.text.slice(0, 400)}`);
  if (row.status !== 'completed' || row.method !== 'stream' || row.sourceServerId !== want.source || row.targetServerId !== want.target || !(row.bytes > 0) || !/^(sha256:)?[0-9a-f]{64}$/.test(row.sha256 ?? '')) {
    fail(`${label}: transfer ${JSON.stringify(row)} (wanted completed stream ${want.source ?? 'panel'} → ${want.target ?? 'panel'} with bytes and sha256)`);
  }
  const d = await api(`/v1/deployments/${depId}/image-transfers`);
  if (d.status !== 200 || !d.json?.some((t) => t.id === row.id)) fail(`${label}: GET /v1/deployments/${depId}/image-transfers does not list transfer #${row.id}: ${short(d)}`);
  return row;
}

/** Build placement (design §6): build on the panel for a node service; build on a build server for a panel service. */
async function placementChecks(ctx) {
  // build_on=panel: the PAT stays on the panel, only the image travels.
  let label = 'build_on=panel';
  const onPanel = await repoService(ctx, `mn-onpanel-${suffix}`, { serverId: ctx.serverId, sourceId: ctx.sourceId });
  const missing = await api(`/v1/services/${onPanel}/placement`, { method: 'PUT', body: { buildOn: 'server' } });
  if (missing.status !== 400 || errorCode(missing) !== 'placement_unsupported') fail(`${label}: buildOn=server without a build server answered ${short(missing)} (wanted 400 placement_unsupported)`);
  const notBuilder = await api(`/v1/services/${onPanel}/placement`, { method: 'PUT', body: { buildOn: 'server', buildServerId: ctx.serverId } });
  if (notBuilder.status !== 400 || errorCode(notBuilder) !== 'placement_unsupported') fail(`${label}: a node without the build-server role answered ${short(notBuilder)} (wanted 400 placement_unsupported)`);
  const put = await api(`/v1/services/${onPanel}/placement`, { method: 'PUT', body: { buildOn: 'panel' } });
  if (put.status !== 200 || put.json?.buildOn !== 'panel') fail(`${label}: PUT placement answered ${short(put)}`);
  const get = await api(`/v1/services/${onPanel}/placement`);
  if (get.json?.buildOn !== 'panel' || get.json.orchestrator !== null) fail(`${label}: GET placement reads ${get.text.slice(0, 200)}`);
  let dep = await deploy(onPanel, label);
  let t = await transferOf(onPanel, dep.id, { source: null, target: ctx.serverId }, label);
  const slug = (await serviceRow(onPanel)).slug;
  const tags = nodeDaemon(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `ninedeploy/${slug}`]).stdout.split(/\s+/);
  if (!tags.some((tag) => new RegExp(`^ninedeploy/${slug}:[0-9a-f]{7}-b${dep.id}$`).test(tag))) fail(`${label}: the node has no ninedeploy/${slug}:<sha7>-b${dep.id} (has: ${tags.join(', ') || 'none'})`);
  let svc = await serviceRow(onPanel);
  if (!containerHttp(nodeDaemon, svc.runtimeId, 80).stdout.includes(MARKER)) fail(`${label}: ${svc.runtimeId} on the node does not serve the shipped image`);
  step(`${label}: refusals (no build server 400, not a build server 400); built on the panel and shipped (#${dep.id}): transfer #${t.id} ${t.bytes} bytes, sha256 ${String(t.sha256).slice(-64, -48)}…; the node runs ninedeploy/${slug}:…-b${dep.id}`);

  // build_on=server: a panel service built on the node (build-server role), shipped to the panel.
  label = 'build_on=server';
  const roles = await api(`/v1/servers/${ctx.serverId}`, { method: 'PATCH', body: { isBuildServer: true } });
  if (roles.status !== 200 || roles.json?.isBuildServer !== true) fail(`${label}: PATCH /v1/servers/${ctx.serverId} isBuildServer answered ${short(roles)}`);
  if ((await serverEntry(ctx.serverId)).isBuildServer !== true) fail(`${label}: GET /v1/servers does not show the build-server role`);
  const onNode = await repoService(ctx, `mn-onnode-${suffix}`, { sourceId: ctx.sourceId });
  const put2 = await api(`/v1/services/${onNode}/placement`, { method: 'PUT', body: { buildOn: 'server', buildServerId: ctx.serverId } });
  if (put2.status !== 200 || put2.json?.buildServerId !== ctx.serverId) fail(`${label}: PUT placement answered ${short(put2)}`);
  dep = await deploy(onNode, label);
  t = await transferOf(onNode, dep.id, { source: ctx.serverId, target: null }, label);
  svc = await serviceRow(onNode);
  if (!containerRunning(panelDaemon, svc.runtimeId) || !containerHttp(panelDaemon, svc.runtimeId, 80).stdout.includes(MARKER)) fail(`${label}: ${svc.runtimeId} on the panel host does not serve the image built on the node`);
  step(`${label}: panel service built on build server #${ctx.serverId} and shipped to the panel (#${dep.id}, transfer #${t.id}, ${t.bytes} bytes); ${svc.runtimeId} serves it on the panel host`);
  return { onPanel, onNode };
}

/** Node volumes (design §4): create, attach, back up and restore over the stream channel. */
async function volumeChecks(ctx, img) {
  const label = 'node volume';
  const loose = `nd-svc-mn-loose-${suffix}`;
  const c1 = await api('/v1/volumes', { method: 'POST', body: { name: loose, serverId: ctx.serverId } });
  if (c1.status !== 201 || c1.json?.serverId !== ctx.serverId) fail(`${label}: POST /v1/volumes on the node answered ${short(c1)}`);
  const c2 = await api('/v1/volumes', { method: 'POST', body: { name: loose, serverId: ctx.serverId } });
  if (c2.status !== 409 || errorCode(c2) !== 'node_volume_exists') fail(`${label}: creating it again answered ${short(c2)} (wanted 409 node_volume_exists)`);
  const files = await api(`/v1/volumes/${loose}/files?path=&serverId=${ctx.serverId}`);
  if (files.status !== 422 || errorCode(files) !== 'node_volume_files_unsupported') fail(`${label}: the file manager with ?serverId answered ${short(files)} (wanted 422 node_volume_files_unsupported)`);
  if (panelDaemon(['volume', 'ls', '--format', '{{.Name}}']).stdout.split(/\s+/).includes(loose)) fail(`${label}: ${loose} was created on the panel host`);
  const del = await api(`/v1/volumes/${loose}?serverId=${ctx.serverId}`, { method: 'DELETE' });
  if (del.status >= 300) fail(`${label}: DELETE /v1/volumes/${loose}?serverId answered ${short(del)}`);

  const att = await api(`/v1/services/${img.id}/volumes`, { method: 'POST', body: { create: { label: 'files' }, containerPath: '/srv/files' } });
  const vol = att.json?.attachment?.volumeName;
  if (att.status !== 200 || !vol || typeof att.json.deploymentId !== 'number') fail(`${label}: attaching a volume to service #${img.id} answered ${short(att)}`);
  await waitDeployment(img.id, att.json.deploymentId, `${label}: redeploy with the attachment`);
  const list = await api(`/v1/volumes?serverId=${ctx.serverId}`);
  if (list.status !== 200 || !list.json?.some((v) => v.name === vol && v.serverId === ctx.serverId)) fail(`${label}: GET /v1/volumes?serverId does not list ${vol}: ${short(list)}`);
  let svc = await serviceRow(img.id);
  const payload = `nd-mn-volume-${suffix}`;
  const write = nodeDaemon(['exec', svc.runtimeId, 'sh', '-c', `echo ${payload} > /srv/files/marker.txt`]);
  if (write.status !== 0) fail(`${label}: writing into ${vol} through ${svc.runtimeId} failed: ${write.all.slice(0, 200)}`);
  const b = await api(`/v1/volumes/${vol}/backups?serverId=${ctx.serverId}`, { method: 'POST', body: { label: 'nd-mn' } });
  if (b.status !== 200 || b.json?.status !== 'completed' || b.json.serverId !== ctx.serverId) fail(`${label}: backup of ${vol} on the node answered ${short(b)} (wanted completed with serverId ${ctx.serverId})`);
  const backupId = b.json.id;
  nodeDaemon(['exec', svc.runtimeId, 'rm', '-f', '/srv/files/marker.txt']);
  const busy = await api(`/v1/volumes/${vol}/backups/${backupId}/restore?serverId=${ctx.serverId}`, { method: 'POST' });
  if (busy.status !== 409) fail(`${label}: a restore while ${svc.runtimeId} runs answered ${short(busy)} (wanted 409)`);
  const stop = await api(`/v1/services/${img.id}/stop`, { method: 'POST' });
  if (stop.status !== 200) fail(`${label}: stopping service #${img.id} answered ${short(stop)}`);
  const restore = await api(`/v1/volumes/${vol}/backups/${backupId}/restore?serverId=${ctx.serverId}`, { method: 'POST' });
  if (restore.status !== 200 || restore.json?.ok !== true) fail(`${label}: restore of backup #${backupId} on the node answered ${short(restore)}`);
  const start = await api(`/v1/services/${img.id}/start`, { method: 'POST' });
  if (start.status !== 200) fail(`${label}: starting service #${img.id} again answered ${short(start)}`);
  svc = await serviceRow(img.id);
  const back = await until(() => {
    const r = nodeDaemon(['exec', svc.runtimeId, 'cat', '/srv/files/marker.txt']);
    return r.status === 0 && r.stdout === payload ? r : null;
  }, { ms: 30_000 });
  if (!back) fail(`${label}: the restored ${vol} does not hold marker.txt=${payload}`);
  const strayOnPanel = panelDaemon(['volume', 'ls', '--format', '{{.Name}}']).stdout.split(/\s+/).includes(vol);
  step(`recorded: the attach route also created ${vol} on the panel host: ${strayOnPanel}`);
  step(`${label}: create on the node (201, then 409 node_volume_exists), file manager 422, nothing on the panel host; ${vol} attached, backed up over the stream (#${backupId}, serverId ${ctx.serverId}), restore refused while running (409), restored after a stop: the file is back`);
  return { volume: vol, backupId };
}

/** A shell terminal on the node database runs psql (design §5.4 "Terminal"). */
async function databaseTerminal(databaseId, sql, label) {
  const client = await api('/v1/terminals', { method: 'POST', body: { target: { kind: 'database', databaseId, mode: 'client' } } });
  if (client.status !== 422 || errorCode(client) !== 'client_mode_unsupported') fail(`${label}: a client-mode terminal answered ${short(client)} (wanted 422 client_mode_unsupported)`);
  const r = await api('/v1/terminals', { method: 'POST', body: { target: { kind: 'database', databaseId, mode: 'shell' } } });
  if (r.status !== 201 || !r.json?.ticket) fail(`${label}: POST /v1/terminals (database shell) answered ${short(r)}`);
  const t = terminalAttach(r.json);
  await t.ready(label);
  const a = 100 + Math.floor(Math.random() * 9000);
  const want = `nd-mn-sql-${a + 1}`;
  t.type(`psql -U nine -d app -v ON_ERROR_STOP=1 -c "${sql}" && echo nd-mn-sql-$((${a}+1))\r`);
  if (!(await waitFor(() => t.state.out.includes(want), 30_000))) fail(`${label}: psql through the terminal never confirmed (output tail: ${JSON.stringify(t.state.out.slice(-400))})`);
  t.type('exit\r');
  await waitFor(() => t.state.close, 10_000);
  try { t.ws.close(); } catch { /* closed */ }
  return r.json.session.id;
}

const nodePsql = (container, sql) => nodeDaemon(['exec', container, 'psql', '-U', 'nine', '-d', 'app', '-tAc', sql]);

/**
 * psql on the node, retried until it succeeds (bounded). The panel reports a
 * database `running` once its container runs, on the panel host and on nodes
 * alike; a fresh postgres then answers "the database system is starting up"
 * for a few seconds.
 */
async function nodePsqlReady(container, sql, label, ms = 60_000) {
  let last = null;
  const ok = await until(() => {
    last = nodePsql(container, sql);
    return last.status === 0 ? last : null;
  }, { ms, every: 2000 });
  if (!ok) fail(`${label}: psql in ${container} on the node kept failing for ${ms / 1000}s; last error: ${last?.all.slice(0, 300) || '(none)'}`);
  return ok;
}

/** A one-chunk plain-SQL import (0.14) into a database, through the panel. */
async function importSql(databaseId, label) {
  const sql = Buffer.from("CREATE TABLE smoke_t (id integer PRIMARY KEY, label text NOT NULL);\nINSERT INTO smoke_t (id, label) VALUES (1, 'one'), (2, 'two'), (3, 'three');\n", 'utf8');
  const base = `/v1/databases/${databaseId}/imports`;
  const created = await api(base, { method: 'POST', body: { source: 'upload', sizeBytes: sql.length, sha256: createHash('sha256').update(sql).digest('hex'), filename: 'smoke.sql', options: {} } });
  if (created.status !== 201 || created.json?.status !== 'uploading') fail(`${label}: import create answered ${short(created)}`);
  const importId = created.json.id;
  const chunk = await fetch(`${BASE}${base}/${importId}/chunks/0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${session.token}` }, body: sql });
  const chunkText = await chunk.text();
  if (chunk.status !== 200) fail(`${label}: import chunk 0 answered ${chunk.status} ${chunkText.slice(0, 300)}`);
  const start = await api(`${base}/${importId}/start`, { method: 'POST' });
  if (start.status !== 202) fail(`${label}: import start answered ${short(start)} (wanted 202)`);
  let row = start.json;
  for (let i = 0; i < 180 && (row?.status === 'pending' || row?.status === 'running'); i++) {
    await sleep(1000);
    row = (await api(`${base}/${importId}`)).json;
  }
  if (row?.status !== 'completed' || row.format !== 'pg_plain') fail(`${label}: import #${importId} ended as ${JSON.stringify(row).slice(0, 400)} (wanted completed pg_plain)`);
  return importId;
}

/** Managed database on the node (design §5.9). */
async function nodeDatabaseChecks(ctx, img) {
  const label = 'node database';
  const name = `mn-pg-${suffix}`;
  const created = await api('/v1/databases', { method: 'POST', body: { name, engine: 'postgres', serverId: ctx.serverId } });
  if ((created.status !== 200 && created.status !== 201) || created.json?.status !== 'running' || created.json.serverId !== ctx.serverId) {
    fail(`${label}: POST /v1/databases on node #${ctx.serverId} answered ${short(created)} (wanted running with serverId)`);
  }
  const id = created.json.id;
  const row = (await api(`/v1/databases/${id}`)).json;
  const container = `nd-db-${row.slug}`;
  if (row.containerName !== container || row.serverId !== ctx.serverId) fail(`${label}: GET /v1/databases/${id} reads ${JSON.stringify(row).slice(0, 300)} (wanted containerName ${container} and serverId ${ctx.serverId})`);
  if (!containerRunning(nodeDaemon, container)) fail(`${label}: ${container} is not running on the node`);
  const nets = nodeDaemon(['inspect', '-f', '{{json .NetworkSettings.Networks}}', container]).stdout;
  if (!nets.includes(`nd-dbnet-${row.slug}`) || nets.includes('"ninedeploy"')) fail(`${label}: ${container} should be on nd-dbnet-${row.slug} only: ${nets.slice(0, 300)}`);
  if (panelDaemon(['ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Names}}']).stdout) fail(`${label}: ${container} exists on the panel host`);
  if (panelDaemon(['volume', 'ls', '--format', '{{.Name}}']).stdout.split(/\s+/).includes(`${container}-data`)) fail(`${label}: ${container}-data exists on the panel host`);
  if ((await serverEntry(ctx.serverId)).databases !== 1) fail(`${label}: GET /v1/servers does not count the node's database`);
  step(`${label}: postgres #${id} running on the node only (${container}, on nd-dbnet-${row.slug}); GET /v1/servers counts it`);

  for (const [what, p, method, body] of [
    ['Studio', `/v1/databases/${id}/studio`, 'POST', {}],
    ['PgBouncer', `/v1/databases/${id}/pgbouncer/enable`, 'POST', {}],
    ['public access', `/v1/databases/${id}/public-access`, 'PUT', { enabled: true, port: 15432, ipAllowlist: ['203.0.113.0/24'], tlsMode: 'none' }],
  ]) {
    const r = await api(p, { method, body });
    if (r.status !== 422 || errorCode(r) !== 'remote_database') fail(`${label}: ${what} answered ${short(r)} (wanted 422 remote_database)`);
  }
  await nodePsqlReady(container, 'select 1', `${label}: postgres accepting connections`);
  const session1 = await databaseTerminal(id, 'CREATE TABLE nd_mn_t (id integer); INSERT INTO nd_mn_t VALUES (1), (2), (3);', `${label} terminal`);
  if (nodePsql(container, 'select count(*) from nd_mn_t').stdout !== '3') fail(`${label}: the table created through the terminal is not on the node`);
  step(`${label}: Studio, PgBouncer and public access 422 remote_database; client terminal 422; shell terminal #${session1} ran psql (nd_mn_t has 3 rows on the node)`);

  // Same-node attachment: env injected, and the name resolves from the app.
  const att = await api(`/v1/services/${img.id}/attachments`, { method: 'POST', body: { databaseId: id } });
  if (att.status !== 200 || att.json?.databaseId !== id) fail(`${label}: attaching to node service #${img.id} answered ${short(att)}`);
  await deploy(img.id, `${label}: redeploy with the attachment`);
  const svc = await serviceRow(img.id);
  const env = nodeDaemon(['exec', svc.runtimeId, 'printenv', 'DATABASE_URL']).stdout;
  if (!env.includes(`@${container}:5432/`)) fail(`${label}: DATABASE_URL in ${svc.runtimeId} is ${env ? 'set but does not name the node database' : 'missing'}`);
  const resolve = nodeDaemon(['exec', svc.runtimeId, 'sh', '-c', `getent hosts ${container} || nslookup ${container}`]);
  if (resolve.status !== 0 || !/\d+\.\d+\.\d+\.\d+/.test(resolve.stdout)) fail(`${label}: ${container} does not resolve from ${svc.runtimeId}: ${resolve.all.slice(0, 200)}`);
  const panelSvc = await createService({ name: `mn-dbpanel-${suffix}`, type: 'docker', image: APP_IMAGE, port: 80 }, label);
  const cross = await api(`/v1/services/${panelSvc}/attachments`, { method: 'POST', body: { databaseId: id } });
  if (cross.status !== 409 || errorCode(cross) !== 'attachment_host_mismatch') fail(`${label}: attaching it to a panel service answered ${short(cross)} (wanted 409 attachment_host_mismatch)`);
  step(`${label}: attached to node service #${img.id}: DATABASE_URL names ${container}, which resolves from ${svc.runtimeId}; a panel service is refused (409 attachment_host_mismatch)`);

  // Backup → drop → restore, then an import.
  const b = await api(`/v1/databases/${id}/backups`, { method: 'POST' });
  if (b.status !== 200 || b.json?.status !== 'completed') fail(`${label}: backup answered ${short(b)}`);
  if (nodePsql(container, 'DROP TABLE nd_mn_t').status !== 0) fail(`${label}: could not drop nd_mn_t on the node`);
  const restore = await api(`/v1/databases/${id}/backups/${b.json.id}/restore`, { method: 'POST' });
  if (restore.status !== 200 || restore.json?.ok !== true) fail(`${label}: restore of backup #${b.json.id} answered ${short(restore)}`);
  if (nodePsql(container, 'select count(*) from nd_mn_t').stdout !== '3') fail(`${label}: nd_mn_t is not back after the restore`);
  const importId = await importSql(id, `${label} import`);
  if (nodePsql(container, 'select count(*) from smoke_t').stdout !== '3') fail(`${label}: the imported smoke_t is not on the node`);
  const del = await api(`/v1/servers/${ctx.serverId}?force=true`, { method: 'DELETE' });
  if (del.status !== 409 || errorCode(del) !== 'server_hosts_databases') fail(`${label}: DELETE /v1/servers/${ctx.serverId}?force=true answered ${short(del)} (wanted 409 server_hosts_databases)`);
  step(`${label}: backup #${b.json.id} → drop → restore brings nd_mn_t back; import #${importId} landed smoke_t on the node; DELETE /v1/servers?force=true 409 server_hosts_databases`);
  return { id, container, backupId: b.json.id };
}

/** D4: a panel-host database attached through the attach route is reachable by name from the app. */
async function d4Checks() {
  const label = 'D4';
  const pg = await api('/v1/databases', { method: 'POST', body: { name: `mn-pgl-${suffix}`, engine: 'postgres' } });
  if ((pg.status !== 200 && pg.status !== 201) || pg.json?.status !== 'running') fail(`${label}: panel postgres create answered ${short(pg)}`);
  const container = (await api(`/v1/databases/${pg.json.id}`)).json?.containerName;
  const id = await createService({ name: `mn-d4-${suffix}`, type: 'docker', image: APP_IMAGE, port: 80 }, label);
  const att = await api(`/v1/services/${id}/attachments`, { method: 'POST', body: { databaseId: pg.json.id } });
  if (att.status !== 200) fail(`${label}: attach answered ${short(att)}`);
  await deploy(id, label);
  const svc = await serviceRow(id);
  const resolve = panelDaemon(['exec', svc.runtimeId, 'sh', '-c', `getent hosts ${container} || nslookup ${container}`]);
  if (resolve.status !== 0 || !/\d+\.\d+\.\d+\.\d+/.test(resolve.stdout)) fail(`${label}: ${container} does not resolve from ${svc.runtimeId} on the panel host: ${resolve.all.slice(0, 200)}`);
  step(`${label}: panel postgres ${container} attached to service #${id} resolves from ${svc.runtimeId} (${resolve.stdout.split(/\s+/)[0]})`);
}

/** The image store a DinD daemon uses, as the agent's F1016 preflight reads it. */
function daemonImageStore(daemon) {
  const r = daemon(['info', '--format', '{{.Driver}} {{json .DriverStatus}}']);
  if (r.status !== 0) return { store: 'unknown', raw: r.all.slice(0, 200) };
  return { store: r.stdout.includes('"io.containerd.snapshotter.v1"') ? 'containerd' : 'classic', raw: r.stdout.slice(0, 200) };
}

/** Build `pack` on node `serverId` and check the app answers there (and, for Railpack, that the secret is not in the image history). */
async function buildAndServe(ctx, { pack, serverId, daemon, name, label }) {
  const id = await repoService(ctx, name, { serverId, sourceId: ctx.sourceId, buildPack: pack, port: 3000, repo: pack });
  const secret = `nd-mn-secret-${randomBytes(8).toString('hex')}`;
  const env = await api(`/v1/services/${id}/env`, { method: 'POST', body: { key: 'ND_MN_BUILD_SECRET', value: secret, isSecret: true } });
  if (env.status !== 200 && env.status !== 201) fail(`${label}: env create answered ${short(env)}`);
  const dep = await deploy(id, label);
  const svc = await serviceRow(id);
  const page = await until(() => {
    const r = containerHttp(daemon, svc.runtimeId, 3000, { node: true });
    return r.stdout.includes(`nd-mn-${pack}-${suffix}`) ? r : null;
  }, { ms: 60_000, every: 2000 });
  if (!page) fail(`${label}: ${svc.runtimeId} never served nd-mn-${pack}-${suffix}`);
  const imageId = daemon(['inspect', '-f', '{{.Image}}', svc.runtimeId]).stdout;
  const history = daemon(['history', '--no-trunc', '--format', '{{.CreatedBy}}', imageId]).stdout;
  if (pack === 'railpack' && history.includes(secret)) fail(`${label}: the secret env value is in the image history (it must travel as a BuildKit secret)`);
  const inConfig = daemon(['image', 'inspect', '--format', '{{json .Config.Env}}', imageId]).stdout.includes(secret);
  step(`${label}: green (#${dep.id}), ${svc.runtimeId} serves the app${pack === 'railpack' ? '; the secret is not in the image history' : ''}; recorded: secret in the image config env: ${inConfig}`);
}

/**
 * O11 (--with-builds): Nixpacks on the node; Railpack refused with the fix on a
 * node whose Docker uses the classic image store (F1016: Railpack's frontend
 * needs BuildKit's mergeop, which Docker enables only with the containerd
 * image store); Railpack green on a second node that has that store.
 */
async function heavyBuildChecks(ctx) {
  await buildAndServe(ctx, { pack: 'nixpacks', serverId: ctx.serverId, daemon: nodeDaemon, name: `mn-nixpacks-${suffix}`, label: 'nixpacks build on the node' });

  const first = daemonImageStore(nodeDaemon);
  if (first.store === 'classic') {
    const label = 'railpack on a classic-store node';
    const id = await repoService(ctx, `mn-railpack1-${suffix}`, { serverId: ctx.serverId, sourceId: ctx.sourceId, buildPack: 'railpack', port: 3000, repo: 'railpack' });
    const dep = await deploy(id, label, { expect: 'failed' });
    const log = await deployLogTail(id, dep.id, 120);
    for (const want of ['containerd-snapshotter', 'NINEDEPLOY_AGENT_BUILDKIT_HOST', 'Build on: panel']) {
      if (!log.includes(want)) fail(`${label}: deployment #${dep.id} failed without naming ${want}:\n${log}`);
    }
    if (/mergeop/.test(log)) fail(`${label}: the build still reached BuildKit (mergeop error) instead of the agent's refusal:\n${log}`);
    step(`${label}: refused before building (#${dep.id} failed), naming the containerd image store, NINEDEPLOY_AGENT_BUILDKIT_HOST and Build on: panel`);
  } else {
    step(`recorded: the default node DinD uses the ${first.store} image store (${first.raw}); the classic-store refusal is not exercised`);
  }

  // A second node with the containerd image store: Railpack builds there.
  await startDind(NODE2, `${AGENT2_DATA}:${AGENT_HOME}`, { containerdStore: true });
  const second = daemonImageStore(node2Daemon);
  if (second.store !== 'containerd') fail(`the second node's DinD did not enable the containerd image store (daemon.json features.containerd-snapshotter): docker info reads ${second.raw}`);
  const node2Ip = ipOn(NODE2);
  const { serverId: server2 } = await enrolNode(CANDIDATE_IMAGE, node2Ip, 'second node (containerd image store)', {}, NODE_2);
  await buildAndServe(ctx, { pack: 'railpack', serverId: server2, daemon: node2Daemon, name: `mn-railpack-${suffix}`, label: `railpack build on node #${server2} (containerd image store)` });
}

/** Docker Swarm (design §7.9): opt-in on both sides, a routed 2-replica service, join and leave. */
async function swarmChecks(ctx) {
  const label = 'Swarm';
  const notYet = await api(`/v1/servers/${ctx.serverId}/swarm/join`, { method: 'POST' });
  if (notYet.status !== 422 || errorCode(notYet) !== 'node_swarm_not_enabled') fail(`${label}: join before the agent opts in answered ${short(notYet)} (wanted 422 node_swarm_not_enabled)`);
  const svcId = await createService({ name: `mn-swarm-${suffix}`, type: 'docker', image: APP_IMAGE, port: 80, replicas: 2 }, label);
  const disabled = await api(`/v1/services/${svcId}/placement`, { method: 'PUT', body: { orchestrator: 'swarm' } });
  if (disabled.status !== 422 || errorCode(disabled) !== 'swarm_disabled') fail(`${label}: Swarm placement before enabling answered ${short(disabled)} (wanted 422 swarm_disabled)`);
  const pinned = await api(`/v1/services/${ctx.imgId}/placement`, { method: 'PUT', body: { orchestrator: 'swarm' } });
  if (pinned.status !== 422 || errorCode(pinned) !== 'swarm_unsupported') fail(`${label}: Swarm placement of a node-pinned service answered ${short(pinned)} (wanted 422 swarm_unsupported)`);

  const init = await api('/v1/swarm/init', { method: 'POST', body: { advertiseAddr: ctx.panelDindIp, password: session.password } });
  if (init.status === 502 && errorCode(init) === 'swarm_overlay_unavailable') {
    fail(`${label}: POST /v1/swarm/init answered 502 swarm_overlay_unavailable: ${init.json?.error?.message ?? init.text.slice(0, 300)}\n` +
      '  Encrypted overlays need IPsec (xfrm, ESP) in the kernel the DinD daemons run on; Docker Desktop\'s kernel may lack it. ' +
      'Re-run with --no-swarm to skip the Swarm checks on this host, and run them on a Linux host before tagging.');
  }
  if (init.status !== 200 || init.json?.localState !== 'active' || init.json.managerAddr !== `${ctx.panelDindIp}:2377`) fail(`${label}: POST /v1/swarm/init answered ${short(init)} (wanted active with managerAddr ${ctx.panelDindIp}:2377)`);
  const again = await api('/v1/swarm/init', { method: 'POST', body: { advertiseAddr: ctx.panelDindIp, password: session.password } });
  if (again.status !== 409 || errorCode(again) !== 'swarm_already_active') fail(`${label}: a second init answered ${short(again)} (wanted 409 swarm_already_active)`);
  const on = await api('/v1/swarm/settings', { method: 'PUT', body: { enabled: true, password: session.password } });
  if (on.status !== 200 || on.json?.enabled !== true) fail(`${label}: enabling answered ${short(on)}`);
  step(`${label}: join before the agent opts in 422 node_swarm_not_enabled; placement 422 swarm_disabled / swarm_unsupported; init on ${ctx.panelDindIp} (warnings: ${(init.json.warnings ?? []).length}), a second init 409, enabled`);

  const hostname = `mn-swarm-${suffix}.test`;
  await addDomain(svcId, hostname);
  const put = await api(`/v1/services/${svcId}/placement`, { method: 'PUT', body: { orchestrator: 'swarm' } });
  if (put.status !== 200 || put.json?.orchestrator !== 'swarm') fail(`${label}: Swarm placement answered ${short(put)}`);
  const dep = await deploy(svcId, `${label} deploy`);
  const svc = await serviceRow(svcId);
  const stack = `nd-${svc.slug}`;
  if (svc.runtimeId !== `${stack}_web`) fail(`${label}: runtimeId is ${svc.runtimeId} (wanted ${stack}_web)`);
  const tasks = await until(async () => {
    const r = await api(`/v1/services/${svcId}/swarm`);
    return r.json?.running === 2 && r.json.desired === 2 ? r.json : null;
  }, { ms: 120_000, every: 3000 });
  if (!tasks) fail(`${label}: GET /v1/services/${svcId}/swarm never showed 2/2: ${(await api(`/v1/services/${svcId}/swarm`)).text.slice(0, 400)}`);
  await routeServes(DIND, hostname, `${label} route`);
  const codes = routeStatuses(DIND, hostname, 20);
  if (codes.length !== 20 || !codes.every(served)) fail(`${label}: 20 requests for ${hostname} through Traefik answered ${codes.join(',')}`);
  step(`${label}: service #${svcId} deployed as stack ${stack} (#${dep.id}), 2/2 tasks; Traefik answered 20/20 for ${hostname}`);

  // The node's owner opts in; then join and leave.
  startAgent(CANDIDATE_IMAGE, ctx.tokenSha256, { NINEDEPLOY_AGENT_SWARM_MANAGER: `${ctx.panelDindIp}:2377` });
  await waitAgent(ctx.serverId, `${label}: agent restart with the opt-in`);
  // The join pings the agent first (and refreshes the panel's capability cache with the answer).
  const join = await api(`/v1/servers/${ctx.serverId}/swarm/join`, { method: 'POST' });
  if (join.status === 502 && errorCode(join) === 'swarm_overlay_unavailable') fail(`${label}: join answered 502 swarm_overlay_unavailable (${join.text.slice(0, 300)}); re-run with --no-swarm on a host without IPsec`);
  if (join.status !== 200 || join.json?.role !== 'worker' || !join.json.nodeId) fail(`${label}: join answered ${short(join)}`);
  const features = (await serverEntry(ctx.serverId)).features;
  if (features?.swarm !== true) fail(`${label}: GET /v1/servers reads features.swarm ${features?.swarm} after the opt-in and the join: ${JSON.stringify(features)}`);
  const twice = await api(`/v1/servers/${ctx.serverId}/swarm/join`, { method: 'POST' });
  if (twice.status !== 409 || errorCode(twice) !== 'swarm_already_joined') fail(`${label}: a second join answered ${short(twice)} (wanted 409 swarm_already_joined)`);
  const status = await api('/v1/swarm');
  if (!status.json?.nodes?.some((nd) => nd.serverId === ctx.serverId && nd.role === 'worker') || status.json.nodes.length < 2) fail(`${label}: GET /v1/swarm after the join: ${status.text.slice(0, 400)}`);
  if ((await serverEntry(ctx.serverId)).swarmNodeId !== join.json.nodeId) fail(`${label}: GET /v1/servers does not record swarm node ${join.json.nodeId}`);
  const del = await api(`/v1/servers/${ctx.serverId}?force=true`, { method: 'DELETE' });
  if (del.status !== 409) fail(`${label}: deleting a member server answered ${short(del)} (wanted 409)`);
  const leave = await api(`/v1/servers/${ctx.serverId}/swarm/leave`, { method: 'POST' });
  if (leave.status !== 200 || leave.json?.nodeId !== join.json.nodeId) fail(`${label}: leave answered ${short(leave)}`);
  const state = nodeDaemon(['info', '--format', '{{.Swarm.LocalNodeState}}']).stdout;
  if (state !== 'inactive') fail(`${label}: the node's daemon is '${state}' after the leave (wanted inactive)`);
  const left = await api(`/v1/servers/${ctx.serverId}/swarm/leave`, { method: 'POST' });
  if (left.status !== 409 || errorCode(left) !== 'swarm_not_joined') fail(`${label}: a second leave answered ${short(left)} (wanted 409 swarm_not_joined)`);
  await routeServes(DIND, hostname, `${label} route after the leave`);
  step(`${label}: agent restarted with NINEDEPLOY_AGENT_SWARM_MANAGER=${ctx.panelDindIp}:2377; joined as worker ${join.json.nodeId} (second join 409, member delete 409); left (drained: ${leave.json.drained}; second leave 409); the node is out of Swarm and the route still answers`);
  return { svcId, hostname, stack };
}

/** Everything a current agent can do (mode a, and mode b after the agent update). */
async function nodeFeatureSuite(ctx) {
  section(`node features on the ${CANDIDATE_VERSION} agent`);
  ctx.sourceId ??= await patSource('suite');
  if (candidateHas(AGENT_MULTI_NODE)) {
    await patCloneChecks(ctx);
    await placementChecks(ctx);
    await volumeChecks(ctx, { id: ctx.imgId });
  } else step(`${CANDIDATE_VERSION} predates multi-node builds, clones, placement and volumes (v${AGENT_MULTI_NODE}): skipped`);
  if (candidateHas(AGENT_DB_MANAGE)) {
    await nodeDatabaseChecks(ctx, { id: ctx.imgId });
    await d4Checks();
  } else step(`${CANDIDATE_VERSION} predates node databases and D4 (v${AGENT_DB_MANAGE}): skipped`);
  if (WITH_BUILDS) await heavyBuildChecks(ctx);
  else step('Nixpacks / Railpack builds on the node: not requested (--with-builds)');
  if (NO_SWARM) step('Swarm: skipped on request (--no-swarm)');
  else if (candidateHas(AGENT_SWARM)) await swarmChecks(ctx);
  else step(`${CANDIDATE_VERSION} predates Swarm (v${AGENT_SWARM}): skipped`);
}

// ── enrolment ───────────────────────────────────────────────────────────────

async function register() {
  const reg = await rawApi('/v1/auth/register', { method: 'POST', body: { email: session.email, password: session.password, name: 'Multinode' } });
  if (reg.status !== 200 || !reg.json?.tokens?.accessToken) fail(`register failed: ${short(reg)}`);
  session.token = reg.json.tokens.accessToken;
}

/** POST /v1/servers for the node, then the agent from `agentRef`, then /test. */
async function enrolNode(agentRef, nodeIp, label, extraEnv = {}, host = NODE_1) {
  const r = await api('/v1/servers', { method: 'POST', body: { name: host === NODE_1 ? `mn-node-${suffix}` : `mn-node2-${suffix}`, host: nodeIp, port: AGENT_PORT } });
  if (r.status !== 200 || !r.json?.id || !/^[0-9a-f]{64}$/.test(r.json.tokenSha256 ?? '') || !r.json.agentCommand?.includes('NINEDEPLOY_AGENT_TOKEN=')) fail(`${label}: POST /v1/servers answered ${short(r)}`);
  startAgent(agentRef, r.json.tokenSha256, extraEnv, host);
  await waitAgent(r.json.id, label, host.agent);
  step(`${label}: server #${r.json.id} at ${nodeIp}:${AGENT_PORT} (token hash from POST /v1/servers), agent ${agentRef} answered /test`);
  return { serverId: r.json.id, tokenSha256: r.json.tokenSha256 };
}

/** GET /v1/servers for a current agent: its version, and every feature but Swarm unless it opted in. */
async function currentAgentView(serverId, { swarm }) {
  // The panel keeps the last sealed ping in memory for 5 minutes. A capability-gated
  // read (the node's volume list) pings again whenever that answer lacks the capability,
  // so a just-updated agent is seen now rather than after the cache expires.
  await api(`/v1/volumes?serverId=${serverId}`);
  const row = await until(async () => {
    const s = await serverEntry(serverId);
    return s.agent?.version === CANDIDATE_VERSION ? s : null;
  }, { ms: 30_000, every: 2000 });
  if (!row) fail(`GET /v1/servers never reported agent ${CANDIDATE_VERSION}: ${JSON.stringify((await serverEntry(serverId)).agent)}`);
  const want = {
    nixpacks: candidateHas(AGENT_MULTI_NODE),
    railpack: candidateHas(AGENT_MULTI_NODE),
    privateClones: candidateHas(AGENT_MULTI_NODE),
    volumes: candidateHas(AGENT_MULTI_NODE),
    imageTransfer: candidateHas(AGENT_MULTI_NODE),
    databases: candidateHas(AGENT_DB_MANAGE),
    swarm: swarm && candidateHas(AGENT_SWARM),
  };
  const off = Object.entries(want).filter(([k, v]) => row.features?.[k] !== v).map(([k]) => k);
  if (off.length) fail(`GET /v1/servers features for agent ${CANDIDATE_VERSION}: ${JSON.stringify(row.features)} (wrong: ${off.join(', ')})`);
  if (row.terminal?.container !== true) fail(`GET /v1/servers terminal for agent ${CANDIDATE_VERSION}: ${JSON.stringify(row.terminal)}`);
  step(`GET /v1/servers: agent ${row.agent.version}, capabilities ${row.agent.capabilities.join(' ')}; features ${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

// ── mode (b): an older agent under the upgraded panel ───────────────────────

/** Each newer feature answers 422 node_agent_outdated with the FROM agent, after agent.ping only. */
async function outdatedAgentChecks(ctx) {
  section(`${TO} panel with the ${FROM} agent`);
  const outdated = (r, what) => {
    if (r.status !== 422 || errorCode(r) !== 'node_agent_outdated' || !/Update the node agent to v/.test(r.json?.error?.message ?? r.text)) {
      fail(`${what} with the ${FROM} agent answered ${short(r)} (wanted 422 node_agent_outdated with the update hint)`);
    }
  };
  const done = [];
  const skipped = [];
  const when = async (min, what, fn) => {
    if (!olderThan(FROM, min)) {
      skipped.push(`${what} (the ${FROM} agent has it)`);
      return;
    }
    await fn();
    done.push(what);
  };
  const view = await serverEntry(ctx.serverId);
  if (view.agent?.version !== bare(FROM) || view.features?.volumes !== false || !/Update the node agent to v/.test(view.features?.reason ?? '')) {
    fail(`GET /v1/servers for the ${FROM} agent: ${JSON.stringify({ agent: view.agent, features: view.features })}`);
  }
  step(`GET /v1/servers: agent ${view.agent.version}; features off with the hint: "${view.features.reason.slice(0, 120)}…"`);

  await when(AGENT_DB_MANAGE, 'node database create', async () => {
    const name = `mn-pgold-${suffix}`;
    outdated(await api('/v1/databases', { method: 'POST', body: { name, engine: 'postgres', serverId: ctx.serverId } }), 'a node database');
    if ((await api('/v1/databases')).json?.some?.((d) => d.name === name)) fail(`a refused node database create left a row (${name})`);
  });
  await when(AGENT_MULTI_NODE, 'node volume create', async () => {
    outdated(await api('/v1/volumes', { method: 'POST', body: { name: `nd-svc-mn-old-${suffix}`, serverId: ctx.serverId } }), 'a node volume');
  });
  const patOld = await repoService(ctx, `mn-patold-${suffix}`, { serverId: ctx.serverId, sourceId: ctx.sourceId });
  await when(AGENT_MULTI_NODE, 'build_on=panel', async () => {
    outdated(await api(`/v1/services/${patOld}/placement`, { method: 'PUT', body: { buildOn: 'panel' } }), 'build on the panel for a node service');
    if ((await api(`/v1/services/${patOld}/placement`)).json?.buildOn !== null) fail('a refused placement was stored');
  });
  await when(AGENT_MULTI_NODE, 'build_on=server', async () => {
    const roles = await api(`/v1/servers/${ctx.serverId}`, { method: 'PATCH', body: { isBuildServer: true } });
    if (roles.status !== 200) fail(`PATCH /v1/servers/${ctx.serverId} answered ${short(roles)}`);
    const panelSvc = await repoService(ctx, `mn-onnodeold-${suffix}`, { sourceId: ctx.sourceId });
    outdated(await api(`/v1/services/${panelSvc}/placement`, { method: 'PUT', body: { buildOn: 'server', buildServerId: ctx.serverId } }), 'a build server');
    await api(`/v1/servers/${ctx.serverId}`, { method: 'PATCH', body: { isBuildServer: false } });
  });
  await when(AGENT_MULTI_NODE, 'PAT clone on the node', async () => {
    await refusedDeploy(patOld, 'a PAT service while the source does not allow nodes', { status: 400, code: 'remote_deploy_unsupported', match: /Allow on nodes/ });
    await setAllowOnNodes(ctx.sourceId, true, 'PAT on the old agent');
    outdated(await refusedDeploy(patOld, 'a PAT clone on the node', { status: 422 }), 'a PAT clone on the node');
  });
  await when(AGENT_MULTI_NODE, 'Nixpacks on the node', async () => {
    const nix = await repoService(ctx, `mn-nixold-${suffix}`, { serverId: ctx.serverId, buildPack: 'nixpacks', port: 3000 });
    outdated(await refusedDeploy(nix, 'a Nixpacks build on the node', { status: 422 }), 'a Nixpacks build on the node');
  });
  await when(AGENT_SWARM, 'Swarm join', async () => {
    outdated(await api(`/v1/servers/${ctx.serverId}/swarm/join`, { method: 'POST' }), 'a Swarm join');
  });
  step(`422 node_agent_outdated with the update hint, nothing stored: ${done.join(', ') || 'none'}${skipped.length ? `; not applicable: ${skipped.join(', ')}` : ''}`);
}

// ── mode (c): the rollback rehearsal ────────────────────────────────────────

/** What the candidate leaves on the node before the panel goes back. */
async function seedForRollback(ctx) {
  section(`${FROM} seeds every node feature`);
  ctx.sourceId = await patSource('rollback');
  await setAllowOnNodes(ctx.sourceId, true, 'rollback seed');
  const seeded = { refused: [] };
  const pat = await repoService(ctx, `mn-pat-${suffix}`, { serverId: ctx.serverId, sourceId: ctx.sourceId });
  await deploy(pat, 'seed: PAT clone on the node');
  seeded.refused.push({ id: pat, why: 'a PAT clone on the node' });
  const onPanel = await repoService(ctx, `mn-onpanel-${suffix}`, { serverId: ctx.serverId, sourceId: ctx.sourceId });
  const put = await api(`/v1/services/${onPanel}/placement`, { method: 'PUT', body: { buildOn: 'panel' } });
  if (put.status !== 200) fail(`seed: build_on=panel placement answered ${short(put)}`);
  await deploy(onPanel, 'seed: build on the panel');
  seeded.refused.push({ id: onPanel, why: 'built on the panel for a node' });
  const vol = await createService({ name: `mn-vol-${suffix}`, type: 'docker', image: APP_IMAGE, port: 80, serverId: ctx.serverId }, 'seed');
  const att = await api(`/v1/services/${vol}/volumes`, { method: 'POST', body: { create: { label: 'files' }, containerPath: '/srv/files' } });
  if (att.status !== 200) fail(`seed: volume attach answered ${short(att)}`);
  await waitDeployment(vol, att.json.deploymentId, 'seed: node service with a volume');
  seeded.volume = att.json.attachment.volumeName;
  seeded.refused.push({ id: vol, why: 'a volume attachment on the node' });
  step(`seeded: PAT service #${pat}, build-on-panel service #${onPanel}, volume service #${vol} (${seeded.volume}) running on the node`);

  if (candidateHas(AGENT_DB_MANAGE)) {
    const created = await api('/v1/databases', { method: 'POST', body: { name: `mn-pg-${suffix}`, engine: 'postgres', serverId: ctx.serverId } });
    if ((created.status !== 200 && created.status !== 201) || created.json?.status !== 'running') fail(`seed: node database answered ${short(created)}`);
    const slug = (await api(`/v1/databases/${created.json.id}`)).json.slug;
    seeded.db = { id: created.json.id, slug, container: `nd-db-${slug}` };
    await nodePsqlReady(seeded.db.container, 'CREATE TABLE nd_mn_t (id integer); INSERT INTO nd_mn_t VALUES (1), (2), (3);', 'seed: create nd_mn_t on the node database');
    const b = await api(`/v1/databases/${created.json.id}/backups`, { method: 'POST' });
    if (b.status !== 200 || b.json?.status !== 'completed') fail(`seed: node database backup answered ${short(b)}`);
    seeded.db.backupId = b.json.id;
    const a2 = await api(`/v1/services/${vol}/attachments`, { method: 'POST', body: { databaseId: created.json.id } });
    if (a2.status !== 200) fail(`seed: attaching the node database answered ${short(a2)}`);
    step(`seeded: node postgres #${created.json.id} (${seeded.db.container}) with nd_mn_t, backup #${b.json.id}, attached to service #${vol}`);
  }
  if (!NO_SWARM && candidateHas(AGENT_SWARM)) {
    const init = await api('/v1/swarm/init', { method: 'POST', body: { advertiseAddr: ctx.panelDindIp, password: session.password } });
    if (init.status === 502 && errorCode(init) === 'swarm_overlay_unavailable') fail(`seed: Swarm init answered 502 swarm_overlay_unavailable (${init.text.slice(0, 300)}); re-run with --no-swarm on a host without IPsec`);
    if (init.status !== 200) fail(`seed: Swarm init answered ${short(init)}`);
    const on = await api('/v1/swarm/settings', { method: 'PUT', body: { enabled: true, password: session.password } });
    if (on.status !== 200) fail(`seed: Swarm enable answered ${short(on)}`);
    const svcId = await createService({ name: `mn-swarm-${suffix}`, type: 'docker', image: APP_IMAGE, port: 80, replicas: 2 }, 'seed');
    const hostname = `mn-swarm-${suffix}.test`;
    await addDomain(svcId, hostname);
    const p = await api(`/v1/services/${svcId}/placement`, { method: 'PUT', body: { orchestrator: 'swarm' } });
    if (p.status !== 200) fail(`seed: Swarm placement answered ${short(p)}`);
    await deploy(svcId, 'seed: Swarm service');
    await routeServes(DIND, hostname, 'seed: Swarm route');
    seeded.swarm = { svcId, hostname, stack: `nd-${(await serviceRow(svcId)).slug}`, slug: (await serviceRow(svcId)).slug };
    step(`seeded: Swarm stack ${seeded.swarm.stack} (service #${svcId}) routed for ${hostname}`);
  } else step(NO_SWARM ? 'Swarm seed skipped on request (--no-swarm)' : `${FROM} predates Swarm: no stack seeded`);
  const traefik = panelDaemon(['inspect', '-f', '{{.Id}}', 'ninedeploy-traefik']).stdout;
  seeded.traefikId = traefik;
  seeded.containers = {};
  for (const { id } of seeded.refused) seeded.containers[id] = (await serviceRow(id)).runtimeId;
  return seeded;
}

async function rollbackChecks(ctx, seeded) {
  section(`${TO} panel with the ${FROM} agent (rollback)`);
  // The node image service still redeploys: an older panel talking to a newer agent.
  await deploy(ctx.imgId, `${TO}: node image service`);
  const img = await serviceRow(ctx.imgId);
  if (!containerRunning(nodeDaemon, img.runtimeId)) fail(`${TO}: the redeployed node image service is not running on the node`);
  step(`${TO} redeployed node image service #${ctx.imgId} through the ${FROM} agent (${img.runtimeId})`);

  for (const { id, why } of seeded.refused) {
    const r = await refusedDeploy(id, `${TO}: ${why}`, {});
    const name = seeded.containers[id];
    if (!containerRunning(nodeDaemon, name)) fail(`${TO}: ${why}: its container ${name} stopped after the refusal`);
    step(`${TO} refuses ${why} (${r.status} ${errorCode(r) ?? ''}); ${name} keeps running on the node`);
  }

  if (seeded.db) {
    const { id, container } = seeded.db;
    const start = await api(`/v1/databases/${id}/start`, { method: 'POST' });
    if (start.status < 400) fail(`${TO}: starting node database #${id} answered ${short(start)} (wanted a refusal)`);
    const backup = await api(`/v1/databases/${id}/backups`, { method: 'POST' });
    if (backup.status < 400) fail(`${TO}: backing up node database #${id} answered ${short(backup)} (wanted a refusal)`);
    if (panelDaemon(['ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Names}}']).stdout) fail(`${TO}: ${container} appeared on the panel host`);
    if (panelDaemon(['volume', 'ls', '--format', '{{.Name}}']).stdout.split(/\s+/).includes(`${container}-data`)) fail(`${TO}: ${container}-data appeared on the panel host`);
    if (!containerRunning(nodeDaemon, container) || nodePsql(container, 'select count(*) from nd_mn_t').stdout !== '3') fail(`${TO}: ${container} on the node lost its data or stopped`);
    const dl = await fetch(`${BASE}/v1/backups/${seeded.db.backupId}/download`, { headers: { authorization: `Bearer ${session.token}` } });
    const body = await dl.text();
    if (dl.status !== 200 || !body.includes('nd_mn_t')) fail(`${TO}: downloading the ${FROM} backup #${seeded.db.backupId} answered ${dl.status} (${body.length} bytes, nd_mn_t ${body.includes('nd_mn_t') ? 'present' : 'absent'})`);
    step(`${TO}: node database #${id} start ${start.status} and backup ${backup.status} refused; nothing on the panel host; ${container} keeps nd_mn_t on the node (runbook: docker exec ${container} psql); the ${FROM} backup downloads (${body.length} bytes)`);
  }

  const volumes = nodeDaemon(['volume', 'ls', '--filter', 'label=ninedeploy.managed=volume', '--format', '{{.Name}}']);
  if (volumes.status !== 0 || !volumes.stdout.split(/\s+/).includes(seeded.volume)) fail(`${TO}: runbook "docker volume ls --filter label=ninedeploy.managed=volume" on the node does not list ${seeded.volume}: ${volumes.all.slice(0, 200)}`);
  const images = nodeDaemon(['image', 'ls', 'ninedeploy/*', '--format', '{{.Repository}}:{{.Tag}}']);
  if (images.status !== 0 || !images.stdout) fail(`${TO}: runbook "docker image ls 'ninedeploy/*'" on the node listed nothing: ${images.all.slice(0, 200)}`);
  step(`${TO}: runbook on the node: managed volumes list ${seeded.volume}; build images: ${images.stdout.split(/\s+/).length}`);

  if (seeded.swarm) {
    const { svcId, hostname, stack, slug } = seeded.swarm;
    const traefikNow = panelDaemon(['inspect', '-f', '{{.Id}}', 'ninedeploy-traefik']).stdout;
    if (traefikNow === seeded.traefikId) {
      const code = await routeServes(DIND, hostname, `${TO}: Swarm route before any deploy`, { ms: 30_000 });
      step(`${TO}: Traefik untouched (${traefikNow.slice(0, 12)}); the Swarm stack still answers for ${hostname} (${code})`);
    } else {
      step(`${TO}: Traefik was recreated at boot (${seeded.traefikId.slice(0, 12)} → ${traefikNow.slice(0, 12)}); ROLLBACK.md: the Swarm route needs the redeploy below`);
    }
    const orch = await api('/v1/orchestrators');
    if (orch.status !== 200 || !orch.json?.orchestrators?.some((o) => o.stacks?.some((s) => s.name === stack))) fail(`${TO}: /v1/orchestrators does not list ${stack}: ${short(orch)}`);
    await deploy(svcId, `${TO}: the Swarm service's next deploy`);
    const after = await serviceRow(svcId);
    if (!containerRunning(panelDaemon, after.runtimeId)) fail(`${TO}: the redeployed Swarm service is not a running container (${after.runtimeId})`);
    await routeServes(DIND, hostname, `${TO}: route after the redeploy`);
    const stacks = panelDaemon(['stack', 'ls', '--format', '{{.Name}}']).stdout.split(/\s+/);
    if (!stacks.includes(stack)) fail(`${TO}: docker stack ls does not list ${stack} (it should keep running unrouted): ${stacks.join(', ')}`);
    // docs/ROLLBACK.md: remove the stack once the container is live, then its overlay.
    const rm = panelDaemon(['stack', 'rm', stack]);
    if (rm.status !== 0) fail(`${TO}: runbook "docker stack rm ${stack}" failed: ${rm.all.slice(0, 300)}`);
    const network = `nd-swarm-${slug}`;
    panelDaemon(['network', 'disconnect', network, 'ninedeploy-traefik']);
    const netGone = await until(() => {
      const r = panelDaemon(['network', 'rm', network]);
      return r.status === 0 || /not found/i.test(r.all) ? r : null;
    }, { ms: 60_000, every: 3000 });
    if (!netGone) fail(`${TO}: runbook "docker network rm ${network}" kept failing: ${panelDaemon(['network', 'rm', network]).all.slice(0, 300)}`);
    await routeServes(DIND, hostname, `${TO}: route after the runbook`);
    step(`${TO}: /v1/orchestrators lists ${stack}; the next deploy runs it as container ${after.runtimeId} and the route follows; the runbook (stack rm, disconnect Traefik, network rm) leaves it serving`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const title = MODE === 'fresh' ? `fresh ${CANDIDATE_IMAGE}` : `${MODE} ${image(FROM)} → ${image(TO)}`;
  console.log(`Multi-node smoke (${title})`);
  step(`topology: network ${NET}; panel ${PANEL} (:${PANEL_PORT}) on ${DIND}; node ${NODE} with agent ${AGENT}; git ${GIT}`);
  step(`agent capability floors: multi-node v${AGENT_MULTI_NODE}, databases v${AGENT_DB_MANAGE}, Swarm v${AGENT_SWARM}`);

  // Every published image up front, so a missing one fails with its name.
  for (const ref of [DIND_IMAGE, APP_IMAGE]) pullOrFail(ref, 'the smoke needs it');
  for (const tag of MODE === 'fresh' ? [] : [FROM, TO]) {
    const ref = image(tag);
    if (ref.startsWith('ghcr.io/')) pullOrFail(ref, `${tag} is a published release`);
  }

  docker(['network', 'create', NET]);
  for (const v of VOLUMES) docker(['volume', 'create', v]);
  await startDind(DIND, `${DATA}:/data`);
  await startDind(NODE, `${AGENT_DATA}:${AGENT_HOME}`);
  const ctx = { panelDindIp: ipOn(DIND), nodeIp: ipOn(NODE) };
  ctx.gitIp = await startGitServer();
  step(`DinD: panel ${ctx.panelDindIp}, node ${ctx.nodeIp}`);

  const firstTag = MODE === 'fresh' ? null : FROM;
  const firstVersion = MODE === 'fresh' ? CANDIDATE_VERSION : bare(FROM);
  startPanel(firstTag);
  await waitHealthy(firstVersion);
  await register();
  await checkGitServer(ctx.gitIp);

  if (MODE === 'fresh') {
    section('enrolment');
    Object.assign(ctx, await enrolNode(CANDIDATE_IMAGE, ctx.nodeIp, 'enrolment'));
    await currentAgentView(ctx.serverId, { swarm: false });
    const img = await nodeImageService(ctx, 'fresh');
    ctx.imgId = img.id;
    await nodeFeatureSuite(ctx);
  } else if (MODE === 'upgrade') {
    section(`${FROM} panel and agent`);
    Object.assign(ctx, await enrolNode(image(FROM), ctx.nodeIp, `${FROM} enrolment`));
    const img = await nodeImageService(ctx, FROM);
    ctx.imgId = img.id;
    ctx.sourceId = await patSource('from');
    docker(['stop', PANEL]);
    const before = await inspectDb(migrationQueries);
    step(`${FROM} db: ${n(before.migrations)} migrations recorded`);

    startPanel(TO);
    await waitHealthy(bare(TO));
    await login();
    // The FROM panel had no capability columns: one /test fills them (and marks the node online).
    await waitAgent(ctx.serverId, `${TO} with the ${FROM} agent`);
    step(`${TO} up on the same volume; the operator signs in; the ${FROM} agent answers /test`);
    // The FROM agent keeps running: the image service redeploys unchanged.
    const old = await serviceRow(ctx.imgId);
    await deploy(ctx.imgId, `${TO} with the ${FROM} agent: node image service`);
    const now = await serviceRow(ctx.imgId);
    if (!containerRunning(nodeDaemon, now.runtimeId)) fail(`${TO}: the redeployed node image service is not running on the node`);
    await routeServes(ctx.nodeIp, img.hostname, `${TO}: node proxy after the redeploy`);
    step(`${TO} redeployed node image service #${ctx.imgId} through the ${FROM} agent (${old.runtimeId} → ${now.runtimeId}), still routed`);
    await outdatedAgentChecks(ctx);

    section(`agent updated to ${TO}`);
    startAgent(image(TO), ctx.tokenSha256);
    await waitAgent(ctx.serverId, `agent ${TO}`);
    await currentAgentView(ctx.serverId, { swarm: false });
    await nodeFeatureSuite(ctx);
  } else {
    section(`${FROM} panel and agent`);
    Object.assign(ctx, await enrolNode(image(FROM), ctx.nodeIp, `${FROM} enrolment`));
    const img = await nodeImageService(ctx, FROM);
    ctx.imgId = img.id;
    const seeded = await seedForRollback(ctx);
    docker(['stop', PANEL]);

    startPanel(TO);
    await waitHealthy(bare(TO));
    await login();
    step(`${TO} boots on the ${FROM} data; the operator signs in; the ${FROM} agent keeps running`);
    await rollbackChecks(ctx, seeded);
  }

  docker(['stop', PANEL]);
  const lastVersion = MODE === 'rollback' ? bare(TO) : CANDIDATE_VERSION;
  const post = await inspectDb({
    ...migrationQueries,
    transfers: "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'image_transfers'",
    transferRows: 'SELECT count(*) AS n FROM image_transfers',
    // docs/ROLLBACK.md: the runbook's query for databases placed on nodes.
    nodeDatabases: 'SELECT id, name, server_id, node_container_name FROM databases WHERE server_id IS NOT NULL',
  });
  if (n(post.distinct) !== n(post.migrations)) fail('a migration was recorded twice');
  if (MODE !== 'rollback' && n(post.migrations) !== journal.entries.length) fail(`${n(post.migrations)} migrations recorded, the journal has ${journal.entries.length}`);
  if (MIGRATION_0072 && n(post.m0072) !== 1) fail(`migration 0072 is recorded ${n(post.m0072)} time(s) on ${lastVersion} (wanted 1)`);
  if (n(post.transfers) !== 1) fail(`the image_transfers table is missing on ${lastVersion}`);
  const wantDbs = candidateHas(AGENT_DB_MANAGE) ? 1 : 0;
  if (post.nodeDatabases.length !== wantDbs) fail(`the runbook query lists ${post.nodeDatabases.length} node database(s) (wanted ${wantDbs}): ${JSON.stringify(post.nodeDatabases)}`);
  step(`${lastVersion} db: ${n(post.migrations)} migrations, each once; 0072 recorded once; image_transfers holds ${n(post.transferRows)} row(s); the runbook query lists ${post.nodeDatabases.length} node database(s)`);

  const summary = {
    fresh: `the candidate panel and agent enrol, deploy, build and clone on the node, ship images both ways, back up and restore node volumes and databases, refuse what a node cannot do${NO_SWARM ? '' : ', and run Swarm'}${WITH_BUILDS ? '; Nixpacks and Railpack build on the node' : ''}`,
    upgrade: `${FROM} → ${TO} keeps the node service, refuses every newer feature with the ${FROM} agent, and runs them all once the agent is updated`,
    rollback: `${FROM} → ${TO} keeps 0072, redeploys the image service through the newer agent, refuses the rest without touching their containers or the panel host, and the runbook cleans up`,
  }[MODE];
  console.log(`\n✓ Multi-node green (${MODE}${WITH_BUILDS ? ', with builds' : ''}${NO_SWARM ? ', no Swarm' : ''}): ${summary}`);
}

function cleanup() {
  for (const c of CONTAINERS) if (owned(c)) docker(['rm', '-f', '-v', c], { allowFail: true });
  for (const v of VOLUMES) if (owned(v)) docker(['volume', 'rm', v], { allowFail: true });
  if (owned(NET)) docker(['network', 'rm', NET], { allowFail: true });
}

main()
  .catch((err) => { console.error(`\n✗ multi-node smoke aborted: ${err?.message ?? err}`); process.exitCode = 1; })
  .finally(cleanup);
