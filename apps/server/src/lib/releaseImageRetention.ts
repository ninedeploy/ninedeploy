import { and, asc, gt, isNotNull } from 'drizzle-orm';
import { deploymentReleaseRecords, deployments, type DB } from '@ninedeploy/db';
import { parseDockerArtifact } from './dockerArtifact.js';
import { decrypt } from './crypto.js';
import { parseComposeRelease } from './composeRelease.js';
import { capture, run } from './exec.js';
import { listImages, parseReclaimedBytes, pruneImages, type ImageCommands, type PruneOptions, type PruneResult } from './imageInventory.js';

// A panel has one process. A new record must not become visible between a
// prune's protection scan and deletion. Always release the queue on failure.
let pending: Promise<void> = Promise.resolve();
export async function withReleaseImageLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = pending;
  let release!: () => void;
  pending = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

/** Any retained record holds its images, including copied queued restores. */
export async function retainedReleaseImageIds(db: DB): Promise<Set<string>> {
  const ids = new Set<string>();
  let artifactCursor = 0;
  for (;;) {
    const rows = await db.query.deployments.findMany({
      columns: { id: true, artifact: true },
      where: and(gt(deployments.id, artifactCursor), isNotNull(deployments.artifact)), orderBy: asc(deployments.id), limit: 32,
    });
    if (!rows.length) break;
    for (const row of rows) {
      try { ids.add(parseDockerArtifact(row.artifact).imageId); } catch {
        throw new Error('Image cleanup refused: a retained Docker artifact cannot be read. Remove the affected deployment history.');
      }
      artifactCursor = row.id;
    }
  }
  let cursor = 0;
  for (;;) {
    const rows = await db.query.deploymentReleaseRecords.findMany({
      columns: { id: true, payloadEncrypted: true },
      where: gt(deploymentReleaseRecords.id, cursor), orderBy: asc(deploymentReleaseRecords.id), limit: 32,
    });
    if (rows.length === 0) return ids;
    for (const row of rows) {
      try {
        const record = parseComposeRelease(decrypt(row.payloadEncrypted));
        for (const service of Object.values(record.model.services as Record<string, { image: string }>)) ids.add(service.image);
      } catch {
        // Never expose decrypted content, ciphertext, or parser error text.
        throw new Error('Image cleanup refused: a retained release record cannot be read. Restore the instance master keys or remove the affected deployment history.');
      }
      cursor = row.id;
    }
  }
}

export type ReleaseImageRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function imageCommands(runner?: ReleaseImageRunner): ImageCommands {
  return runner ? {
    capture: async (cmd, args) => (await runner(cmd, args)).stdout,
    run: async (cmd, args) => { await runner(cmd, args); },
  } : {
    capture: (cmd, args, opts, input) => input === undefined
      ? capture(cmd, args, opts ?? { timeoutMs: 30_000 })
      : capture(cmd, args, opts ?? { timeoutMs: 30_000 }, input),
    run,
  };
}

export async function listReleaseImages(db: DB) {
  return withReleaseImageLock(async () => listImages(await retainedReleaseImageIds(db), imageCommands()));
}

export async function pruneReleaseImages(db: DB, opts: PruneOptions, runner?: ReleaseImageRunner): Promise<PruneResult> {
  return withReleaseImageLock(async () => {
    const protectedIds = await retainedReleaseImageIds(db);
    // Preserve Docker's exact reclaimed-byte accounting for the historical
    // auto-prune path when there are no release records to protect.
    if (opts.includeDangling && protectedIds.size === 0 && !opts.dryRun) {
      const args = ['image', 'prune', '-af'];
      if (opts.olderThanHours !== undefined) args.push('--filter', `until=${opts.olderThanHours}h`);
      const output = runner ? (await runner('docker', args)).stdout : await capture('docker', args, { timeoutMs: 60_000 });
      return { freedBytes: parseReclaimedBytes(output), removed: [], removedLabels: [], dryRun: false, output };
    }
    const result = await pruneImages(opts, protectedIds, imageCommands(runner));
    if (protectedIds.size > 0 && result.freedBytes > 0) result.output += ' (image-size estimate; shared layers may remain)';
    return result;
  });
}
