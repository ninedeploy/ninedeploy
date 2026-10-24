import path from 'node:path';
import { createHash } from 'node:crypto';
import { services, type DB } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { TRAEFIK_CONTAINER } from '../engine/dockerNames.js';
import { TRAEFIK_CONFIG_LABEL, traefikConfigFingerprint, traefikInputs } from '../engine/proxy.js';
import { capture } from './exec.js';
import { hostPathFor } from './hostPath.js';
import { TRAFFIC_LOG_CONTAINER_DIR, TRAFFIC_LOG_FILE, trafficLogDir } from './trafficAnalytics.js';
import { openFileCanaryTraffic, type CanaryTrafficObservation } from './canaryTrafficWindow.js';

type ServiceSource = { id: number; slug: string; runtimeId: string | null; serverId: number | null; orchestrator: string | null };
const unavailable = () => new Error('Canary traffic observation unavailable: local proxy/log source was not confirmed');
const normalized = (value: string) => value.replace(/[\\/]+$/, '');

/** The local observer never substitutes panel-host traffic for a node. */
export async function openLocalCanaryTraffic(db: DB, source: ServiceSource, maxAgeMs: number): Promise<CanaryTrafficObservation> {
  if (source.serverId != null || source.orchestrator === 'swarm' || !source.runtimeId) throw unavailable();
  const inputs = await traefikInputs(db);
  if (inputs.accessLog !== 'file') throw unavailable();
  const fingerprint = traefikConfigFingerprint(inputs.acmeEmail, inputs.dns, inputs);
  const hostDir = normalized(await hostPathFor(trafficLogDir()));
  const format = `{"id":{{json .Id}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"restarts":{{json .RestartCount}},"fingerprint":{{json (index .Config.Labels "${TRAEFIK_CONFIG_LABEL}")}},"mounts":{{json .Mounts}}}`;
  return openFileCanaryTraffic({ file: path.join(trafficLogDir(), TRAFFIC_LOG_FILE), slug: source.slug, maxAgeMs,
    identity: async () => {
      try {
        const fresh = await db.query.services.findFirst({ where: eq(services.id, source.id) });
        if (!fresh || fresh.type !== 'docker' || fresh.serverId != null || fresh.orchestrator === 'swarm' ||
          fresh.slug !== source.slug || fresh.runtimeId !== source.runtimeId || fresh.status === 'stopped') throw unavailable();
        const current = await traefikInputs(db);
        if (current.accessLog !== 'file' || traefikConfigFingerprint(current.acmeEmail, current.dns, current) !== fingerprint) throw unavailable();
        const raw = await capture('docker', ['inspect', TRAEFIK_CONTAINER, '--format', format], { timeoutMs: 2000 });
        if (raw.length > 64 * 1024) throw unavailable();
        const proxy = JSON.parse(raw) as { id?: unknown; running?: unknown; startedAt?: unknown; restarts?: unknown; fingerprint?: unknown; mounts?: unknown };
        if (typeof proxy.id !== 'string' || !/^[a-f0-9]{64}$/.test(proxy.id) || proxy.running !== true ||
          typeof proxy.startedAt !== 'string' || !Number.isFinite(Date.parse(proxy.startedAt)) ||
          !Number.isSafeInteger(proxy.restarts) || Number(proxy.restarts) < 0 || proxy.fingerprint !== fingerprint || !Array.isArray(proxy.mounts)) throw unavailable();
        const mount = proxy.mounts.find((m: { Destination?: unknown }) => m?.Destination === TRAFFIC_LOG_CONTAINER_DIR);
        if (!mount || mount.RW !== true || typeof mount.Source !== 'string' || normalized(mount.Source) !== hostDir) throw unavailable();
        return createHash('sha256').update(JSON.stringify([proxy.id, proxy.startedAt, proxy.restarts, fingerprint, hostDir])).digest('hex');
      } catch { throw unavailable(); }
    },
  });
}
