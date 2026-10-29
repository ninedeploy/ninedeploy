import { z } from 'zod';

// ── Commit statuses on GitLab, Gitea and Bitbucket (ROADMAP 0.16.8 item 8) ──

/** `PUT /v1/services/:id/commit-status`. */
export const serviceCommitStatusInput = z.object({ enabled: z.boolean() }).strict();
export type ServiceCommitStatusInput = z.infer<typeof serviceCommitStatusInput>;

/** `GET|PUT /v1/services/:id/commit-status`. */
export interface ServiceCommitStatusView {
  enabled: boolean;
  /** The source's provider when it can report; null otherwise. */
  provider: 'gitlab' | 'gitea' | 'bitbucket' | null;
  /** Why this service cannot report, or null when it can. */
  unavailable: string | null;
}
