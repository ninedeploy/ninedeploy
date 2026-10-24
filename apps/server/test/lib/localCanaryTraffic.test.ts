import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { services } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { observabilityDb } from '../fixtures/observability.js';
import { config } from '../../src/config.js';
import { TRAEFIK_CONTAINER } from '../../src/engine/dockerNames.js';
import { TRAEFIK_CONFIG_LABEL, traefikConfigFingerprint, traefikInputs } from '../../src/engine/proxy.js';
import { resetHostPathCache } from '../../src/lib/hostPath.js';
import { setTrafficAnalyticsEnabled, trafficLogDir, TRAFFIC_LOG_CONTAINER_DIR } from '../../src/lib/trafficAnalytics.js';
import { openLocalCanaryTraffic } from '../../src/lib/localCanaryTraffic.js';
import type { CanaryTrafficObservation } from '../../src/lib/canaryTrafficWindow.js';

const io = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../src/lib/exec.js', async original => ({ ...(await original<typeof import('../../src/lib/exec.js')>()), capture: io.capture }));

let dir: string, previousDir: string, f: Awaited<ReturnType<typeof observabilityDb>>;
let proxy: Record<string, unknown>;
const windows: CanaryTrafficObservation[] = [];
const source: Parameters<typeof openLocalCanaryTraffic>[1] = { id: 1, slug: 'web', runtimeId: 'web-7', serverId: null, orchestrator: null };
const begin = async (over: Partial<typeof source> = {}) => {
  const window = await openLocalCanaryTraffic(f.db, { ...source, ...over }, 60_000);
  windows.push(window); return window;
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nd-local-canary-'));
  previousDir = config.paths.dataDir; config.paths.dataDir = dir;
  resetHostPathCache(); io.capture.mockReset();
  f = await observabilityDb(); await setTrafficAnalyticsEnabled(f.db, true);
  const inputs = await traefikInputs(f.db);
  proxy = { id: 'a'.repeat(64), running: true, startedAt: '2026-10-24T00:00:00Z', restarts: 0,
    fingerprint: traefikConfigFingerprint(inputs.acmeEmail, inputs.dns, inputs),
    mounts: [{ Source: trafficLogDir(), Destination: TRAFFIC_LOG_CONTAINER_DIR, RW: true }] };
  io.capture.mockImplementation(async (_exe, args: string[]) => args.includes('{{json .Mounts}}')
    ? JSON.stringify([{ Source: dir, Destination: dir }]) : JSON.stringify(proxy));
  await mkdir(trafficLogDir()); await writeFile(path.join(trafficLogDir(), 'access.log'), '');
});
afterEach(async () => {
  await Promise.all(windows.splice(0).map(w => w.close()));
  await f.close(); config.paths.dataDir = previousDir; resetHostPathCache();
  await rm(dir, { recursive: true, force: true });
});

describe('local canary source attestation', () => {
  it('requires the configured running proxy, fingerprint, log mount and selected local service', async () => {
    const window = await begin();
    await appendFile(path.join(trafficLogDir(), 'access.log'), `${JSON.stringify({
      ServiceName: 'svc_web_4_canary@file', StartUTC: '2026-10-24T00:00:00Z', DownstreamStatus: 503, Duration: 4_000_000,
    })}\n`);
    expect(await window.finish()).toMatchObject({ complete: true, canary: { requests: 1, errors: 1, p95Ms: 4 } });
    const inspect = io.capture.mock.calls.find(args => (args[1] as string[]).includes(TRAEFIK_CONTAINER))!;
    expect(inspect[2]).toEqual({ timeoutMs: 2000 });
    expect((inspect[1] as string[]).at(-1)).toContain(TRAEFIK_CONFIG_LABEL);
    expect((inspect[1] as string[]).at(-1)).not.toContain('.Config.Env');
  });

  it('refuses node and Swarm sources without touching Docker or local files', async () => {
    await expect(begin({ serverId: 2 })).rejects.toThrow(/not confirmed/);
    await expect(begin({ orchestrator: 'swarm' })).rejects.toThrow(/not confirmed/);
    expect(io.capture).not.toHaveBeenCalled();
  });

  it('refuses explicitly disabled analytics before starting a window', async () => {
    await setTrafficAnalyticsEnabled(f.db, false);
    await expect(begin()).rejects.toThrow(/not confirmed/);
    expect(io.capture).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'not-a-container-id' }, { running: false }, { startedAt: 'invalid' }, { restarts: -1 },
    { fingerprint: 'old-static-config' }, { mounts: [] },
    { mounts: [{ Source: '/another-host', Destination: TRAFFIC_LOG_CONTAINER_DIR, RW: true }] },
    { mounts: [{ Source: 'unused', Destination: TRAFFIC_LOG_CONTAINER_DIR, RW: false }] },
  ])('refuses a proxy/log source that was not attested %j', async patch => {
    Object.assign(proxy, patch);
    await expect(begin()).rejects.toThrow(/not confirmed/);
  });

  it.each(['restart', 'replacement', 'settings', 'placement', 'runtime', 'stop', 'delete'])('refuses %s during observation', async change => {
    const window = await begin();
    if (change === 'restart') proxy.restarts = 1;
    if (change === 'replacement') proxy.id = 'b'.repeat(64);
    if (change === 'settings') await setTrafficAnalyticsEnabled(f.db, false);
    if (change === 'placement') await f.db.update(services).set({ orchestrator: 'swarm' }).where(eq(services.id, 1));
    if (change === 'runtime') await f.db.update(services).set({ runtimeId: 'other' }).where(eq(services.id, 1));
    if (change === 'stop') await f.db.update(services).set({ status: 'stopped' }).where(eq(services.id, 1));
    if (change === 'delete') await f.db.delete(services).where(eq(services.id, 1));
    await expect(window.finish()).rejects.toThrow(/unavailable/);
  });

  it('refuses an unreadable source without exposing Docker diagnostics', async () => {
    io.capture.mockRejectedValue(new Error('private socket credentials'));
    await expect(begin()).rejects.toThrow('local proxy/log source was not confirmed');
  });
});
