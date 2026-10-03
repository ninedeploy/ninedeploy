/**
 * G-45 manifest apply — module coverage.
 *
 * `modules/manifest.ts` exposes:
 *  - `applyManifestRuntimeConfig(db, id, manifest, strategy)` — the
 *    lib-side routine that reconciles a `.ninedeploy` manifest's
 *    build / run / network sections into the service row + the
 *    build_configs row.
 *  - `POST /:id/manifest/apply` — the HTTP surface (admin only).
 *
 * The behavior worth pinning down:
 *  - diff computation only writes fields the manifest
 *    actually supplies (the operator's other columns are
 *    preserved; "absent means leave alone").
 *  - `run.restart` set in the manifest implies a 30s
 *    `stopGraceSeconds` so a long preStop hook has time to
 *    drain.
 *  - the build_configs row is required; a service without
 *    one fails the apply with 422.
 *  - the HTTP route is admin-gated and emits an audit log.
 *  - the schema is `.strict()`; an unknown key in the
 *    manifest fails the apply with 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asUser,
  buildTestApp,
  createFakeDb,
  listen,
} from '../helpers.js';
import { applyManifestRuntimeConfig } from '../../src/modules/manifest.js';
import type { NinedeployManifest } from '@ninedeploy/schemas';

vi.mock('../../src/lib/audit.js', () => ({
  audit: vi.fn(async () => undefined),
}));

interface ServiceRow {
  id: number;
  name: string;
  projectId: number;
  workspaceId: number;
}

interface BuildConfigRow {
  id: number;
  serviceId: number;
}

let serviceRow: ServiceRow | null = { id: 1, name: 'web', projectId: 1, workspaceId: 1 };
let buildConfigRow: BuildConfigRow | null = { id: 1, serviceId: 1 };
let updates: Array<{ table: string; set: Record<string, unknown> }> = [];
let appRef: Awaited<ReturnType<typeof buildTestApp>> | null = null;

async function startApp() {
  const db = createFakeDb({
    findFirst: {
      services: () => serviceRow,
      workspaceMembers: () => ({ id: 1, workspaceId: 1, userId: 1, role: 'owner' }),
    },
    select: {
      buildConfigs: () => (buildConfigRow ? [buildConfigRow] : []),
      build_configs: () => (buildConfigRow ? [buildConfigRow] : []),
    },
    update: {
      services: (set: Record<string, unknown>) => {
        updates.push({ table: 'services', set });
        return [set];
      },
      buildConfigs: (set: Record<string, unknown>) => {
        updates.push({ table: 'buildConfigs', set });
        return [set];
      },
      build_configs: (set: Record<string, unknown>) => {
        updates.push({ table: 'buildConfigs', set });
        return [set];
      },
    },
  });
  const app = await buildTestApp({ db });
  await app.register((await import('../../src/modules/manifest.js')).manifestRoutes);
  const port = await listen(app);
  appRef = app;
  return { app, port, db };
}

beforeEach(() => {
  serviceRow = { id: 1, name: 'web', projectId: 1, workspaceId: 1 };
  buildConfigRow = { id: 1, serviceId: 1 };
  updates = [];
});

afterEach(async () => {
  if (appRef) await appRef.close().catch(() => undefined);
  appRef = null;
});

const baseManifest: NinedeployManifest = { version: '1' };

describe('applyManifestRuntimeConfig (lib)', () => {
  it('applies a build section to build_configs only', async () => {
    const db = createFakeDb({
      select: {
        buildConfigs: () => [{ id: 1, serviceId: 1 }],
        build_configs: () => [{ id: 1, serviceId: 1 }],
      },
      update: {
        services: () => [],
        buildConfigs: (set: Record<string, unknown>) => {
          updates.push({ table: 'buildConfigs', set });
          return [set];
        },
        build_configs: (set: Record<string, unknown>) => {
          updates.push({ table: 'buildConfigs', set });
          return [set];
        },
      },
    });
    const result = await applyManifestRuntimeConfig(db, 1, {
      version: '1',
      build: { install: 'npm ci', start: 'node server.js' },
    });
    expect(result.touched).toEqual(['build_config']);
    expect(result.diff.service).toEqual({});
    expect(result.diff.build.installCmd).toBe('npm ci');
    expect(result.diff.build.startCmd).toBe('node server.js');
    expect(updates.length).toBe(1);
    expect(updates[0]?.table).toBe('buildConfigs');
  });

  it('applies a run.port + healthcheck to the service row', async () => {
    const db = createFakeDb({
      select: {
        buildConfigs: () => [{ id: 1, serviceId: 1 }],
        build_configs: () => [{ id: 1, serviceId: 1 }],
      },
      update: {
        services: (set: Record<string, unknown>) => {
          updates.push({ table: 'services', set });
          return [set];
        },
        buildConfigs: (set: Record<string, unknown>) => {
          updates.push({ table: 'buildConfigs', set });
          return [set];
        },
        build_configs: (set: Record<string, unknown>) => {
          updates.push({ table: 'buildConfigs', set });
          return [set];
        },
      },
    });
    const result = await applyManifestRuntimeConfig(db, 1, {
      version: '1',
      run: { port: 3000, healthcheck: '/healthz' },
    });
    expect(result.touched).toEqual(['service']);
    expect(result.diff.service.port).toBe(3000);
    expect(result.diff.service.healthPath).toBe('/healthz');
    expect(updates[0]?.table).toBe('services');
  });

  it('sets stopGraceSeconds=30 when run.restart is set', async () => {
    const db = createFakeDb({
      select: {
        buildConfigs: () => [{ id: 1, serviceId: 1 }],
        build_configs: () => [{ id: 1, serviceId: 1 }],
      },
      update: {
        services: (set: Record<string, unknown>) => {
          updates.push({ table: 'services', set });
          return [set];
        },
        buildConfigs: (set: Record<string, unknown>) => {
          updates.push({ table: 'buildConfigs', set });
          return [set];
        },
        build_configs: (set: Record<string, unknown>) => {
          updates.push({ table: 'buildConfigs', set });
          return [set];
        },
      },
    });
    const result = await applyManifestRuntimeConfig(db, 1, {
      version: '1',
      run: { restart: 'always' },
    });
    expect(result.touched).toEqual(['build_config']);
    expect(result.diff.build.restartPolicy).toBe('always');
    expect(result.diff.build.stopGraceSeconds).toBe(30);
  });

  it('applies network.publishPort to the service row', async () => {
    const db = createFakeDb({
      select: {
        buildConfigs: () => [{ id: 1, serviceId: 1 }],
        build_configs: () => [{ id: 1, serviceId: 1 }],
      },
      update: {
        services: (set: Record<string, unknown>) => {
          updates.push({ table: 'services', set });
          return [set];
        },
        buildConfigs: () => [],
        build_configs: () => [],
      },
    });
    const result = await applyManifestRuntimeConfig(db, 1, {
      version: '1',
      network: { publishPort: 8080 },
    });
    expect(result.diff.service.publishedPort).toBe(8080);
  });

  it('is a no-op when the manifest carries no relevant sections', async () => {
    const db = createFakeDb({
      // The lib unconditionally re-reads the build_configs row at the
      // end (to fill `result.build.id`); hand it the existing row
      // even though no update happens.
      select: {
        buildConfigs: () => [{ id: 1, serviceId: 1 }],
        build_configs: () => [{ id: 1, serviceId: 1 }],
      },
      update: () => [],
    });
    const result = await applyManifestRuntimeConfig(db, 1, baseManifest);
    expect(result.touched).toEqual([]);
    expect(result.diff).toEqual({ service: {}, build: {} });
    expect(result.build.id).toBe(1);
  });

  it('throws 422 when the service has no build_configs row', async () => {
    const db = createFakeDb({
      select: {
        buildConfigs: () => [],
        build_configs: () => [],
      },
      update: {
        services: () => [],
        buildConfigs: () => [],
        build_configs: () => [],
      },
    });
    await expect(
      applyManifestRuntimeConfig(db, 1, {
        version: '1',
        build: { install: 'echo' },
      }),
    ).rejects.toThrow(/no build config/);
  });

  it('applies every build field independently (install / build / start / baseDir / dockerfile)', async () => {
    // The diff builder's `if (b.X !== undefined) diff.build.X = b.X`
    // branches (lines 79–83) need each field to be exercised at
    // least once. The previous coverage tests only set `install`.
    // This test passes a manifest that supplies ALL five build
    // fields and asserts each one lands on the right key.
    const db = createFakeDb({
      select: {
        buildConfigs: () => [{ id: 1, serviceId: 1 }],
        build_configs: () => [{ id: 1, serviceId: 1 }],
      },
      update: () => [],
    });
    const result = await applyManifestRuntimeConfig(db, 1, {
      version: '1',
      build: {
        install: 'npm ci',
        build: 'npm run build',
        start: 'node server.js',
        baseDir: 'apps/web',
        dockerfile: 'Dockerfile.prod',
      },
    });
    expect(result.diff.build.installCmd).toBe('npm ci');
    expect(result.diff.build.buildCmd).toBe('npm run build');
    expect(result.diff.build.startCmd).toBe('node server.js');
    expect(result.diff.build.baseDir).toBe('apps/web');
    expect(result.diff.build.dockerfilePath).toBe('Dockerfile.prod');
  });
});

describe('POST /:id/manifest/apply (HTTP)', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/manifest/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: baseManifest }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin callers with 403', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/manifest/apply`, {
      method: 'POST',
      headers: { ...asUser({ id: 1, role: 'member' }), 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: baseManifest }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed manifest (zod fail) with 400', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/manifest/apply`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { version: '1', unknownKey: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  it('applies a build + run + network manifest, returns touched + diff', async () => {
    const { port, app } = await startApp();
    const audit = (await import('../../src/lib/audit.js')).audit as unknown as ReturnType<typeof vi.fn>;
    const res = await fetch(`http://127.0.0.1:${port}/1/manifest/apply`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          version: '1',
          build: { install: 'npm ci' },
          run: { port: 3000, healthcheck: '/healthz', restart: 'on-failure:5' },
          network: { publishPort: 8080 },
        },
        strategy: 'merge',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.serviceId).toBe(1);
    expect(body.touched.sort()).toEqual(['build_config', 'service']);
    expect(body.diff.service.port).toBe(3000);
    expect(body.diff.build.installCmd).toBe('npm ci');
    expect(body.diff.build.restartPolicy).toBe('on-failure:5');
    expect(body.diff.build.stopGraceSeconds).toBe(30);
    expect(body.diff.service.publishedPort).toBe(8080);
    expect(audit).toHaveBeenCalledWith(
      app.db,
      1,
      'service.manifest_apply',
      expect.stringMatching(/web:/),
    );
  });

  it('returns 404 when the service is not visible to the caller', async () => {
    serviceRow = null;
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/manifest/apply`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: baseManifest }),
    });
    expect(res.status).toBe(404);
  });

  it('surfaces a missing build_configs row as 422', async () => {
    buildConfigRow = null;
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/manifest/apply`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { version: '1', build: { install: 'x' } } }),
    });
    expect(res.status).toBe(422);
  });

  it('respects strategy=replace (no diff in this routine — merge is the only mode today)', async () => {
    const { port } = await startApp();
    const res = await fetch(`http://127.0.0.1:${port}/1/manifest/apply`, {
      method: 'POST',
      headers: { ...asUser(1), 'content-type': 'application/json' },
      body: JSON.stringify({
        strategy: 'replace',
        manifest: { version: '1', run: { port: 4000 } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diff.service.port).toBe(4000);
  });
});
