import { z } from 'zod';

// ── Move a service with its data (G3.1) ────────────────────────────────────

/** `POST /v1/services/:id/move`: the target host (null = the panel host). */
export const serviceMoveInput = z.object({ serverId: z.number().int().positive().nullable() }).strict();
export type ServiceMoveInput = z.infer<typeof serviceMoveInput>;

export interface ServiceMoveView {
  state: 'none' | 'running' | 'done' | 'failed';
  from: number | null;
  to: number | null;
  /** While running: `copying` the data volume, then `deploying`. */
  step: 'copying' | 'deploying' | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The deployment started on the target. */
  deploymentId: number | null;
  /** The volumes being moved (a compose stack moves every named volume it made). Absent on older rows. */
  volumes?: string[];
  /** How many of `volumes` are copied so far. */
  copied?: number;
}
