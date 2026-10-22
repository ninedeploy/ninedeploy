import { eq } from 'drizzle-orm';
import { deploymentReleaseRecords, type DB } from '@ninedeploy/db';
import { decrypt, encrypt } from './crypto.js';
import { parseComposeRelease, type ComposeRelease } from './composeRelease.js';
import { withReleaseImageLock } from './releaseImageRetention.js';
import { capture } from './exec.js';

/** Point-in-time check only. The worker checks again before changing the stack. */
export async function checkReleaseImages(record: ComposeRelease) {
  const required = new Set(Object.values(record.model.services as Record<string, { image: string }>).map(s => s.image));
  try {
    // Include untagged/intermediate images: recorded releases use immutable IDs.
    const output = await capture('docker', ['image', 'ls', '--all', '--quiet', '--no-trunc'], { timeoutMs: 10_000, maxOutputBytes: 8 * 1024 * 1024 });
    const present = new Set(output.trim().split(/\s+/));
    const missingImageCount = [...required].filter(id => !present.has(id)).length;
    return missingImageCount > 0
      ? { available: false, imageAvailability: 'missing' as const, missingImageCount, reason: `${missingImageCount} recorded image(s) are missing from this host. The running stack was not changed.` }
      : { available: true, imageAvailability: 'present' as const, missingImageCount: 0, reason: 'Restores the recorded Compose configuration, environment and local image IDs. Volume data is not restored.' };
  } catch {
    // A daemon/CLI failure is not evidence that an image was deleted. Never
    // return subprocess errors, which can include host connection details.
    return { available: false, imageAvailability: 'unknown' as const, missingImageCount: null, reason: 'Local image availability could not be checked. Retry when Docker is reachable. The running stack was not changed.' };
  }
}

export async function readReleaseRecord(db: DB, deploymentId: number): Promise<ComposeRelease | null> {
  const row = await db.query.deploymentReleaseRecords.findFirst({ where: eq(deploymentReleaseRecords.deploymentId, deploymentId) });
  return row ? parseComposeRelease(decrypt(row.payloadEncrypted)) : null;
}

export async function storeReleaseRecord(db: DB, deploymentId: number, record: ComposeRelease): Promise<void> {
  const json = JSON.stringify(record);
  parseComposeRelease(json);
  await withReleaseImageLock(async () => {
    await db.insert(deploymentReleaseRecords).values({ deploymentId, payloadEncrypted: encrypt(json) }).onConflictDoNothing();
  });
}

export function assertReleaseTarget(record: ComposeRelease, service: { id: number; slug: string; type: string; serverId?: number | null; runtimeId?: string | null }): void {
  if (record.serviceId !== service.id || record.slug !== service.slug || service.type !== 'compose' || service.serverId != null || (service.runtimeId != null && service.runtimeId !== record.runtimeId)) {
    throw new Error('This recorded release belongs to a different service, name, runtime or host. Restore on the original panel host.');
  }
}
