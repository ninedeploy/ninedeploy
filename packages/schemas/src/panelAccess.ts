import { z } from 'zod';

// ── Panel IP allow-list (COMPETITIVE_ROADMAP_2026-11 O4) ──────────────────
// Who may sign in to the panel and use it with a session: addresses or CIDR
// ranges. Credential-less integration routes (webhooks, CI runners, SCIM,
// status pages) are never restricted; API and MCP tokens only with
// `includeTokens`. The server validates each entry as an IPv4/IPv6 address
// or CIDR range and refuses a list that would lock the caller out.

export const PANEL_ACCESS_MAX_ENTRIES = 64;

export const panelAccessUpdate = z.object({
  enabled: z.boolean(),
  cidrs: z.array(z.string().trim().min(1).max(64)).max(PANEL_ACCESS_MAX_ENTRIES),
  includeTokens: z.boolean().default(false),
});
export type PanelAccessUpdate = z.input<typeof panelAccessUpdate>;

export const panelAccessView = z.object({
  enabled: z.boolean(),
  cidrs: z.array(z.string()),
  includeTokens: z.boolean(),
  /** The address the panel sees for the caller; add it to stay reachable. */
  yourIp: z.string(),
  /** True when NINEDEPLOY_PANEL_ACCESS=off overrides the list. */
  overridden: z.boolean(),
});
export type PanelAccessView = z.infer<typeof panelAccessView>;
