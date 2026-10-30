import { z } from 'zod';

// ── Usage and cost (ROADMAP item 9) ────────────────────────────────────────
// `/v1/usage`, operator only. CPU-hours, memory and bandwidth per service,
// project and workspace over a window, priced from a monthly cost the
// operator gives each server. Read from the metrics the panel already keeps
// (30-second samples and their summaries, hourly traffic rows); nothing new
// is collected.

/** GET /v1/usage?days=N. */
export const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
export type UsageQuery = z.input<typeof usageQuery>;

/** PUT /v1/usage/costs. `serverId: null` is the panel host. */
export const usageCostsInput = z
  .object({
    currency: z.string().trim().regex(/^[A-Z]{3}$/, 'a three-letter currency code such as USD or EUR').default('USD'),
    servers: z
      .array(z.object({ serverId: z.number().int().positive().nullable(), monthlyCost: z.number().min(0).max(1_000_000) }))
      .max(500)
      .default([]),
  })
  .refine((v) => new Set(v.servers.map((s) => s.serverId)).size === v.servers.length, { message: 'each server once', path: ['servers'] });
export type UsageCostsInput = z.input<typeof usageCostsInput>;
export type UsageCosts = z.output<typeof usageCostsInput>;

/** What one service, project or workspace used in the window. */
export interface UsageFigures {
  /** CPU time in core-hours (one fully busy core for an hour is 1). */
  cpuCoreHours: number;
  /** Memory held over time, in GiB-hours. */
  memoryGbHours: number;
  /** The service's volumes over time, in GB-hours (sampled hourly). */
  diskGbHours: number;
  /** Bytes answered through the proxy, in GB (10^9). Needs traffic analytics. */
  egressGb: number;
  requests: number;
  /** The share of its server's cost; null when that server has no cost set. */
  cost: number | null;
}

export interface UsageServiceRow extends UsageFigures {
  serviceId: number;
  name: string;
  /** null: the panel host. */
  serverId: number | null;
  serverName: string;
  projects: Array<{ id: number; name: string }>;
  workspaces: Array<{ id: number; name: string }>;
}

export interface UsageGroupRow extends UsageFigures {
  id: number;
  name: string;
  services: number;
}

export interface UsageServerRow {
  serverId: number | null;
  name: string;
  monthlyCost: number | null;
  /** The monthly cost prorated to the window. */
  periodCost: number | null;
  /** The part of `periodCost` no service carries: all of it when nothing on the server was measured; null without a cost. */
  unallocated: number | null;
  cpuCoreHours: number;
  memoryGbHours: number;
}

/** GET /v1/usage. */
export interface UsageReport {
  from: string;
  to: string;
  days: number;
  currency: string;
  /** Resource history kept (days). CPU and memory older than this are gone, so a longer window under-counts them. */
  historyDays: number;
  /** Whether traffic analytics is on; bandwidth and requests are zero without it. */
  trafficAnalytics: boolean;
  services: UsageServiceRow[];
  /** A service in two projects (or workspaces) counts in both: group rows do not add up to the total. */
  projects: UsageGroupRow[];
  workspaces: UsageGroupRow[];
  servers: UsageServerRow[];
  totals: UsageFigures;
}
