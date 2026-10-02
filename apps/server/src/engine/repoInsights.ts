import { eq } from 'drizzle-orm';
import { repoInsights, type DB } from '@ninedeploy/db';
import type { RepoInsights } from '@ninedeploy/schemas';
import { sanitizeNodeVersion } from '../lib/frameworks.js';

/** Insert-or-replace the stored analysis for a service (1:1 row). */
export async function upsertInsights(db: DB, serviceId: number, insights: RepoInsights): Promise<void> {
  const existing = await db.query.repoInsights.findFirst({ where: eq(repoInsights.serviceId, serviceId) });
  const values = {
    frameworkId: insights.framework.id,
    data: insights as unknown as Record<string, unknown>,
    commitSha: insights.commitSha ?? null,
  };
  if (existing) {
    await db.update(repoInsights).set(values).where(eq(repoInsights.serviceId, serviceId));
  } else {
    await db.insert(repoInsights).values({ serviceId, ...values });
  }
}

/**
 * r620: true when a stored analysis carries a `nodeVersion` that is not a Node
 * version. Before 0.10.41 a symlinked `.nvmrc` in a member's repo could put
 * host file content there (the panel's environment, for one); Doctor uses
 * this to tell the operator to rotate secrets.
 */
export function storedInsightsLeakSuspected(row: typeof repoInsights.$inferSelect): boolean {
  const raw = (row.data as { nodeVersion?: unknown } | null)?.nodeVersion;
  return raw != null && sanitizeNodeVersion(raw) === null;
}

/** Stored row → API representation (the JSON column already holds the DTO). */
export function serializeInsights(row: typeof repoInsights.$inferSelect): RepoInsights {
  const data = row.data as unknown as RepoInsights;
  // r620: never hand back a stored nodeVersion that is not a version — rows
  // written before 0.10.41 may hold host file content from a symlinked .nvmrc.
  if (data.nodeVersion == null || sanitizeNodeVersion(data.nodeVersion) === data.nodeVersion) return data;
  return { ...data, nodeVersion: null };
}
