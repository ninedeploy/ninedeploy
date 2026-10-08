import { createReadStream } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { deployments, services } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { capture, run } from '../lib/exec.js';
import { checkForUpdate } from '../lib/updateCheck.js';
import { getSelfUpdateStatus, startSelfUpdate } from '../lib/selfUpdate.js';
import { selfUpdateStart } from '@ninedeploy/schemas';
import { NETWORK } from '../engine/proxy.js';
import { audit } from '../lib/audit.js';
import { createSystemArchive, importSystemArchive } from '../lib/systemArchive.js';

/** F869: docker CLI calls inherit capture()'s 30-minute default timeout; a
 * wedged daemon must not hold this admin request that long. Past the bound the
 * existing "docker unavailable" defaults apply. `system df` walks image and
 * volume sizes, so it gets more room than the plain listings. */
const DOCKER_LIST_TIMEOUT_MS = 10_000;
const DOCKER_DF_TIMEOUT_MS = 20_000;
/** F974: `docker image prune -f` deletes every dangling image's layers from
 * disk, which can legitimately take minutes on a large store or slow disk. It
 * gets 5 minutes, not a listing's 10 s. The 30-minute default held the admin
 * request and a docker child per click on a wedged daemon. Past the bound the
 * existing swallow applies: still `{ ok: true }` and audited, as for any prune
 * failure, and the next prune picks up the rest. */
const DOCKER_PRUNE_TIMEOUT_MS = 5 * 60_000;

function parseDf(line: string): Record<string, string> | null {
  try { return JSON.parse(line) as Record<string, string>; } catch { return null; }
}

/** Docker resource accounting + image pruning + export/import. Mounted under /system. */
export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // System resources, prune, export/import — admin-only (host-level operations).
  app.addHook('preHandler', app.requireAdmin);

  // Latest-release check (GitHub Releases feed, 6h cache; "unknown" when
  // offline or disabled — never throws so the dashboard stays usable).
  app.get('/update-check', async (req) => checkForUpdate((req.query as { force?: string })?.force === '1'));

  // ── Panel self-update ───────────────────────────────────────────────────
  // State/resolution of a one-click upgrade; marker files, not memory — the
  // panel that answers these polls is not the process that started the run.
  app.get('/update-status', async () => getSelfUpdateStatus());

  // Start is pinned to an exact tag on purpose: the operator confirmed that
  // version in the UI, so nothing silently re-resolves to a newer tag that
  // landed between the availability check and the click.
  app.post('/update-start', async (req, reply) => {
    const parsed = selfUpdateStart.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'invalid body' },
      });
    }
    void audit(app.db, req.user?.id ?? null, 'system.update_start', `${parsed.data.version}${parsed.data.force ? ' (forced)' : ''}`);
    // r572: the update restarts this process, and with it the deploy worker —
    // refuse (409 deploys_in_flight) while a build or rollout is executing,
    // unless the operator explicitly forces it. `queued` rows are not
    // in-flight: they survive the restart and the next worker picks them up.
    return startSelfUpdate(parsed.data.version, {
      force: parsed.data.force === true,
      inFlightDeployments: () =>
        app.db
          .select({ id: deployments.id, status: deployments.status, service: services.name })
          .from(deployments)
          .innerJoin(services, eq(services.id, deployments.serviceId))
          .where(inArray(deployments.status, ['building', 'deploying'])),
    });
  });

  app.get('/resources', async () => {
    let images: Array<{ repo: string; tag: string; size: string }> = [];
    let summary = { total: '0', active: '0', size: '—', reclaimable: '—' };
    let containers = 0;
    let volumes = 0;

    try {
      const df = await capture('docker', ['system', 'df', '--format', '{{json .}}'], { timeoutMs: DOCKER_DF_TIMEOUT_MS });
      for (const line of df.split('\n')) {
        const row = parseDf(line);
        if (row && row['Type'] === 'Images') {
          summary = { total: row['Total'] ?? '0', active: row['Active'] ?? '0', size: row['Size'] ?? '—', reclaimable: row['Reclaimable'] ?? '—' };
        }
      }
    } catch { /* docker unavailable */ }

    try {
      const out = await capture('docker', ['images', '--format', '{{.Repository}}|{{.Tag}}|{{.Size}}'], { timeoutMs: DOCKER_LIST_TIMEOUT_MS });
      images = out.split('\n').filter(Boolean).map((l) => {
        const [repo, tag, size] = l.split('|');
        return { repo: repo!, tag: tag ?? '', size: size ?? '' };
      }).slice(0, 25);
    } catch { /* ignore */ }

    try {
      containers = (await capture('docker', ['ps', '-q'], { timeoutMs: DOCKER_LIST_TIMEOUT_MS })).split('\n').filter(Boolean).length;
      volumes = (await capture('docker', ['volume', 'ls', '-q'], { timeoutMs: DOCKER_LIST_TIMEOUT_MS })).split('\n').filter(Boolean).length;
    } catch { /* ignore */ }

    return { network: NETWORK, containers, volumes, imagesSummary: summary, images };
  });

  app.post('/prune-images', async (req) => {
    const log = (line: string) => req.log.info({ component: 'system' }, line);
    await run('docker', ['image', 'prune', '-f'], { timeoutMs: DOCKER_PRUNE_TIMEOUT_MS }, log).catch(() => undefined);
    void audit(app.db, req.user?.id ?? null, 'system.prune_images');
    return { ok: true };
  });

  // Recent docker events (single-shot fetch for the Docker dashboard feed —
  // polling this endpoint is simpler and sturdier than a streamed daemon
  // connection). `minutes` caps how far back the daemon is asked to look.
  app.get('/docker-events', async (req) => {
    const minutes = Math.min(Math.max(Number((req.query as { minutes?: string }).minutes) || 60, 1), 1440);
    try {
      const raw = await capture('docker', [
        'events', '--since', `${minutes}m`, '--until', '0s',
        '--format', '{{.Time}}|{{.Type}}|{{.Action}}|{{.Actor.Attributes.name}}',
        // F938: single-shot (--until 0s), so a plain bound is the right one —
        // capture() has no abort, and each poll otherwise left a 30-minute
        // docker child behind on a wedged daemon. Below the page's 20 s poll.
      ], { timeoutMs: DOCKER_LIST_TIMEOUT_MS });
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('|');
          // Shared accessor: trailing segments may be missing entirely.
          const cell = (i: number): string => parts[i] ?? '';
          return { time: cell(0), type: cell(1), action: cell(2), name: cell(3) };
        })
        .reverse()
        .slice(0, 200);
      return { events };
    } catch {
      return { events: [] };
    }
  });

  // ── Export: download a tar.gz of the entire system state ──────────────
  // The archive format is built in lib/systemArchive.ts, shared with the
  // panel self-backup (which seals the same archive and uploads it).
  app.get('/export', async (req, reply) => {
    // The archive holds the database AND the master key — every secret on the
    // instance. Its download must leave a trail.
    void audit(app.db, req.user?.id ?? null, 'system.export');
    // Throws (500) with every intermediate already removed when VACUUM/tar fails.
    const built = await createSystemArchive(app.db, { warn: (msg) => app.log.warn(msg) });
    let stream: ReturnType<typeof createReadStream>;
    try {
      stream = createReadStream(built.archive);
    } catch (err) {
      built.cleanup();
      throw err;
    }
    // The old finally unlinked these artifacts in the same tick as
    // reply.send(), racing the stream's own open() (intermittent ENOENT
    // downloads on Linux; on Windows the unlink of an open file fails
    // silently and the archive — DB + master key + .env — leaked into the
    // data dir forever). 'close' fires after the fd is released (normal
    // end, consumer abort, or error) — the first moment the unlink can
    // actually succeed everywhere.
    stream.once('close', built.cleanup);
    stream.once('error', built.cleanup);
    reply.type('application/gzip')
      .header('content-disposition', `attachment; filename="ninedeploy-backup-${new Date().toISOString().slice(0, 10)}.tar.gz"`)
      .header('content-length', built.size);
    return reply.send(stream);
  });

  // ── Import: upload a tar.gz and restore system state ──────────────────
  // A backup archive is the sole large request this API accepts. Keep the
  // 256 MB allowance local so login, webhooks and ordinary JSON endpoints
  // cannot allocate a quarter-gigabyte Buffer before authentication runs.
  // Concurrent imports are serialized inside importSystemArchive (r454).
  app.post('/import', { bodyLimit: 256 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'string') {
      return reply.status(400).send({ error: { code: 'bad_request', message: 'No body received' } });
    }
    const outcome = await importSystemArchive(app, Buffer.from(body, 'binary'), req.user?.id ?? null);
    return reply.status(outcome.status).send(outcome.body);
  });
};
