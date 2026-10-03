import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';

/**
 * Egress IP HTTP surface — Sprint 5, Gap G-15 (PR #22).
 *
 * Read + write endpoints for the active `IEgressIpDriver`. Mounted
 * under `/v1/egress` and protected by `app.authenticate`. The
 * `egress.list()` endpoint returns the merged view of every rule
 * every registered driver has; the `egress.set()` / `egress.clear()`
 * pair targets a single project on the first registered driver
 * (operators on a multi-driver install pick the driver per-project
 * via the `?driver=<name>` query parameter).
 */
const DEFAULT_DRIVER = 'iptables';

export const egressRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // Drivers mutate host-level SNAT/iptables state and their rule list exposes
  // instance networking topology. This is not a project-member capability.
  app.addHook('preHandler', app.requireOperator);

  // Pull the named driver (or the first registered one) from the
  // kernel's IServiceRegistry.
  const pick = (name?: string) => {
    if (name) return app.kernel.registry.getEgressIpDriver(name);
    return app.kernel.registry.listEgressIpDrivers()[0];
  };

  app.get('/', async () => {
    const drivers = app.kernel.registry.listEgressIpDrivers();
    const all = await Promise.all(drivers.map(async (d) => ({ name: d.name, rules: await d.list() })));
    return { drivers: all };
  });

  app.post<{ Body: { projectId: number; ip: string; driver?: string; sourceCidr?: string } }>('/', async (req) => {
    const { projectId, ip, driver, sourceCidr } = req.body ?? ({} as Record<string, unknown>);
    if (typeof projectId !== 'number') {
      return { ok: false, error: '`projectId` is required (number)' };
    }
    if (typeof ip !== 'string' || ip.length === 0) {
      return { ok: false, error: '`ip` is required (string)' };
    }
    // r240: an explicit source network, for hosts where the project's
    // bridges cannot be resolved (or to scope the rule more narrowly).
    if (sourceCidr !== undefined && (typeof sourceCidr !== 'string' || !/^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(sourceCidr))) {
      return { ok: false, error: '`sourceCidr` must be an IPv4 CIDR such as 172.20.0.0/16' };
    }
    const d = pick(driver);
    if (!d) {
      return { ok: false, error: `Egress IP driver "${driver ?? DEFAULT_DRIVER}" is not registered` };
    }
    const rule = await d.attach(sourceCidr ? { projectId, sourceCidr } : { projectId }, ip);
    // r199: host-level SNAT changes were the one operator mutation with no
    // audit trail (and so no notification / live-feed event either).
    void audit(app.db, req.user?.id ?? null, 'egress.attach', `project:${projectId}`, { ip, driver: d.name }, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { ok: true, driver: d.name, rule };
  });

  app.delete<{ Params: { projectId: string }; Querystring: { driver?: string } }>('/:projectId', async (req) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) {
      return { ok: false, error: '`projectId` must be a number' };
    }
    // r199: the documented `?driver=<name>` override was ignored here, so on
    // a multi-driver install a rule attached via `--driver cloud-nat` could
    // never be detached — DELETE always hit the first driver.
    const driver = typeof req.query?.driver === 'string' && req.query.driver ? req.query.driver : undefined;
    const d = pick(driver);
    if (!d) {
      return { ok: false, error: driver ? `Egress IP driver "${driver}" is not registered` : 'No egress IP driver is registered' };
    }
    await d.detach({ projectId });
    void audit(app.db, req.user?.id ?? null, 'egress.detach', `project:${projectId}`, { driver: d.name }, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return { ok: true, driver: d.name };
  });
};
