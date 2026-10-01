import type { NineDeployClient } from '@ninedeploy/sdk';
import { InvalidArgumentError } from 'commander';
import { error, fmtBytes, header, info, spinner, success, table } from '../lib/format.js';

export async function housekeepingPrune(client: NineDeployClient): Promise<void> {
  const res = await spinner('Running system prune', () => client.housekeeping.runPrune());
  console.log('  ✓ System housekeeping prune completed.');
  console.log(`    Space reclaimed: ${fmtBytes(res.freedBytes)}`);
  console.log(`    Disk used after: ${res.diskUsedPercentAfter}%`);
  if (res.details?.imagesFreed) {
    console.log(`    Images freed:    ${res.details.imagesFreed}`);
  }
}

/**
 * `ninedeploy images ls` — every image on the host, with
 * repo / tag / size / age / dangling / in-use columns. The
 * default sort is by size descending so the operator sees
 * the biggest offenders first; `--sort age` switches to
 * "oldest first" which is what the panel usually wants for
 * a prune sweep.
 */
export async function imagesList(
  client: NineDeployClient,
  opts: { sort?: 'size' | 'age' } = {},
): Promise<void> {
  header('Images');
  const { images, totalBytes } = await spinner('Listing', () => client.housekeeping.listImages());
  if (images.length === 0) {
    info('No images on the host.');
    return;
  }
  const sorted = [...images].sort((a, b) => {
    if (opts.sort === 'age') return b.ageHours - a.ageHours;
    return b.sizeBytes - a.sizeBytes;
  });
  table(
    sorted.map((i) => ({
      repository: i.repository,
      tag: i.tag,
      size: i.size,
      ageHours: i.ageHours.toFixed(1),
      dangling: i.dangling ? 'yes' : '',
      inUse: i.inUse ? 'yes' : '',
    })),
    ['repository', 'tag', 'size', 'ageHours', 'dangling', 'inUse'],
  );
  info(`${images.length} images, total ${fmtBytes(totalBytes)}.`);
}

/**
 * `ninedeploy images prune` — fine-grained retention.
 * The CLI builds a small opts object from flags and posts
 * to `/v1/housekeeping/images/prune`. `--dry-run` is the
 * default expectation on a first run: the operator
 * eyeballs the would-delete set, then re-runs without it.
 */
/**
 * r554: commander option parser for a whole-number flag in `1..max`.
 * `images prune` used to pass `Number(v)` straight through — `--older-than 1.5`
 * or `--keep-last abc` sent 1.5 / NaN (JSON `null`) and the server answered an
 * opaque 422. Commander prints this message and exits 1 before any request.
 */
export function positiveIntOption(max: number): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!/^\d+$/.test(value.trim()) || n < 1 || n > max) {
      throw new InvalidArgumentError(`Expected a whole number between 1 and ${max} (got "${value}").`);
    }
    return n;
  };
}

export async function imagesPrune(
  client: NineDeployClient,
  opts: {
    keepLast?: number;
    olderThan?: number;
    dangling?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<void> {
  header('Image prune');
  if (!opts.dangling && !opts.keepLast && !opts.olderThan) {
    error('Refusing to prune with no filter. Set --dangling, --keep-last <N>, or --older-than <hours>.');
    process.exitCode = 1;
    return;
  }
  const res = await spinner(opts.dryRun ? 'Computing candidate set' : 'Pruning', () =>
    client.housekeeping.pruneImages({
      keepLast: opts.keepLast,
      olderThanHours: opts.olderThan,
      danglingOnly: opts.dangling,
      dryRun: opts.dryRun,
    }),
  );
  if (res.dryRun) {
    info(`dryRun: would remove ${res.removed.length} images, freeing ${fmtBytes(res.freedBytes)}.`);
    for (const label of res.removedLabels.slice(0, 25)) console.log(`  ${label}`);
    if (res.removedLabels.length > 25) info(`  …and ${res.removedLabels.length - 25} more.`);
    return;
  }
  success(`Removed ${res.removed.length} images, freed ${fmtBytes(res.freedBytes)}.`);
  console.log(res.output);
}

