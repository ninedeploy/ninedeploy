/**
 * `ninedeploy images {ls,prune}` — operator-facing image
 * inventory + retention. The companion to the auto-prune
 * cron (which fires when disk usage crosses the configured
 * threshold): this module is for the operator's day-to-day
 * `ls` / `prune --keep-last 5` workflow.
 *
 * Mounted under `/housekeeping` so the URL space matches the
 * related auto-prune routes (`/housekeeping/prune/...`).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { badRequest, unprocessable } from '../lib/errors.js';
import { listImages, pruneImages } from '../lib/imageInventory.js';

const pruneBody = z.object({
  /** Keep at least this many images per repository. */
  keepLast: z.number().int().min(0).max(1000).optional(),
  /** Only prune images older than this many hours. */
  olderThanHours: z.number().int().min(0).max(8760).optional(),
  /** Dangling-only mode (no keepLast). */
  danglingOnly: z.boolean().optional(),
  /** Report what would be deleted without actually deleting. */
  dryRun: z.boolean().optional(),
});

export const housekeepingImageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);

  // List every image on the host, with metadata.
  // GET /v1/housekeeping/images
  app.get('/images', async () => {
    const rows = await listImages();
    return { images: rows, totalCount: rows.length, totalBytes: rows.reduce((acc, r) => acc + r.sizeBytes, 0) };
  });

  // Run a prune. Body is optional; an empty body runs
  // `docker image prune -f` (dangling-only) which is the
  // safest default.
  // POST /v1/housekeeping/images/prune
  app.post('/images/prune', async (req) => {
    const parsed = pruneBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw unprocessable(parsed.error.issues[0]!.message);
    }
    const opts = parsed.data;
    // Refuse the "no filter" combination — it would delete
    // every image not currently in use, which is almost
    // never what the operator actually wants. The panel
    // uses `danglingOnly: true` for that.
    if (!opts.danglingOnly && !opts.keepLast && !opts.olderThanHours) {
      throw badRequest('Refusing to prune with no filter: set danglingOnly, keepLast, or olderThanHours');
    }
    const result = await pruneImages(opts);
    void audit(
      app.db,
      req.user!.id,
      result.dryRun ? 'images.prune_dry_run' : 'images.prune',
      `removed=${result.removed.length} freedBytes=${result.freedBytes}`,
    );
    return result;
  });
};
