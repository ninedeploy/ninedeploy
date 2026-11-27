import { z } from 'zod';

// ── Git polling (X2) ───────────────────────────────────────────────────────
// Opt-in per service, for a server that cannot receive webhooks: the panel
// reads the branch's head with `git ls-remote` every `intervalSeconds`, and a
// head it has not seen is deployed through the push path, CI gate included.

export const GIT_POLL_MIN_SECONDS = 60;
export const GIT_POLL_MAX_SECONDS = 86_400;

export const gitPollConfig = z
  .object({
    intervalSeconds: z.number().int().min(GIT_POLL_MIN_SECONDS).max(GIT_POLL_MAX_SECONDS),
  })
  .strict();
export type GitPollConfig = z.infer<typeof gitPollConfig>;

/** `PUT /v1/services/:id/git-poll`: polling, or null to turn it off. */
export const gitPollInput = z.object({ poll: gitPollConfig.nullable() }).strict();
export type GitPollInput = z.infer<typeof gitPollInput>;

export interface GitPollView {
  /** Whether the service can poll at all: it has a Git repository. */
  supported: boolean;
  poll: GitPollConfig | null;
  /** The branch head the last poll found, when one has run. */
  lastSha: string | null;
  /** When the last poll ran. */
  lastPolledAt: string | null;
  /** Why the last poll did not get as far as a verdict, when it did not. */
  lastError: string | null;
  /** The deployment a poll queued last, when one did. */
  lastDeploymentId: number | null;
}
