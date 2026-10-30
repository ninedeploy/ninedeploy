import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import {
  metricRollups,
  metrics,
  projects,
  servers,
  serviceProjects,
  services,
  serviceWorkspaces,
  trafficRollups,
  workspaces,
  type DB,
} from '@ninedeploy/db';
import {
  type UsageCosts,
  type UsageCostsInput,
  type UsageFigures,
  type UsageGroupRow,
  type UsageReport,
  type UsageServerRow,
  type UsageServiceRow,
  usageCostsInput,
} from '@ninedeploy/schemas';
import { readObservabilitySettings } from './observabilitySettings.js';
import { DISK_SAMPLE_SECONDS } from './diskUsage.js';
import { getSettingJson, setSettingJson } from './settings.js';
import { trafficAnalyticsEnabled } from './trafficAnalytics.js';

/**
 * Usage and cost (ROADMAP item 9), read from what the panel already keeps:
 *
 * - Disk from the hourly samples of each service's volumes (lib/diskUsage.ts),
 *   through the same tables and tiers.
 * - CPU and memory from the collector's 30-second samples (`metrics`, about a
 *   day) and their summaries (`metric_rollups`, 5-minute through 7 days and
 *   hourly after that, as long as resource history is kept). The window is
 *   cut at the same boundaries as the charts (lib/serviceMetricHistory.ts),
 *   so a sample is never counted twice. Each sample stands for one collector
 *   interval; a cycle the collector skipped is not counted.
 * - Bandwidth and requests from the hourly traffic rows (traffic analytics).
 *
 * Cost: the operator gives each server a monthly cost. Over the window it is
 * prorated (730 hours a month) and split among the services on that server,
 * half by their share of its CPU time and half by their share of its memory.
 * A service is priced on its primary server (`services.server_id`; the panel
 * host when null). No migration: the costs are one settings row.
 */

const COSTS_KEY = 'usage_costs';
const DAY_MS = 86_400_000;
/** The collector's sampling interval (plugins/collector.ts). */
export const USAGE_SAMPLE_SECONDS = 30;
const HOURS_PER_MONTH = 730;
const floorTime = (ms: number, seconds: number) => new Date(Math.floor(ms / (seconds * 1000)) * seconds * 1000);
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

export async function readUsageCosts(db: DB): Promise<UsageCosts> {
  const stored = await getSettingJson<unknown>(db, COSTS_KEY, null);
  const parsed = usageCostsInput.safeParse(stored ?? {});
  const costs = parsed.success ? parsed.data : usageCostsInput.parse({});
  // A server deleted since keeps no cost.
  const live = new Set((await db.select({ id: servers.id }).from(servers)).map((s) => s.id));
  return { ...costs, servers: costs.servers.filter((s) => s.serverId === null || live.has(s.serverId)) };
}

export async function saveUsageCosts(db: DB, raw: UsageCostsInput): Promise<UsageCosts> {
  const input = usageCostsInput.parse(raw);
  await setSettingJson(db, COSTS_KEY, input);
  return readUsageCosts(db);
}

interface Raw {
  cpu: number;
  mem: number;
  disk: number;
  bytes: number;
  requests: number;
}

/** Sample sums per service: CPU in percent × 100 (10 000 = one core), memory in bytes. */
async function sampleSums(db: DB, from: Date, now: Date, retentionDays: number): Promise<Map<number, Raw>> {
  const out = new Map<number, Raw>();
  const add = (rows: Array<{ serviceId: number; kind: string; total: number | null }>) => {
    for (const r of rows) {
      const total = Number(r.total);
      if (!Number.isFinite(total)) continue;
      const row = out.get(r.serviceId) ?? { cpu: 0, mem: 0, disk: 0, bytes: 0, requests: 0 };
      if (r.kind === 'cpu') row.cpu += total;
      else if (r.kind === 'memory') row.mem += total;
      else if (r.kind === 'disk') row.disk += total;
      out.set(r.serviceId, row);
    }
  };
  const rawStart = floorTime(now.getTime() - DAY_MS, 300);
  const fineStart = floorTime(now.getTime() - 7 * DAY_MS, 3600);
  const kinds = sql`${metrics.kind} in ('cpu', 'memory', 'disk')`;
  add(
    await db
      .select({ serviceId: metrics.serviceId, kind: metrics.kind, total: sql<number>`sum(${metrics.value})` })
      .from(metrics)
      .where(and(kinds, gte(metrics.ts, from > rawStart ? from : rawStart), lt(metrics.ts, now)))
      .groupBy(metrics.serviceId, metrics.kind),
  );
  if (retentionDays > 1) {
    for (const tier of [
      { seconds: 300, start: fineStart, end: rawStart },
      { seconds: 3600, start: new Date(0), end: fineStart },
    ]) {
      if (from >= tier.end) continue;
      add(
        await db
          .select({ serviceId: metricRollups.serviceId, kind: metricRollups.kind, total: sql<number>`sum(${metricRollups.sum})` })
          .from(metricRollups)
          .where(
            and(
              sql`${metricRollups.kind} in ('cpu', 'memory', 'disk')`,
              eq(metricRollups.bucketSeconds, tier.seconds),
              gte(metricRollups.ts, from > tier.start ? from : tier.start),
              lt(metricRollups.ts, tier.end),
            ),
          )
          .groupBy(metricRollups.serviceId, metricRollups.kind),
      );
    }
  }
  return out;
}

async function trafficSums(db: DB, from: Date, into: Map<number, Raw>): Promise<void> {
  const rows = await db
    .select({
      serviceId: trafficRollups.serviceId,
      bytes: sql<number>`sum(${trafficRollups.bytesOut})`,
      requests: sql<number>`sum(${trafficRollups.requests})`,
    })
    .from(trafficRollups)
    .where(and(eq(trafficRollups.granularity, 3600), gte(trafficRollups.bucketStart, Math.floor(from.getTime() / 1000)), isNotNull(trafficRollups.serviceId)))
    .groupBy(trafficRollups.serviceId);
  for (const r of rows) {
    const row = into.get(r.serviceId!) ?? { cpu: 0, mem: 0, disk: 0, bytes: 0, requests: 0 };
    row.bytes += Number(r.bytes) || 0;
    row.requests += Number(r.requests) || 0;
    into.set(r.serviceId!, row);
  }
}

const zero = (): UsageFigures => ({ cpuCoreHours: 0, memoryGbHours: 0, diskGbHours: 0, egressGb: 0, requests: 0, cost: null });

function addInto(target: UsageFigures, f: UsageFigures): void {
  target.cpuCoreHours += f.cpuCoreHours;
  target.memoryGbHours += f.memoryGbHours;
  target.diskGbHours += f.diskGbHours;
  target.egressGb += f.egressGb;
  target.requests += f.requests;
  if (f.cost !== null) target.cost = (target.cost ?? 0) + f.cost;
}

const rounded = <T extends UsageFigures>(f: T): T => ({
  ...f,
  cpuCoreHours: round(f.cpuCoreHours, 4),
  memoryGbHours: round(f.memoryGbHours, 4),
  diskGbHours: round(f.diskGbHours, 4),
  egressGb: round(f.egressGb, 4),
  cost: f.cost === null ? null : round(f.cost, 2),
});

export async function buildUsageReport(db: DB, days: number, now = new Date()): Promise<UsageReport> {
  const from = new Date(now.getTime() - days * DAY_MS);
  let retentionDays = 1;
  try {
    retentionDays = (await readObservabilitySettings(db)).retentionDays;
  } catch {
    /* an unreadable record: assume the one-day default */
  }
  let traffic = false;
  try {
    traffic = await trafficAnalyticsEnabled(db);
  } catch {
    traffic = false;
  }
  const sums = await sampleSums(db, from, now, retentionDays);
  await trafficSums(db, from, sums);
  const costs = await readUsageCosts(db);

  const serviceRows = await db.select({ id: services.id, name: services.name, serverId: services.serverId }).from(services);
  const serverRows = await db.select({ id: servers.id, name: servers.name }).from(servers);
  const serverName = new Map<number | null, string>([[null, 'Panel host'], ...serverRows.map((s) => [s.id, s.name] as const)]);
  const projectLinks = await db
    .select({ serviceId: serviceProjects.serviceId, id: projects.id, name: projects.name })
    .from(serviceProjects)
    .innerJoin(projects, eq(projects.id, serviceProjects.projectId));
  const workspaceLinks = await db
    .select({ serviceId: serviceWorkspaces.serviceId, id: workspaces.id, name: workspaces.name })
    .from(serviceWorkspaces)
    .innerJoin(workspaces, eq(workspaces.id, serviceWorkspaces.workspaceId));

  const hoursPerSample = USAGE_SAMPLE_SECONDS / 3600;
  const figures = new Map<number, UsageFigures>();
  for (const s of serviceRows) {
    const r = sums.get(s.id) ?? { cpu: 0, mem: 0, disk: 0, bytes: 0, requests: 0 };
    figures.set(s.id, {
      cpuCoreHours: (r.cpu / 10_000) * hoursPerSample,
      memoryGbHours: (r.mem / 1024 ** 3) * hoursPerSample,
      // Each disk sample stands for an hour.
      diskGbHours: (r.disk / 1e9) * (DISK_SAMPLE_SECONDS / 3600),
      egressGb: r.bytes / 1e9,
      requests: r.requests,
      cost: null,
    });
  }

  // Price each server and split it among its services.
  const monthly = new Map(costs.servers.map((c) => [c.serverId, c.monthlyCost]));
  const serverIds: Array<number | null> = [null, ...serverRows.map((s) => s.id)];
  const serverOut: UsageServerRow[] = serverIds.map((serverId) => {
    const members = serviceRows.filter((s) => (s.serverId ?? null) === serverId).map((s) => figures.get(s.id)!);
    const cpu = members.reduce((a, f) => a + f.cpuCoreHours, 0);
    const mem = members.reduce((a, f) => a + f.memoryGbHours, 0);
    const monthlyCost = monthly.get(serverId) ?? null;
    const periodCost = monthlyCost === null ? null : (monthlyCost * days * 24) / HOURS_PER_MONTH;
    if (periodCost !== null) {
      const parts = (cpu > 0 ? 1 : 0) + (mem > 0 ? 1 : 0);
      for (const f of members) {
        const share = parts === 0 ? 0 : ((cpu > 0 ? f.cpuCoreHours / cpu : 0) + (mem > 0 ? f.memoryGbHours / mem : 0)) / parts;
        f.cost = periodCost * share;
      }
    }
    return {
      serverId,
      name: serverName.get(serverId) ?? `#${serverId}`,
      monthlyCost,
      periodCost: periodCost === null ? null : round(periodCost, 2),
      unallocated: periodCost === null ? null : cpu > 0 || mem > 0 ? 0 : round(periodCost, 2),
      cpuCoreHours: round(cpu, 4),
      memoryGbHours: round(mem, 4),
    };
  });

  const linksOf = <L extends { serviceId: number; id: number; name: string }>(links: L[], serviceId: number) =>
    links.filter((l) => l.serviceId === serviceId).map((l) => ({ id: l.id, name: l.name }));
  const serviceOut: UsageServiceRow[] = serviceRows.map((s) => ({
    serviceId: s.id,
    name: s.name,
    serverId: s.serverId ?? null,
    serverName: serverName.get(s.serverId ?? null) ?? `#${s.serverId}`,
    projects: linksOf(projectLinks, s.id),
    workspaces: linksOf(workspaceLinks, s.id),
    ...rounded(figures.get(s.id)!),
  }));

  const group = (links: Array<{ serviceId: number; id: number; name: string }>): UsageGroupRow[] => {
    const groups = new Map<number, UsageGroupRow>();
    for (const l of links) {
      const f = figures.get(l.serviceId);
      if (!f) continue;
      const g = groups.get(l.id) ?? { id: l.id, name: l.name, services: 0, ...zero() };
      g.services += 1;
      addInto(g, f);
      groups.set(l.id, g);
    }
    return [...groups.values()].map(rounded).sort((a, b) => a.name.localeCompare(b.name));
  };

  const totals = zero();
  for (const f of figures.values()) addInto(totals, f);

  return {
    from: from.toISOString(),
    to: now.toISOString(),
    days,
    currency: costs.currency,
    historyDays: retentionDays,
    trafficAnalytics: traffic,
    services: serviceOut.sort((a, b) => b.cpuCoreHours - a.cpuCoreHours || a.name.localeCompare(b.name)),
    projects: group(projectLinks),
    workspaces: group(workspaceLinks),
    servers: serverOut,
    totals: rounded(totals),
  };
}
