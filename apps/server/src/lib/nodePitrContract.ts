/** Shared, closed operands for node archive operations. No passwords, S3 credentials or caller argv. */
import { z } from 'zod';
import type { Database } from '@ninedeploy/db';

export const NODE_PITR_CAPABILITY = 'db.pitr.archive' as const;
export const NODE_PITR_REPLY = 'ND-PITR ';
export const NODE_PITR_REPLAY_REFUSAL = 'The WAL archive stays on this node until remote archiving is configured. Managed replay from a node archive is not available in this slice. Recover its remote archive with the offline recovery tool on a clean host.';
const singleLine = (value: string) => ![...value].some((c) => [0, 10, 13].includes(c.charCodeAt(0)));
const segment = z.string().regex(/^[0-9A-F]{24}$/);
export const nodePitrIdentity = z.object({
  databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  container: z.string().max(128).regex(/^nd-db-[a-z0-9][a-z0-9_.-]*$/),
  volume: z.string().max(128).regex(/^nd-db-[a-z0-9][a-z0-9_.-]*$/),
  version: z.string().max(64).regex(/^\d+(?:\.\d+)*(?:-(?:alpine[0-9.]*|bookworm|bullseye|trixie))?$/),
  username: z.string().min(1).max(100).refine(singleLine, 'Expected a single-line PostgreSQL identifier'),
  dbName: z.string().min(1).max(100).refine(singleLine, 'Expected a single-line PostgreSQL identifier'),
}).strict();
export type NodePitrIdentity = z.infer<typeof nodePitrIdentity>;
export const nodePitrRequest = z.object({
  database: nodePitrIdentity,
  action: z.enum(['prepare', 'verify', 'preflight', 'archiveExists', 'inventory', 'archiver', 'baseBackup', 'prune', 'removeArchive']),
  retentionDays: z.number().int().min(1).max(35).optional(),
}).strict().refine((v) => v.action === 'prune' ? v.retentionDays !== undefined : v.retentionDays === undefined, 'retentionDays is required only for prune');
export const nodePitrExport = z.object({
  database: nodePitrIdentity,
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('checkpoint'), throughSegment: segment.optional() }).strict(),
    z.object({ kind: z.literal('wal'), names: z.array(segment).min(1).max(129), identityBase: z.string().regex(/^nd-[0-9TZ]{16,24}$/) }).strict(),
  ]),
}).strict();

export function nodePitrTarget(d: Database): NodePitrIdentity {
  if (d.serverId == null || d.engine !== 'postgres') throw new Error('Not a node PostgreSQL database');
  return nodePitrIdentity.parse({ databaseId: d.id, slug: d.slug, container: d.nodeContainerName ?? `nd-db-${d.slug}`, volume: d.nodeVolumeName ?? `nd-db-${d.slug}-data`, version: d.version ?? '18', username: d.username ?? 'nine', dbName: d.dbName ?? 'app' });
}
