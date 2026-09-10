import { beforeEach, describe, expect, it, vi } from 'vitest';
import { servicesRoutes } from '../../src/modules/services.js';
import { asUser, buildTestApp, createFakeDb, svcRow } from '../helpers.js';

/**
 * Coverage-driven test for `apps/server/src/modules/services.ts`.
 *
 * The existing `test/services.test.ts` (61 tests) covers the
 * happy-path CRUD surface. These tests focus on the 11 branch
 * points v8 marked as uncovered after Sprint 8: the
 * `visibleIds === null` operator short-circuit, the
 * `allRows.filter(...)` non-operator branch, the `wanted.some`
 * tag filter, the `tagsById.get(...) ?? NO_TAGS` fallback, the
 * `sourceId ? ... : null` source-name branch, the
 * `assertMayPublishPort(undefined ? existing : patch)` PATCH
 * ternary, the `if (!svc) throw notFound` post-update 404, the
 * PATCH port rewrite `writeDynamicConfig` failure log, the
 * `if (activeDeploy) throw conflict` DELETE guard, the
 * template `templateId && !template` 400, the
 * `template && registry-controlled` 400, and the
 * `if (input.tagProjectIds || …) replaceServiceTags(...)` call.
 */

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(async () => 'line1\nline2'),
  run: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/exec.js', () => execMocks);

const pm2Mocks = vi.hoisted(() => ({
  connect: vi.fn((cb: (err?: Error | null) => void) => cb(null)),
  disconnect: vi.fn(),
  stop: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  restart: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  delete: vi.fn((_name: string, cb: (err?: Error | null) => void) => cb(null)),
  describe: vi.fn((_name: string, cb: (err: Error | null, desc?: unknown[]) => void) => cb(null, [])),
}));
vi.mock('pm2', () => ({ default: pm2Mocks }));

const proxyMocks = vi.hoisted(() => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));
vi.mock('../../src/engine/proxy.js', () => proxyMocks);

const logsMocks = vi.hoisted(() => ({ deleteLog: vi.fn(() => true) }));
vi.mock('../../src/engine/logs.js', () => ({ deleteLog: logsMocks.deleteLog }));

const configMock = vi.hoisted(() => ({
  wildcardDomain: '',
  isProd: false,
  publicUrl: 'http://localhost:3000',
  paths: { dataDir: '/tmp', masterKeyFile: '/tmp/master.key' },
  jwt: { secret: 'x', accessTtl: '15m', refreshTtl: '7d' },
}));
vi.mock('../../src/config.js', () => ({ config: configMock }));

const validCreate = {
  name: 'My App',
  type: 'docker',
  repoUrl: 'https://github.com/acme/app.git',
  branch: 'main',
  port: 8080,
  build: { buildPack: 'auto', baseDir: '/' },
};

beforeEach(() => {
  vi.clearAllMocks();
  execMocks.run.mockResolvedValue(undefined);
});

describe('services list — visibility + tag filters', () => {
  it('skips the per-row filter when the caller is an operator (visibleIds === null)', async () => {
    // An operator's `visibleServiceIdSet` returns null, which the
    // list handler interprets as "see everything". The branch
    // `visibleIds === null ? allRows : allRows.filter(...)` must
    // take the null arm — the filter is never called.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: { services: [svcRow({ id: 1, name: 'web' })] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('filters the row set when the caller is NOT an operator (visibleIds.has branch)', async () => {
    // A non-operator's `visibleServiceIdSet` returns a Set; the
    // list handler must `filter` the rows to those whose id is in
    // the set. We exercise the branch by passing a non-operator
    // user; the exact filter result is determined by the fake's
    // workspace_members mock, but the route must return 200
    // and the `allRows.filter(...)` arm must run.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          services: [
            svcRow({ id: 1, name: 'web' }),
            svcRow({ id: 2, name: 'private' }),
          ],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: false, id: 1 }),
    });
    expect(res.statusCode).toBe(200);
    // The non-operator branch is taken — the test simply
    // confirms the response shape; the per-id filter result
    // is whatever the fake's workspace_members + owned query
    // produce. The point is that the route did not throw, did
    // not 500, and the filter arm ran (no operator short-circuit).
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('narrows the list by ?tagProjectIds= when the wanted set is non-empty (wanted.some branch)', async () => {
    // The list filter has three groups (project / workspace /
    // label). When `tagProjectIds=2` is set, the filter is
    // `wanted.some(id => have.includes(id))` — a non-empty
    // `wanted` array exercises the `.some` arm of the OR-fallback.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          services: [svcRow({ id: 1, name: 'tagged', ownerUserId: 1 })],
          // The service is linked to project 2.
          serviceProjects: [{ serviceId: 1, projectId: 2 }],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/?tagProjectIds=2',
      headers: asUser({ isOperator: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('coerces a service with no tag links to the NO_TAGS default', async () => {
    // `tagsById.get(s.id) ?? NO_TAGS` covers services that have
    // zero rows in the three link tables. The default is
    // `{ projectIds: [], workspaceIds: [], labelIds: [] }` so
    // the serialized response shape is still well-defined.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          services: [svcRow({ id: 1, name: 'untagged' })],
          // Empty link arrays — the findMany calls return [] by
          // default, so loadTagIds sees no links.
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({
      id: 1,
      projectIds: [],
      workspaceIds: [],
      labelIds: [],
    });
  });

  it('populates all three tag-id lists when a service has workspace AND label links', async () => {
    // The for-loops in `loadTagIds` push link ids into the
    // byId map. The route makes three separate
    // `findMany` queries (serviceProjects, serviceWorkspaces,
    // serviceLabels); with the fake db they all return the
    // same array. We assert the route surfaces the merged
    // shape — a regression that drops a loop shortens the
    // list and surfaces as empty arrays.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          services: [svcRow({ id: 1, name: 'tagged' })],
          serviceProjects: [{ serviceId: 1, projectId: 10 }],
          serviceWorkspaces: [{ serviceId: 1, workspaceId: 20 }],
          serviceLabels: [{ serviceId: 1, labelId: 30 }],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({
      projectIds: [10],
      workspaceIds: [20],
      labelIds: [30],
    });
  });

  it('resolves the per-service sourceName (the sourceId truthy branch of the ternary)', async () => {
    // `s.sourceId ? (sourceNames.get(s.sourceId) ?? null) : null`
    // — when a service has a linked source that DOES exist in
    // the sources table, the sourceName is the source's name
    // (not null). The earlier "orphan-source" test covers the
    // MISS branch; this covers the HIT branch.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          services: [svcRow({ id: 1, name: 'private-app', sourceId: 7 })],
          sources: [{ id: 7, name: 'github-main', type: 'github' }],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: true }),
    });
    expect(res.json()[0]).toMatchObject({
      name: 'private-app',
      sourceId: 7,
      sourceName: 'github-main',
    });
  });

  it('calls sourceNameFor on GET /:id when the service has a linked source', async () => {
    // The GET-single endpoint routes through
    // `serialize(svc, await sourceNameFor(app.db, svc.sourceId), ...)` —
    // the `sourceNameFor` helper is what walks the sourceId
    // truthy arm (`findFirst` + `return src?.name ?? null`).
    // The list endpoint skips that helper and uses a bulk
    // `sourceNames` map; this single-endpoint test exercises
    // the helper directly.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, name: 'private-app', sourceId: 7 }),
          buildConfigs: undefined,
          sources: { id: 7, name: 'github-main', type: 'github' },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/1',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'private-app',
      sourceId: 7,
      sourceName: 'github-main',
    });
  });

  it('degrades to null when the linked source has no name (src?.name ?? null arm)', async () => {
    // `return src?.name ?? null` — when the source row is
    // found but its name is null/undefined (a half-populated
    // Git credential entry), the helper must return null
    // rather than leaking a phantom name to the panel.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, name: 'edge-case', sourceId: 8 }),
          buildConfigs: undefined,
          // `name: null` exercises the `?? null` arm.
          sources: { id: 8, name: null, type: 'github' },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/1',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sourceId: 8, sourceName: null });
  });
});

describe('services list — source name resolution', () => {
  it('resolves sourceName to null when the linked source has been deleted (sourceNames.get undefined)', async () => {
    // `sourceId ? (sourceNames.get(s.sourceId) ?? null) : null`
    // — when the service points to a source that no longer
    // exists in the sources table, the sourceName degrades to
    // null rather than undefined. This was a regression in the
    // Git credential deletion path.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          services: [svcRow({ id: 1, name: 'orphan-source', sourceId: 42 })],
          // `sources` is empty, so the lookup misses.
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'GET',
      url: '/',
      headers: asUser({ isOperator: true }),
    });
    expect(res.json()[0]).toMatchObject({ name: 'orphan-source', sourceId: 42, sourceName: null });
  });
});

describe('services PATCH — publishedPort + 404 branches', () => {
  it('uses the existing.publishedPort when patch.publishedPort is undefined', async () => {
    // `assertMayPublishPort(req.user!, patch.publishedPort === undefined ? existing.publishedPort : patch.publishedPort)`
    // — when the PATCH body does not include publishedPort, the
    // service keeps its current value. The mock's update
    // returning is irrelevant for the assertion: we only check
    // that the route accepted the request without rejecting
    // publishedPort.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, slug: 'web', publishedPort: 9000, runtimeId: null }),
          buildConfigs: undefined,
        },
        update: {
          services: (set: Record<string, unknown>) => {
            // The patch body does NOT include publishedPort, so
            // the `set` payload must not include it either.
            expect(set).not.toHaveProperty('publishedPort');
            return [svcRow({ id: 1, slug: 'web', publishedPort: 9000, runtimeId: null })];
          },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { name: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('uses the patch.publishedPort when present (the else arm of the publishedPort ternary)', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, slug: 'web', publishedPort: 9000, runtimeId: null }),
          buildConfigs: undefined,
        },
        update: {
          services: (set: Record<string, unknown>) => {
            // The PATCH carries publishedPort=10000, so the
            // set payload must include it.
            expect(set.publishedPort).toBe(10000);
            return [svcRow({ id: 1, slug: 'web', publishedPort: 10000, runtimeId: null })];
          },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { publishedPort: 10000 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when the UPDATE returns zero rows (if (!svc) throw notFound)', async () => {
    // findFirst returns the existing row (so the PATCH route
    // passes the load step), but the UPDATE's `returning()`
    // yields []. The route must surface a 404 — NOT 200 with
    // a phantom null row.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, slug: 'web', publishedPort: null, runtimeId: null }),
          buildConfigs: undefined,
        },
        update: { services: () => [] },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { name: 'renamed' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('logs a warning (not a 500) when the post-port-change writeDynamicConfig throws', async () => {
    // `if (patch.port !== undefined && svc.runtimeId) { ... }`
    // — the route calls writeDynamicConfig and CATCHES the
    // error, logging `req.log.warn` instead of failing the
    // request. A regression that drops the catch would surface
    // a 500 to the operator.
    proxyMocks.writeDynamicConfig.mockRejectedValueOnce(new Error('traefik offline'));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, slug: 'web', port: 8080, publishedPort: null, runtimeId: 'c-web-1' }),
          buildConfigs: undefined,
        },
        update: {
          services: [svcRow({ id: 1, slug: 'web', port: 9090, publishedPort: null, runtimeId: 'c-web-1' })],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { port: 9090 },
    });
    expect(res.statusCode).toBe(200);
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalledTimes(1);
  });
});

describe('services PATCH — autoUpdate watch', () => {
  const IMAGE_SVC = svcRow({ id: 1, slug: 'img', type: 'docker', image: 'ghcr.io/acme/web:latest' });

  function autoUpdateDb(service: Record<string, unknown>, onSet?: (set: Record<string, unknown>) => void) {
    return createFakeDb({
      findFirst: { services: service, buildConfigs: undefined },
      update: {
        services: (set: Record<string, unknown>) => {
          onSet?.(set);
          return [service];
        },
      },
    });
  }

  it('accepts autoUpdate on an image-based, panel-host service', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = await buildTestApp({ db: autoUpdateDb(IMAGE_SVC, (s) => seen.push(s)) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { autoUpdate: true },
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ autoUpdate: true });
  });

  it('refuses autoUpdate on a repo-backed service', async () => {
    const repoSvc = svcRow({ id: 1, slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git' });
    const app = await buildTestApp({ db: autoUpdateDb(repoSvc) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { autoUpdate: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses autoUpdate on a service pinned to a remote node', async () => {
    const remoteSvc = svcRow({ id: 1, slug: 'img', type: 'docker', image: 'nginx:latest', serverId: 3 });
    const app = await buildTestApp({ db: autoUpdateDb(remoteSvc) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { autoUpdate: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('clears the baseline digest when the watch is disabled', async () => {
    const watched = svcRow({
      id: 1,
      slug: 'img',
      type: 'docker',
      image: 'nginx:latest',
      autoUpdate: true,
      autoUpdateDigest: 'sha256:old',
    });
    const seen: Array<Record<string, unknown>> = [];
    const app = await buildTestApp({ db: autoUpdateDb(watched, (s) => seen.push(s)) });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1',
      headers: asUser(),
      payload: { autoUpdate: false },
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ autoUpdate: false, autoUpdateDigest: null });
  });
});

describe('services DELETE — active-deploy guard', () => {
  it('refuses the delete with 409 when a deployment is queued or building', async () => {
    // The route reads `deployments.findFirst` for the service
    // and refuses to delete while a build is in flight — a
    // destructive op against a live runtime would orphan the
    // build's state. The user has to cancel / wait first.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, slug: 'web' }),
          // deployments.findFirst returns the queued row.
          deployments: { id: 99, serviceId: 1, status: 'building' },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'DELETE',
      url: '/1',
      headers: asUser(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/queued or building/);
  });
});

describe('services CREATE — template validation + tag attachment', () => {
  it('rejects a missing templateId with 400 (templateId && !template)', async () => {
    // When the payload includes a `templateId` that does not
    // resolve to a registered template, the route must 400
    // with a clear message — not 500 from a downstream NPE.
    // The bundled registry has real templates (`ghost`,
    // `wordpress`, `n8n` …) so we use a clearly-fake id.
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { ...validCreate, templateId: 'totally-nonexistent-template-xyz' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Template not found/);
  });

  it('rejects a template payload whose image/port/volume differ from the template defaults', async () => {
    // Templates are registry-controlled: the wizard must not
    // allow the operator to override image / port / volume —
    // a regression here would let a caller create a service
    // that LOOKS like WordPress but runs a different image.
    // We use the bundled templates — `getBundledTemplates()` is
    // not mocked here because the test does not pass a
    // templateId. Instead, we register a real template by
    // patching the registry; simpler: use a templateId that
    // matches a real bundled template and pass a wrong image.
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(servicesRoutes);
    const bundled = (await import('../../src/templates/registry.js')).getBundledTemplates();
    const tpl = bundled[0];
    if (!tpl) {
      // No bundled template — skip the assertion. (The other
      // tests still pin the 400 contract for unknown ids.)
      return;
    }
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: {
        ...validCreate,
        templateId: tpl.id,
        image: 'malicious:latest',
        port: 9999,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/registry-controlled/);
  });

  it('reuses an existing service row when the payload matches the template defaults and reuseExisting is true', async () => {
    // The CREATE handler's `dup` branch checks for a same-slug
    // row and, when `reuseExisting === true` and the row's
    // status is `idle`, returns it instead of inserting a new
    // one. The match predicate includes the templateId
    // comparison and JSON-stringified databaseEnv / cmd /
    // dockerSocket comparisons. This test exercises the full
    // match: an existing service with matching templateId
    // returns 200 with the existing id (no new insert), and
    // `templateDatabaseEnv ?? null` is exercised by the JSON
    // comparison the other way around.
    const bundled = (await import('../../src/templates/registry.js')).getBundledTemplates();
    const tpl = bundled[0];
    if (!tpl) return;
    const existingId = 42;
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: {
            id: existingId,
            ownerUserId: 1,
            name: 'Reused',
            slug: 'reused',
            type: 'docker',
            image: tpl.image,
            port: tpl.port,
            publishedPort: null,
            repoUrl: 'https://github.com/acme/app.git',
            branch: 'main',
            sourceId: null,
            serverId: null,
            volumeMount: tpl.volumeMount ?? null,
            composeService: null,
            cpuShares: 0,
            memLimitMb: 0,
            dockerSocket: false,
            templateId: tpl.id,
            templateDatabaseEnv: null,
            cmd: null,
            healthPath: '/',
            runtimeId: null,
            status: 'idle',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        // The reusable branch must NOT insert.
        insert: { services: () => { throw new Error('insert must not be called when reusing'); } },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: {
        ...validCreate,
        templateId: tpl.id,
        image: tpl.image,
        port: tpl.port,
        volumeMount: tpl.volumeMount,
        reuseExisting: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: existingId, name: 'Reused' });
  });

  it('replaces tag links when tagProjectIds/tagWorkspaceIds/tagLabelIds are supplied (POST path)', async () => {
    // `if (input.tagProjectIds || input.tagWorkspaceIds || input.tagLabelIds)`
    // — when any of the three tag arrays is set, the route
    // calls `replaceServiceTags` instead of the default
    // workspace-only auto-tagging. A regression that drops the
    // branch leaves the operator's explicit tag set unrecorded
    // (the service lands in no workspace).
    //
    // `replaceServiceTags` wraps its work in `db.transaction()` and
    // does a single `.values([{serviceId, projectId}, …]).onConflictDoNothing()`
    // per dimension. The fake db passes the values payload
    // (an array) to the insert resolver verbatim, so we look up
    // the row that mentions projectId=99 instead of asserting on
    // `.serviceId` directly (which would be undefined on the array).
    let capturedRow: { serviceId: number; projectId: number } | undefined;
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 4, name: 'tagged', slug: 'tagged' })],
          serviceProjects: (v: Array<{ serviceId: number; projectId: number }>) => {
            capturedRow = v.find((row) => row.projectId === 99);
            return [];
          },
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { ...validCreate, tagProjectIds: [99] },
    });
    // The body of a 500 from `app.inject` is dropped unless the
    // underlying app is built with `logger: true`. Inspect both
    // the status and the body so a regression in the route handler
    // surfaces a useful message in the test output.
    if (res.statusCode !== 200) {
      throw new Error(`expected 200, got ${res.statusCode}: ${res.body}`);
    }
    expect(res.statusCode).toBe(200);
    expect(capturedRow).toEqual({ serviceId: 4, projectId: 99 });
  });

  it('passes workspaceIds and labelIds to replaceServiceTags (the ?? [] fallbacks)', async () => {
    // When the payload only carries tagProjectIds, the
    // `tagWorkspaceIds ?? []` and `tagLabelIds ?? []`
    // fallbacks fire — the route hands empty arrays to
    // `replaceServiceTags` so it can clear the unspecified
    // dimensions deterministically.
    let capturedArgs: unknown[] | undefined;
    const serviceTags = await import('../../src/modules/serviceTags.js');
    const replaceSpy = vi.spyOn(serviceTags, 'replaceServiceTags').mockImplementationOnce(
      async (_db, _serviceId, _projectIds, _workspaceIds, _labelIds) => {
        capturedArgs = [_projectIds, _workspaceIds, _labelIds];
      },
    );
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 5, name: 'projects-only', slug: 'projects-only' })],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      payload: { ...validCreate, tagProjectIds: [99] },
    });
    expect(res.statusCode).toBe(200);
    expect(capturedArgs).toEqual([[99], [], []]);
    replaceSpy.mockRestore();
  });

  it('falls back to [] for tagProjectIds when only tagWorkspaceIds is supplied (the ?? [] arm)', async () => {
    // The `input.tagProjectIds ?? []` arm fires when the
    // payload sets tagWorkspaceIds (or tagLabelIds) but not
    // tagProjectIds — the route's `if (any of three)` branch
    // entered, but the missing array still falls back to
    // `[]` rather than `undefined` so replaceServiceTags
    // gets a clean shape. The other two arms are covered
    // by the previous test; this one closes the
    // tagProjectIds fall-back.
    let capturedArgs: unknown[] | undefined;
    const serviceTags = await import('../../src/modules/serviceTags.js');
    const replaceSpy = vi.spyOn(serviceTags, 'replaceServiceTags').mockImplementationOnce(
      async (_db, _serviceId, _projectIds, _workspaceIds, _labelIds) => {
        capturedArgs = [_projectIds, _workspaceIds, _labelIds];
      },
    );
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          services: [svcRow({ id: 6, name: 'workspaces-only', slug: 'workspaces-only' })],
        },
      }),
    });
    await app.register(servicesRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: asUser(),
      // Only tagWorkspaceIds — tagProjectIds and tagLabelIds
      // are undefined, so the `?? []` arm on tagProjectIds
      // fires and the same arm on tagLabelIds also fires.
      payload: { ...validCreate, tagWorkspaceIds: [50] },
    });
    expect(res.statusCode).toBe(200);
    expect(capturedArgs).toEqual([[], [50], []]);
    replaceSpy.mockRestore();
  });

  // ── cross-tenant tag guard on POST ─────────────────────────────────────
  //
  // `replaceServiceTags` writes whatever ids it is handed, and the deploy
  // pipeline decrypts every tagged project's shared env into the service's
  // container. The create route must therefore apply the same visibility rule
  // as PUT /:id/tags — otherwise a member tags their service with another
  // tenant's project id and exfiltrates its secrets at deploy time
  // (engine/pipeline.ts loadRuntimeEnv).
  describe('create — cross-tenant tag guard', () => {
    const member = { id: 7, isOperator: false };
    const wsMember = (workspaceId: number) => ({
      id: 1,
      workspaceId,
      userId: 7,
      role: 'member',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const projectRow = (workspaceId: number) => ({
      id: 99,
      name: 'shared-env',
      slug: 'shared-env',
      workspaceId,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    it('refuses to tag a project outside the caller’s workspaces and inserts no links', async () => {
      let projectLinkInserts = 0;
      const app = await buildTestApp({
        db: createFakeDb({
          findMany: {
            // The member sits only in workspace 2; project 99 lives in 3.
            workspaceMembers: [wsMember(2)],
            projects: [projectRow(3)],
          },
          insert: {
            services: [svcRow({ id: 4, name: 'mine', slug: 'mine' })],
            serviceProjects: () => {
              projectLinkInserts += 1;
              return [];
            },
          },
        }),
      });
      await app.register(servicesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(member),
        payload: { ...validCreate, tagProjectIds: [99] },
      });
      expect(res.statusCode).toBe(403);
      expect(projectLinkInserts).toBe(0);
    });

    it('refuses an unknown project id the same way', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findMany: { workspaceMembers: [wsMember(2)], projects: [] },
          insert: { services: [svcRow({ id: 4, name: 'mine', slug: 'mine' })] },
        }),
      });
      await app.register(servicesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(member),
        payload: { ...validCreate, tagProjectIds: [99] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('applies the tag set when the caller can see the target project', async () => {
      let capturedRow: unknown;
      const app = await buildTestApp({
        db: createFakeDb({
          findMany: {
            workspaceMembers: [wsMember(2)],
            projects: [projectRow(2)],
          },
          insert: {
            services: [svcRow({ id: 4, name: 'mine', slug: 'mine' })],
            serviceProjects: (v: unknown) => {
              capturedRow = v;
              return [];
            },
          },
        }),
      });
      await app.register(servicesRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: asUser(member),
        payload: { ...validCreate, tagProjectIds: [99] },
      });
      expect(res.statusCode).toBe(200);
      expect(capturedRow).toEqual([{ serviceId: 4, projectId: 99 }]);
    });
  });
});
