import { and, eq, inArray } from 'drizzle-orm';
import { domains, serviceTargets, services, type DB } from '@ninedeploy/db';
import { ERROR_PAGE_STATUSES } from '@ninedeploy/schemas';
import { agentTransportSealed } from './agentClient.js';
import { capabilityRefusal } from './agentCapabilities.js';
import { forwardAuthDomains } from './forwardAuth.js';
import { getErrorPages, getMaintenance, routingOverrides } from './maintenance.js';
import { maintenanceAnswer } from './maintenancePages.js';
import { NODE_PAGES_REPLY, type NodePagesWrite } from './nodePages.js';
import { getSettingString } from './settings.js';

/**
 * P2, panel side: ship a node the maintenance and error pages of the services
 * that run on it, and make sure its page server answers, BEFORE its proxy is
 * told to route to that server (lib/nodeProxy.ts). The proxy render routes a
 * node's pages only when this returned true for the same sync, so a node that
 * cannot serve them keeps routing its services to the app as before, and the
 * failure is reported instead of turning a site in maintenance into a bare 502.
 *
 * A node with no page to serve costs nothing: no agent call is made.
 */

type Call = (op: string, params: Record<string, unknown>, sink: (line: string) => void) => Promise<{ exitCode: number; lines: string[] }>;

/** The last outcome per node, read by the maintenance routes after their re-render. */
const outcomes = new Map<number, { ok: boolean; reason: string | null; serviceIds: number[] }>();
export function nodePagesOutcome(serverId: number): { ok: boolean; reason: string | null; serviceIds: number[] } | null {
  return outcomes.get(serverId) ?? null;
}
/** For tests. */
export function resetNodePagesOutcomes(): void { outcomes.clear(); }
/** Forget a node's last outcome, so only the next sync can answer for it. */
export function clearNodePagesOutcome(serverId: number): void { outcomes.delete(serverId); }

/**
 * Why the last sync of `serverId` did not put `serviceId`'s pages on the node,
 * or null when it did, or when the service has nothing to serve there (no
 * active domain). No outcome at all means the sync never reached its pages step.
 */
export async function nodePagesFailure(db: DB, serverId: number, serviceId: number): Promise<string | null> {
  const expected = (await nodePagesPayload(db, serverId)).some((p) => p.serviceId === serviceId);
  if (!expected) return null;
  const outcome = outcomes.get(serverId);
  if (outcome?.ok && outcome.serviceIds.includes(serviceId)) return null;
  return outcome?.reason ?? 'the node was not synced: it did not answer, or its routing write was refused';
}

/** The pages of every service on this node that has some: its own services only, never fan-out ones. */
export async function nodePagesPayload(db: DB, serverId: number): Promise<NodePagesWrite[]> {
  const overrides = await routingOverrides(db);
  const ids = [...new Set([...overrides.maintenance.keys(), ...overrides.errorPages.keys()])];
  if (ids.length === 0) return [];
  const rows = await db.select({ id: services.id }).from(services).where(and(inArray(services.id, ids), eq(services.serverId, serverId)));
  if (rows.length === 0) return [];
  const fanout = new Set((await db.select({ serviceId: serviceTargets.serviceId }).from(serviceTargets).where(inArray(serviceTargets.serviceId, rows.map((r) => r.id)))).map((t) => t.serviceId));
  const panel = String((await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? '').trim().toLowerCase();
  // Panel sign-in domains are never routed by a node proxy (G2.3), so they get no page there either.
  const signIn = await forwardAuthDomains(db);
  const out: NodePagesWrite[] = [];
  for (const { id } of rows) {
    if (fanout.has(id)) continue;
    const hosts = (await db.select({ id: domains.id, hostname: domains.hostname }).from(domains).where(and(eq(domains.serviceId, id), eq(domains.status, 'active'))))
      .filter((d) => !signIn.has(d.id))
      .map((d) => String(d.hostname ?? '').trim().toLowerCase())
      .filter((h) => h && h !== panel);
    if (hosts.length === 0) continue;
    const m = await getMaintenance(db, id);
    const custom = (await getErrorPages(db, id)).pages;
    const errors: NodePagesWrite['errors'] = {};
    for (const s of ERROR_PAGE_STATUSES) if (custom[s]) errors[s] = custom[s];
    out.push({
      serviceId: id,
      hosts: [...new Set(hosts)].slice(0, 200),
      maintenance: m ? { ...maintenanceAnswer(m), retryAfter: m.retryAfterSeconds } : null,
      errors,
    });
  }
  return out;
}

function reply(lines: string[]): { error?: { code: string; message: string } } | null {
  const line = lines.find((l) => l.startsWith(NODE_PAGES_REPLY));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(NODE_PAGES_REPLY.length)) as { error?: { code: string; message: string } };
  } catch {
    return null;
  }
}

/** Run one pages op; a refusal throws with the agent's own message. */
async function pagesOp(call: Call, op: string, params: Record<string, unknown>): Promise<void> {
  const lines: string[] = [];
  let failure: unknown = null;
  try {
    const res = await call(op, params, (line) => lines.push(line));
    for (const line of res.lines) if (!lines.includes(line)) lines.push(line);
  } catch (err) {
    failure = err;
  }
  const answer = reply(lines);
  if (answer?.error) throw new Error(answer.error.message);
  if (failure) throw failure;
  if (!answer) throw new Error(`The node did not answer ${op}`);
}

/**
 * Write the node's pages and ensure its page server. True only when every page
 * is written and the server answers; the caller then routes them. Never throws.
 */
export async function syncNodePages(db: DB, serverId: number, call: Call, log: (line: string) => void): Promise<boolean> {
  let payload: NodePagesWrite[];
  try {
    payload = await nodePagesPayload(db, serverId);
  } catch (err) {
    outcomes.set(serverId, { ok: false, reason: err instanceof Error ? err.message : String(err), serviceIds: [] });
    return false;
  }
  const serviceIds = payload.map((p) => p.serviceId);
  if (payload.length === 0) {
    outcomes.set(serverId, { ok: true, reason: null, serviceIds });
    return false;
  }
  try {
    const sealed = await agentTransportSealed(db, serverId);
    const refusal = await capabilityRefusal(call, `#${serverId}`, sealed, { cap: 'proxy.pages', feature: 'serve maintenance and error pages', sealedRequired: true });
    if (refusal) throw new Error(refusal.message);
    for (const p of payload) await pagesOp(call, 'proxy.pages.write', { ...p });
    await pagesOp(call, 'proxy.pages.prune', { keep: serviceIds });
    await pagesOp(call, 'proxy.pages.ensure', {});
    outcomes.set(serverId, { ok: true, reason: null, serviceIds });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    outcomes.set(serverId, { ok: false, reason, serviceIds });
    log(`⚠ node pages: node #${serverId} cannot serve maintenance and error pages (${reason}); its services keep routing to the app.`);
    return false;
  }
}
