import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { services, serviceTargets, type DB } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { replicaNames } from '../engine/dockerNames.js';
import { run } from '../lib/exec.js';
import { agentOp } from '../lib/agentClient.js';
import { listUserNetworks, networkMembers } from '../lib/inventory.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';
import {
  ManagedNamespaceError,
  isManagedContainer,
  isManagedNetwork,
} from '../lib/managedNamespace.js';

const noop = (): void => undefined;

const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Run an agent op, converting agent failures into a 400. */
async function agentOr400<T>(p: Promise<T>): Promise<T> {
  return p.catch((err) => {
    throw badRequest(err instanceof Error ? err.message : 'agent operation failed');
  });
}

const createBody = z.object({
  name: z.string().regex(RE_NAME).min(1).max(100),
  driver: z.enum(['bridge', 'overlay']).default('bridge'),
  /** Remote server (null/omitted = this host). */
  serverId: z.number().int().positive().nullish(),
});

const attachBody = z.object({
  network: z.string().regex(RE_NAME),
  container: z.string().regex(RE_NAME),
  serverId: z.number().int().positive().nullish(),
});

/**
 * Reject the request when the given network or container is NineDeploy-managed.
 * Throws `conflict()` (→ 409) so the UI surfaces a clear "protected" error
 * instead of the docker CLI's generic "has active endpoints" message.
 */
function guardManaged(network: string, container?: string): void {
  if (isManagedNetwork(network)) {
    throw new ManagedNamespaceError(
      'network',
      network,
      `Network '${network}' is managed by NineDeploy and cannot be removed or detached.`,
    );
  }
  if (container && isManagedContainer(container)) {
    throw new ManagedNamespaceError(
      'container',
      container,
      `Container '${container}' is managed by NineDeploy and cannot be attached/detached from user networks.`,
    );
  }
}

/** Current runtime names are placement records, not a reserved-name prefix. */
async function guardManagedRuntime(db: DB, input: z.infer<typeof attachBody>): Promise<void> {
  const serverId = input.serverId ?? null;
  const rows = await db.query.services.findMany({
    columns: { runtimeId: true, runtimeReplicas: true },
    where: and(eq(services.type, 'docker'), serverId === null ? isNull(services.serverId) : eq(services.serverId, serverId)),
  });
  const primary = rows.some((row) => row.runtimeId && replicaNames(row.runtimeId, row.runtimeReplicas).includes(input.container));
  const target = !primary && serverId !== null
    ? await db.query.serviceTargets.findFirst({
      columns: { id: true },
      where: and(eq(serviceTargets.serverId, serverId), eq(serviceTargets.runtimeId, input.container)),
    })
    : undefined;
  if (primary || target) {
    throw new ManagedNamespaceError(
      'container',
      input.container,
      `Container '${input.container}' is managed by NineDeploy and cannot be attached/detached from user networks.`,
    );
  }
}

/** Map a ManagedNamespaceError to a 409 — other errors pass through. */
function rethrowManaged(err: unknown): never {
  if (err instanceof ManagedNamespaceError) throw conflict(err.message);
  throw err;
}

/** Docker network management UI backend. Mounted under /networks. */
export const networkRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // List user-defined networks with their members.
  // L-12: network names plus their container members map out the whole
  // instance for any member. Create/attach/detach were already admin-only.
  app.get('/', { preHandler: [app.requireAdmin] }, async (req) => {
    const serverId = Number((req.query as { serverId?: string }).serverId);
    if (Number.isInteger(serverId) && serverId > 0) {
      // Remote hosts: the agent's typed op table currently has no network-list
      // op — report empty rather than pretending. Create/attach/detach work.
      return { networks: [], remote: serverId };
    }
    const networks = await listUserNetworks().catch(() => []);
    const withMembers = await Promise.all(
      networks.map(async (n) => ({
        ...n,
        isManaged: isManagedNetwork(n.name),
        members: await networkMembers(n.name).catch(() => []),
      })),
    );
    return { networks: withMembers, remote: null };
  });

  app.post('/', { preHandler: app.requireAdmin }, async (req) => {
    const input = createBody.parse(req.body);
    // Never let a user shadow the managed mesh by creating a network with the
    // same name — Docker would refuse, but we want a clear panel-side error.
    if (isManagedNetwork(input.name)) {
      throw conflict(`Network '${input.name}' is reserved by NineDeploy.`);
    }
    try {
      if (input.serverId != null) {
        await agentOr400(agentOp(app.db, input.serverId, 'docker.networkCreate', {
          name: input.name,
          driver: input.driver,
        }, noop));
      } else {
        await run('docker', ['network', 'create', '--driver', input.driver, input.name], {}, noop);
      }
    } catch (err) {
      rethrowManaged(err);
    }
    void audit(app.db, req.user!.id, 'network.create', input.name, { driver: input.driver });
    return { ok: true, name: input.name };
  });

  app.delete('/:name', { preHandler: app.requireAdmin }, async (req) => {
    const name = String((req.params as { name: string }).name);
    if (!RE_NAME.test(name)) throw badRequest('Invalid network name');
    const serverId = Number((req.query as { serverId?: string }).serverId);
    if (Number.isInteger(serverId) && serverId > 0) {
      // r471: collect the op's output lines — agentOp sinks them BEFORE it
      // throws, so a refused `network rm` still carries docker's own reason
      // ("has active endpoints"), which belongs in a 409 like the local
      // branch, not a bare "exited with 1" 400 the operator can't act on.
      const out: string[] = [];
      try {
        guardManaged(name);
        await agentOr400(agentOp(app.db, serverId, 'docker.networkRm', { name }, (l) => out.push(l)));
      } catch (err) {
        if (err instanceof ManagedNamespaceError) {
          void audit(app.db, req.user!.id, 'network.delete.blocked', name, { reason: err.message, serverId });
          throw conflict(err.message);
        }
        const reason = out.join(' ').slice(0, 400).trim();
        if (reason) throw conflict(reason);
        // No docker output → the agent itself was unreachable: a 400 with
        // the transport error, same as before.
        throw badRequest(err instanceof Error ? err.message : 'network remove failed');
      }
    } else {
      try {
        guardManaged(name);
        await run('docker', ['network', 'rm', name], {}, noop);
      } catch (err) {
        if (err instanceof ManagedNamespaceError) {
          void audit(app.db, req.user!.id, 'network.delete.blocked', name, { reason: err.message });
          throw conflict(err.message);
        }
        // "has active endpoints" is the common case — surface it as 409 so the
        // UI can show a "detach the containers first" hint rather than a
        // generic 500.
        throw conflict(err instanceof Error ? err.message : 'network remove failed');
      }
    }
    void audit(app.db, req.user!.id, 'network.delete', name);
    return { ok: true };
  });

  // Attach / detach a container to/from a network.
  app.post('/attach', { preHandler: app.requireAdmin }, async (req) => {
    const input = attachBody.parse(req.body);
    try {
      guardManaged(input.network, input.container);
      await guardManagedRuntime(app.db, input);
      if (input.serverId != null) {
        await agentOr400(agentOp(app.db, input.serverId, 'docker.networkConnect', {
          network: input.network,
          container: input.container,
        }, noop));
      } else {
        await run('docker', ['network', 'connect', input.network, input.container], {}, noop);
      }
    } catch (err) {
      if (err instanceof ManagedNamespaceError) {
        void audit(app.db, req.user!.id, 'network.attach.blocked', `${input.container} → ${input.network}`, {
          reason: err.message,
          serverId: input.serverId,
        });
        throw conflict(err.message);
      }
      rethrowManaged(err);
    }
    void audit(app.db, req.user!.id, 'network.attach', `${input.container} → ${input.network}`);
    return { ok: true };
  });

  app.post('/detach', { preHandler: app.requireAdmin }, async (req) => {
    const input = attachBody.parse(req.body);
    try {
      guardManaged(input.network, input.container);
      await guardManagedRuntime(app.db, input);
      if (input.serverId != null) {
        await agentOr400(agentOp(app.db, input.serverId, 'docker.networkDisconnect', {
          network: input.network,
          container: input.container,
        }, noop));
      } else {
        await run('docker', ['network', 'disconnect', input.network, input.container], {}, noop);
      }
    } catch (err) {
      if (err instanceof ManagedNamespaceError) {
        void audit(app.db, req.user!.id, 'network.detach.blocked', `${input.container} ↮ ${input.network}`, {
          reason: err.message,
          serverId: input.serverId,
        });
        throw conflict(err.message);
      }
      rethrowManaged(err);
    }
    void audit(app.db, req.user!.id, 'network.detach', `${input.container} ↮ ${input.network}`);
    return { ok: true };
  });

  // Member listing for one network (used by the attach/detach UI). Admin-only
  // like GET /networks above: container names on a network map out the whole
  // instance's inventory.
  app.get('/:name/members', { preHandler: [app.requireAdmin] }, async (req) => {
    const name = String((req.params as { name: string }).name);
    if (!RE_NAME.test(name)) throw badRequest('Invalid network name');
    try {
      return { members: await networkMembers(name) };
    } catch {
      return { members: [] };
    }
  });
};

/** Exposed for tests: validate a docker-CLI name operand. */
export const isValidNetworkName = (name: string): boolean => RE_NAME.test(name);
