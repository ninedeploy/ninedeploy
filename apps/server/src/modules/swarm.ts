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
  localSwarmInfo,
  parseSwarmInfo,
  setSwarmAdvertiseAddr,
  setSwarmEnabled,
  swarmEnabled,
  swarmManagerAddr,
  swarmStatusView,
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
 * sealed, and never stored, logged, audited or returned. Every mutation is
 * audited.
 */

const READ_TIMEOUT_MS = 30_000;
/** Design §7.2: leave waits this long for a drained node's tasks to move. */
export const SWARM_DRAIN_WAIT_MS = 5 * 60_000;
const NODE_DOWN_WAIT_MS = 30_000;
const POLL_MS = 5000;
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Instance-wide routes under `/v1/swarm` (operator only, no PREFIX_SCOPES
 * entry): `GET /`, `POST /init` (interactive + step-up) and `PUT /settings`
 * (step-up to enable).
 */
export const swarmRoutes: FastifyPluginAsync = async (app) => {
  const operator = { onRequest: [app.authenticate], preHandler: app.requireOperator };

  app.get('/', operator, async (): Promise<SwarmStatus> => swarmStatusView(app.db));

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
    try {
      // The output carries the worker join command (with its token): discarded, never logged.
      await capture('docker', ['swarm', 'init', '--advertise-addr', input.advertiseAddr], { timeoutMs: 120_000 });
    } catch (err) {
      throw new HttpError(502, 'swarm_init_failed', `docker swarm init failed: ${msg(err).replace(/SWMTKN-1-[a-z0-9-]+/g, 'SWMTKN-1-***')}`);
    }
    await setSwarmAdvertiseAddr(app.db, input.advertiseAddr);
    void audit(app.db, req.user!.id, 'swarm.init', input.advertiseAddr, { advertiseAddr: input.advertiseAddr }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    // Swarm services route only over encrypted overlays: say now if this daemon cannot create one.
    const overlay = await encryptedOverlayRefusal();
    if (overlay) throw new HttpError(502, 'swarm_overlay_unavailable', `Swarm was initialised on the panel host, but it cannot run NineDeploy services yet. ${overlay}`);
    return swarmStatusView(app.db);
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
 * `node_agent_outdated` after one `agent.ping`, with nothing changed.
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
    if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
    return { node, agent, label };
  };

  /** Run an agent op, folding its (already masked) output into the error. */
  const nodeOp = async (agent: AgentCaller, op: string, params: Record<string, unknown>, what: string): Promise<string[]> => {
    const lines: string[] = [];
    try {
      await agent(op, params, (l) => lines.push(l));
    } catch (err) {
      const detail = `${msg(err)} ${lines.join(' ')}`.replace(/SWMTKN-1-[a-z0-9-]+/g, 'SWMTKN-1-***').slice(0, 600);
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
    await nodeOp(agent, 'swarm.join', { token, managerAddr }, 'Joining the swarm');
    const nodeInfo = parseSwarmInfo((await nodeOp(agent, 'swarm.info', {}, 'Reading the node’s swarm state')).join('\n'));
    if (!nodeInfo.nodeId) throw new HttpError(502, 'node_swarm_failed', 'The node joined but did not report its swarm node id; check `docker info` on the node.');
    await app.db.update(servers).set({ swarmNodeId: nodeInfo.nodeId, swarmRole: 'worker' }).where(eq(servers.id, id));
    // Never the token: the node, its swarm id and the manager it joined.
    void audit(app.db, req.user!.id, 'server.swarm.join', node.name, { serverId: id, nodeId: nodeInfo.nodeId, managerAddr }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { serverId: id, nodeId: nodeInfo.nodeId, role: 'worker' as const };
  });

  app.post('/:id/swarm/leave', operator, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const existing = await app.db.query.servers.findFirst({ where: eq(servers.id, id) });
    if (!existing) throw notFound('Server not found');
    const nodeId = existing.swarmNodeId;
    if (!nodeId) throw new HttpError(409, 'swarm_not_joined', `Node "${existing.name}" is not in the swarm.`);
    const { node, agent } = await swarmNode(id, 'leave the Swarm');
    // Drain first, so its tasks move to other nodes before it goes (design §7.2).
    await run('docker', ['node', 'update', '--availability', 'drain', nodeId], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch((err: unknown) => {
      if (!/not found|no such node/i.test(msg(err))) throw new HttpError(502, 'swarm_drain_failed', `Could not drain node ${nodeId}: ${msg(err)}`);
    });
    const drainDeadline = Date.now() + SWARM_DRAIN_WAIT_MS;
    let drained = false;
    while (Date.now() < drainDeadline) {
      const left = await capture('docker', ['node', 'ps', nodeId, '--filter', 'desired-state=running', '-q'], { timeoutMs: READ_TIMEOUT_MS }).catch(() => '');
      if (left.trim() === '') {
        drained = true;
        break;
      }
      await sleep(POLL_MS);
    }
    await nodeOp(agent, 'swarm.leave', {}, 'Leaving the swarm');
    const downDeadline = Date.now() + NODE_DOWN_WAIT_MS;
    let down = false;
    while (Date.now() < downDeadline) {
      const state = await capture('docker', ['node', 'inspect', '--format', '{{.Status.State}}', nodeId], { timeoutMs: READ_TIMEOUT_MS }).catch(() => 'down');
      if (state.trim() === 'down') {
        down = true;
        break;
      }
      await sleep(POLL_MS);
    }
    await run('docker', ['node', 'rm', ...(down ? [] : ['--force']), nodeId], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
    await app.db.update(servers).set({ swarmNodeId: null, swarmRole: null }).where(eq(servers.id, id));
    void audit(app.db, req.user!.id, 'server.swarm.leave', node.name, { serverId: id, nodeId, drained }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { serverId: id, nodeId, drained };
  });
};
