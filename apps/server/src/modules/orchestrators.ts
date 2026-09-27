import type { FastifyPluginAsync } from 'fastify';
import { badRequest } from '../lib/errors.js';

/** Stack and orchestrator names reach fs path joins inside the drivers
 *  (`join(STACK_ROOT, name, …)` + readFileSync). The drivers themselves
 *  create names via slugify, so anything outside this shape is not a stack
 *  this panel made — refuse it rather than read outside STACK_ROOT. */
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * Orchestrator HTTP surface — Sprint 4, Gap G-10 (PR-A).
 *
 * Two read-only endpoints, mounted under `/v1/orchestrators`:
 *
 *   - `GET /` returns every registered orchestrator with the list
 *     of stacks the driver reports. The shape is a flat array so
 *     the panel can render a single table.
 *   - `GET /:name/stacks` lists the stacks the named orchestrator knows about.
 *   - `GET /:name/stacks/:stack` returns the per-service status of ONE stack
 *     on that orchestrator.
 *
 * r036: the status route used to be `GET /:name/stacks` with a single path
 * parameter, and it passed the ORCHESTRATOR name to `getStackStatus()` as the
 * STACK name — so it could only ever ask for a stack called `swarm` on the
 * orchestrator `swarm`, and answered `null` for every real stack. A test had
 * pinned that behaviour ("passes the orchestrator name as the stack name")
 * instead of fixing it. The stack is now addressed by its own segment, and the
 * plural path means what its name says.
 *
 * The orchestrator is the source of truth for the I/O. This module
 * is the source of truth for the HTTP shape.
 */

export const orchestratorsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // Operator-only: both endpoints execute host Docker daemon commands
  // (`docker stack ls` / `docker service ls` / `docker compose ps`) on the
  // panel's own daemon — the same host-privilege trust boundary the exec
  // terminal and container diagnostics enforce.
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async () => {
    const drivers = app.kernel.registry.listOrchestrators();
    const orchestrators = await Promise.all(
      drivers.map(async (driver) => ({
        name: driver.name,
        stacks: await driver.listStacks(),
      })),
    );
    return { orchestrators };
  });

  app.get<{ Params: { name: string } }>('/:name/stacks', async (req) => {
    const driver = app.kernel.registry.getOrchestrator(req.params.name);
    if (!driver) {
      return { error: `Orchestrator "${req.params.name}" is not registered` };
    }
    return { stacks: await driver.listStacks() };
  });

  app.get<{ Params: { name: string; stack: string } }>('/:name/stacks/:stack', async (req) => {
    const driver = app.kernel.registry.getOrchestrator(req.params.name);
    if (!driver) {
      return { error: `Orchestrator "${req.params.name}" is not registered` };
    }
    if (!NAME_RE.test(req.params.stack)) throw badRequest('invalid stack name');
    return await driver.getStackStatus(req.params.stack);
  });
};
