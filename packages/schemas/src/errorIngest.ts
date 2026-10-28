import { z } from 'zod';

// ── Sentry-compatible error ingest (G5.4) ────────────────────────────────────

/** `PATCH /v1/services/:id/errors/:issueId`. */
export const errorIssuePatch = z.object({ status: z.enum(['unresolved', 'resolved', 'ignored']) }).strict();
export type ErrorIssuePatch = z.infer<typeof errorIssuePatch>;

export interface ErrorIssueView {
  id: number;
  title: string;
  culprit: string | null;
  level: string;
  status: 'unresolved' | 'resolved' | 'ignored';
  count: number;
  firstSeen: string;
  lastSeen: string;
  firstRelease: string | null;
  /** The deploy the issue first appeared under. */
  firstDeploymentId: number | null;
  lastDeploymentId: number | null;
}

export interface ErrorEventView {
  id: number;
  eventId: string | null;
  release: string | null;
  environment: string | null;
  deploymentId: number | null;
  receivedAt: string;
  /** The event as the SDK sent it (truncated past 64 KiB). */
  payload: unknown;
}

export interface ErrorIngestView {
  enabled: boolean;
  createdAt: string | null;
  /** Only in the answer that created the key. */
  dsn?: string;
}
