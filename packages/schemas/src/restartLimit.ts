import { z } from 'zod';

// ── Restart-loop limit (G1.3) ──────────────────────────────────────────────
// Opt-in per service: a container that restarts `maxRestarts` times within
// `windowMinutes` is stopped, and a `service.restart_limit` event notifies.

export const restartLimitConfig = z
  .object({
    maxRestarts: z.number().int().min(2).max(100),
    windowMinutes: z.number().int().min(1).max(1440),
  })
  .strict();
export type RestartLimitConfig = z.infer<typeof restartLimitConfig>;

/** `PUT /v1/services/:id/restart-limit`: a limit, or null to turn it off. */
export const restartLimitInput = z.object({ limit: restartLimitConfig.nullable() }).strict();
export type RestartLimitInput = z.infer<typeof restartLimitInput>;

export interface RestartLimitView {
  limit: RestartLimitConfig | null;
  /** Restarts seen within the window now. */
  recentRestarts: number;
  /** When the limit last stopped the service, if it did. */
  trippedAt: string | null;
}
