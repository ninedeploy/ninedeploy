import { eq } from 'drizzle-orm';
import { servers, users } from '@ninedeploy/db';
import { swarmInit, swarmSettings, type SwarmStatus } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { type AgentCaller, capabilityRefusal, nodeLabel } from '../lib/agentCapabilities.js';
import { audit } from '../lib/audit.js';
import { HttpError, notFound, parseId } from '../lib/errors.js';
import { capture, run, sleep } from '../lib/exec.js';
import { assertStepUp } from '../lib/stepUp.js';
import {
  encryptedOverlayRefusal,
  exactSwarmNode,
  isLocalInterfaceAddr,
  localSwarmInfo,
  parseSwarmInfo,
  RE_SWARM_NODE_ID,
  rotateWorkerJoinToken,
  SWARM_MANAGER_PORT,
  SWARM_MEMBER_LABEL,
  setSwarmAdvertiseAddr,
  setSwarmEnabled,
  swarmEnabled,
  swarmManagerAddr,
  swarmStatusView,
  updateNodeLabel,
  verifyJoinedNode,
  workerJoinToken,
} from '../lib/swarm.js';

/**
 * Swarm (multi-node, opt-in per service, sequenced last — owner decision O4).
 *
 * Design: .temp_files/run_0.16/DESIGN.md §7.2, §7.5, §7.6. Contract:
 * `@ninedeploy/schemas` multiNode.ts (`swarmInit`, `swarmSettings`,
 * `swarmStatus`). Registered in `modules/api.ts` (mount point M1).
 *
 * Every route is operator-only: Swarm is an instance resource on the panel
 * host's own daemon. The panel never initialises Swarm on its own — only
 * `POST /v1/swarm/init`, from an interactive operator session that re-proves
 * the password (step-up). Join tokens are read on the panel, sent to a node
 * sealed, never stored, logged, audited or returned, and rotated after every
 * join and leave. Membership is a node label the panel sets (`nd.member=1`)
 * only on nodes it joined and verified, and every Swarm service requires it.
 * Every mutation is audited.
 */

const READ_TIMEOUT_MS = 30_000;
/** Design §7.2: leave waits this long for a drained node's tasks to move. */
export const SWARM_DRAIN_WAIT_MS = 5 * 60_000;
const NODE_DOWN_WAIT_MS = 30_000;
const POLL_MS = 5000;
/** GET /v1/swarm asks each linked node for its swarm state; a node that does not answer in time gets no warning. */
const NODE_INFO_TIMEOUT_MS = 5000;
/** The agent's opt-in (review M2): unset, the node never joins a swarm. */
export const AGENT_SWARM_MANAGER_VAR = 'NINEDEPLOY_AGENT_SWARM_MANAGER';
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const maskToken = (s: string) => s.replace(/SWMTKN-1-[a-z0-9-]+/g, 'SWMTKN-1-***');

const ROTATION_WARNING =
  'The Swarm worker join token could not be rotated; rotate it by hand on the panel host (docker swarm join-token --rotate worker).';

/**
 * Instance-wide routes under `/v1/swarm` (operator only, no PREFIX_SCOPES
 * entry): `GET /`, `POST /init` (interactive + step-up) and `PUT /settings`
 * (step-up to enable).
 */
export const swarmRoutes: FastifyPluginAsync = async (app) => {
  const operator = { onRequest: [app.authenticate], preHandler: app.requireOperator };

  app.get('/', operator, async (): Promise<SwarmStatus> => {
    const status = await swarmStatusView(app.db);
    // Review M2: ask each linked node's agent (sealed, best effort, bounded) whether its owner switched
    // the Docker socket off while the node is still in the swarm. Shown as a warning; nothing leaves.
    const nodes = await Promise.all(
      status.nodes.map(async (n) => {
        if (n.serverId == null) return n;
        const warning = await socketOffWarning(n.serverId, n.hostname);
        return warning ? { ...n, warnings: [warning] } : n;
      }),
    );
    return { ...status, nodes };
  });

  async function socketOffWarning(serverId: number, hostname: string): Promise<string | null> {
    const lines: string[] = [];
    const ask = agentOp(app.db, serverId, 'swarm.info', {}, (l) => lines.push(l)).then(
      () => true,
      () => false,
    );
    let timer: NodeJS.Timeout | undefined;
    const answered = await Promise.race([ask, new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), NODE_INFO_TIMEOUT_MS)))]);
    clearTimeout(timer);
    if (!answered) return null;
    const line = lines.map((l) => l.trim()).filter((l) => l.startsWith('{')).at(-1);
    try {
      if ((JSON.parse(line ?? '') as { NdDockerSocketOff?: unknown }).NdDockerSocketOff !== true) return null;
    } catch {
      return null;
    }
    return (
      `The agent on node ${hostname || `#${serverId}`} has NINEDEPLOY_AGENT_DOCKER_SOCKET=off, but the node is still in the swarm, ` +
      `where the manager can still schedule tasks on it. Make it leave (POST /v1/servers/${serverId}/swarm/leave), or switch the socket back on.`
    );
  }

  app.post('/init', { onRequest: [app.authenticate], preHandler: [app.requireOperator, app.requireInteractive] }, async (req): Promise<SwarmStatus> => {
    const input = swarmInit.parse(req.body ?? {});
    const row = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
    if (!row) throw new HttpError(401, 'unauthorized', 'Unauthorized');
    await assertStepUp(app.db, req, row, input.password);
    const info = await localSwarmInfo();
    if (info.localState === 'unreachable') throw new HttpError(502, 'docker_unreachable', 'The Docker daemon on the panel host did not answer.');
    if (info.localState !== 'inactive') {
      throw new HttpError(
        409,
        'swarm_already_active',
        `The panel host's Docker daemon is already in a swarm (state: ${info.localState}); NineDeploy initialises a new swarm only. Use it as is, or leave it first (docker swarm leave).`,
      );
    }
    // Review M1b: bind the management port to the advertised address when it
    // is one of this host's own; otherwise (a docker install sees only its
    // container's interfaces, or a NAT address) keep Docker's default bind and
    // say that 2377 must be firewalled to the cluster's hosts.
    const warnings: string[] = [];
    const bindLocal = isLocalInterfaceAddr(input.advertiseAddr);
    const listen = input.advertiseAddr.includes(':') ? `[${input.advertiseAddr}]:${SWARM_MANAGER_PORT}` : `${input.advertiseAddr}:${SWARM_MANAGER_PORT}`;
    if (!bindLocal) {
      warnings.push(
        `${input.advertiseAddr} is not an interface address the panel can see, so the swarm management port ${SWARM_MANAGER_PORT}/tcp listens on every interface. Firewall ${SWARM_MANAGER_PORT}/tcp (and 7946/tcp+udp, 4789/udp, ESP) to the cluster's own hosts.`,
      );
    }
    try {
      // The output carries the worker join command (with its token): discarded, never logged.
      await capture('docker', ['swarm', 'init', '--advertise-addr', input.advertiseAddr, ...(bindLocal ? ['--listen-addr', listen] : [])], { timeoutMs: 120_000 });
    } catch (err) {
      throw new HttpError(502, 'swarm_init_failed', `docker swarm init failed: ${maskToken(msg(err))}`);
    }
    await setSwarmAdvertiseAddr(app.db, input.advertiseAddr);
    // Review M1c: the panel host's own node is a member; services require the label.
    const after = await localSwarmInfo();
    if (!after.nodeId || !(await updateNodeLabel(after.nodeId, '--label-add', `${SWARM_MEMBER_LABEL}=1`))) {
      warnings.push(`The panel host's swarm node could not be labelled ${SWARM_MEMBER_LABEL}=1; Swarm services cannot run until it is (it is retried at every deploy).`);
    }
    void audit(
      app.db,
      req.user!.id,
      'swarm.init',
      input.advertiseAddr,
      { advertiseAddr: input.advertiseAddr, listenAddr: bindLocal ? listen : null },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    // Swarm services route only over encrypted overlays: say now if this daemon cannot create one.
    const overlay = await encryptedOverlayRefusal();
    if (overlay) throw new HttpError(502, 'swarm_overlay_unavailable', `Swarm was initialised on the panel host, but it cannot run NineDeploy services yet. ${overlay}`);
    return { ...(await swarmStatusView(app.db)), ...(warnings.length > 0 ? { warnings } : {}) };
  });

  app.put('/settings', operator, async (req): Promise<SwarmStatus> => {
    const input = swarmSettings.parse(req.body ?? {});
    const previous = await swarmEnabled(app.db);
    if (input.enabled && !previous) {
      const row = await app.db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
      if (!row) throw new HttpError(401, 'unauthorized', 'Unauthorized');
      await assertStepUp(app.db, req, row, input.password);
      const info = await localSwarmInfo();
      if (info.localState !== 'active' || !info.controlAvailable) {
        throw new HttpError(
          409,
          'swarm_not_manager',
          `Swarm can be enabled only on an active manager; the panel host's daemon is ${info.localState}${info.localState === 'active' ? ' but not a manager' : ''}. Initialise it first (POST /v1/swarm/init).`,
        );
      }
    }
    if (input.enabled !== previous) await setSwarmEnabled(app.db, input.enabled);
    void audit(app.db, req.user!.id, 'swarm.settings', input.enabled ? 'enabled' : 'disabled', { enabled: input.enabled, previous }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return swarmStatusView(app.db);
  });
};

/**
 * Per-node routes under `/v1/servers` (operator only):
 * `POST /:id/swarm/join` and `POST /:id/swarm/leave`, through the node's
 * agent (capability `swarm`, sealed transport). An older agent gets 422
 * `node_agent_outdated` after one `agent.ping`, with nothing changed; a
 * current agent whose owner has not opted in gets 422 naming the variable.
 */
export const serverSwarmRoutes: FastifyPluginAsync = async (app) => {
  const operator = { onRequest: [app.authenticate], preHandler: app.requireOperator };

  /** The node row and its agent, after the capability check (sealed, `swarm`). */
  const swarmNode = async (id: number, feature: string) => {
    const node = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
    if (!node) throw notFound('Server not found');
    const agent: AgentCaller = (op, params, sink) => agentOp(app.db, id, op, params, sink);
    const label = await nodeLabel(app.db, id);
    const refusal = await capabilityRefusal(agent, label, await agentTransportSealed(app.db, id).catch(() => false), {
      cap: 'swarm',
      feature,
      sealedRequired: true,
      persist: { db: app.db, serverId: id },
    });
    if (refusal?.code === 'node_feature_disabled') {
      // Review M2: Swarm is opt-in on the node; say exactly what to set.
      const managerAddr = (await swarmManagerAddr(app.db).catch(() => null)) ?? `<the panel's advertise address>:${SWARM_MANAGER_PORT}`;
      throw new HttpError(
        422,
        'node_swarm_not_enabled',
        `The agent on node ${label} does not accept Swarm membership: it is opt-in on the node. Set ${AGENT_SWARM_MANAGER_VAR}=${managerAddr} in the agent's environment, restart the agent, and retry.`,
      );
    }
    if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
    return { node, agent, label };
  };

  /** Run an agent op, folding its (already masked) output into the error. */
  const nodeOp = async (agent: AgentCaller, op: string, params: Record<string, unknown>, what: string): Promise<string[]> => {
    const lines: string[] = [];
    try {
      await agent(op, params, (l) => lines.push(l));
    } catch (err) {
      const detail = maskToken(`${msg(err)} ${lines.join(' ')}`).slice(0, 600);
      throw new HttpError(502, 'node_swarm_failed', `${what} failed on the node: ${detail}`);
    }
    return lines;
  };

  app.post('/:id/swarm/join', operator, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const existing = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
    if (!existing) throw notFound('Server not found');
    if (existing.swarmNodeId) {
      throw new HttpError(409, 'swarm_already_joined', `Node "${existing.name}" already joined the swarm (node ${existing.swarmNodeId}); leave first to rejoin.`);
    }
    // The node first: an older agent is refused (one agent.ping) before the panel host is asked anything.
    const { node, agent } = await swarmNode(id, 'join the Swarm');
    const info = await localSwarmInfo();
    if (info.localState !== 'active' || !info.controlAvailable) {
      throw new HttpError(409, 'swarm_not_manager', `Nodes join the panel host's swarm; the panel host is ${info.localState}${info.localState === 'active' ? ' but not a manager' : ''}. Initialise Swarm first (POST /v1/swarm/init).`);
    }
    const managerAddr = await swarmManagerAddr(app.db, info);
    if (!managerAddr) throw new HttpError(409, 'swarm_not_manager', 'The swarm has no manager address to join; initialise Swarm from the panel (POST /v1/swarm/init).');
    // Nothing joins a swarm whose services could not get an encrypted overlay.
    const overlay = await encryptedOverlayRefusal();
    if (overlay) throw new HttpError(502, 'swarm_overlay_unavailable', `Node "${node.name}" was not joined. ${overlay}`);
    const token = await workerJoinToken();
    let rotated = false;
    try {
      await nodeOp(agent, 'swarm.join', { token, managerAddr }, 'Joining the swarm');
    } finally {
      // Review M1a: the token that left the panel is dead from here on, whether or not the join worked.
      rotated = await rotateWorkerJoinToken();
      if (!rotated) {
        void audit(app.db, req.user!.id, 'alert.swarm_token_rotation_failed', node.name, { serverId: id }, { ip: req.ip, userAgent: req.headers['user-agent'] });
      }
    }
    const warnings = rotated ? [] : [ROTATION_WARNING];
    const nodeInfo = parseSwarmInfo((await nodeOp(agent, 'swarm.info', {}, 'Reading the node’s swarm state')).join('\n'));
    // Review M3: the reported id is a claim; the manager confirms it before anything links or labels it.
    const verified = await verifyJoinedNode(app.db, { id, host: node.host }, nodeInfo.nodeId);
    if ('refusal' in verified) {
      const refusal = verified.refusal;
      void audit(app.db, req.user!.id, 'server.swarm.join_refused', node.name, { serverId: id, reason: refusal, tokenRotated: rotated }, { ip: req.ip, userAgent: req.headers['user-agent'] });
      throw new HttpError(
        502,
        'swarm_node_unverified',
        `Node "${node.name}" was not linked: ${refusal}. It runs no NineDeploy task (it carries no ${SWARM_MEMBER_LABEL} label); check docker node ls on the panel host and remove the node there if it is not yours.`,
      );
    }
    // The manager's full id, never the reported string, from here on.
    const nodeId = verified.nodeId;
    const labelled = await updateNodeLabel(nodeId, '--label-add', `${SWARM_MEMBER_LABEL}=1`);
    if (!labelled) warnings.push(`The node joined but could not be labelled ${SWARM_MEMBER_LABEL}=1, so it runs no Swarm task yet; leave and join again.`);
    await app.db.update(servers).set({ swarmNodeId: nodeId, swarmRole: 'worker' }).where(eq(servers.id, id));
    // Never the token: the node, its swarm id and the manager it joined.
    void audit(
      app.db,
      req.user!.id,
      'server.swarm.join',
      node.name,
      { serverId: id, nodeId, managerAddr, tokenRotated: rotated, memberLabel: labelled },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    return { serverId: id, nodeId, role: 'worker' as const, ...(warnings.length > 0 ? { warnings } : {}) };
  });

  app.post('/:id/swarm/leave', operator, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const existing = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
    if (!existing) throw notFound('Server not found');
    const nodeId = existing.swarmNodeId;
    if (!nodeId) throw new HttpError(409, 'swarm_not_joined', `Node "${existing.name}" is not in the swarm.`);
    if (!RE_SWARM_NODE_ID.test(nodeId)) throw new HttpError(409, 'swarm_not_joined', `Node "${existing.name}" carries an invalid swarm node id; clear it by hand.`);
    const { node, agent } = await swarmNode(id, 'leave the Swarm');
    // Review M3: Docker also resolves a node by its hostname or an id prefix. Every
    // docker node command below acts only while the manager knows THIS full id, so a
    // node gone from the swarm is never confused with another whose name is that id.
    const known = await exactSwarmNode(nodeId);
    let drained = false;
    if (known) {
      // Review M1c: no longer a member first (no new task lands there), then drain (design §7.2).
      await updateNodeLabel(nodeId, '--label-rm', SWARM_MEMBER_LABEL);
      await run('docker', ['node', 'update', '--availability', 'drain', '--', nodeId], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch((err: unknown) => {
        if (!/not found|no such node/i.test(msg(err))) throw new HttpError(502, 'swarm_drain_failed', `Could not drain node ${nodeId}: ${msg(err)}`);
      });
    } else {
      drained = true;
    }
    const drainDeadline = Date.now() + SWARM_DRAIN_WAIT_MS;
    while (known && Date.now() < drainDeadline) {
      const left = await capture('docker', ['node', 'ps', '--filter', 'desired-state=running', '-q', '--', nodeId], { timeoutMs: READ_TIMEOUT_MS }).catch(() => '');
      if (left.trim() === '') {
        drained = true;
        break;
      }
      await sleep(POLL_MS);
    }
    await nodeOp(agent, 'swarm.leave', {}, 'Leaving the swarm');
    const downDeadline = Date.now() + NODE_DOWN_WAIT_MS;
    let down = false;
    let present = known !== null;
    while (present && Date.now() < downDeadline) {
      const view = await exactSwarmNode(nodeId);
      present = view !== null;
      if (!view || view.state === 'down') {
        down = true;
        break;
      }
      await sleep(POLL_MS);
    }
    if (present) await run('docker', ['node', 'rm', ...(down ? [] : ['--force']), '--', nodeId], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
    await app.db.update(servers).set({ swarmNodeId: null, swarmRole: null }).where(eq(servers.id, id));
    // Review M1a: rotate after a leave too.
    const rotated = await rotateWorkerJoinToken();
    void audit(app.db, req.user!.id, 'server.swarm.leave', node.name, { serverId: id, nodeId, drained, tokenRotated: rotated }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { serverId: id, nodeId, drained, ...(rotated ? {} : { warnings: [ROTATION_WARNING] }) };
  });
};
