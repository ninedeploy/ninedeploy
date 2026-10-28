import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, deployments, runMigrations, services, settings, users } from '@ninedeploy/db';

/**
 * G1.7 registry push webhooks against a real migrated SQLite: the payload
 * parsers for each registry, the management routes (token shown once, stored
 * hashed) and the public POST, which deploys only for the service's own image
 * and tag, as the member who made the hook.
 */

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);
vi.mock('../src/lib/panelOrigin.js', () => ({ panelOrigin: vi.fn(async () => 'https://panel.example.com') }));

const { pushedImages, pushMatchesImage } = await import('../src/lib/registryHooks.js');
const { publicRegistryHookRoutes, serviceRegistryHookRoutes } = await import('../src/modules/registryHooks.js');
const { asUser, buildTestApp } = await import('./helpers.js');

describe('pushedImages', () => {
  it('reads Docker Hub, GitHub Packages, Harbor, registry:2 and a plain CI payload', () => {
    expect(pushedImages({ push_data: { tag: 'latest' }, repository: { repo_name: 'acme/api' } })).toEqual([
      { registry: 'index.docker.io', repository: 'acme/api', tag: 'latest' },
    ]);
    expect(pushedImages({ push_data: { tag: '1.27' }, repository: { repo_name: 'nginx' } })[0]).toMatchObject({ repository: 'library/nginx', tag: '1.27' });
    expect(
      pushedImages({
        action: 'published',
        registry_package: { name: 'API', namespace: 'Acme', package_type: 'CONTAINER', package_version: { container_metadata: { tag: { name: 'v2' } } } },
      }),
    ).toEqual([{ registry: 'ghcr.io', repository: 'acme/api', tag: 'v2' }]);
    expect(pushedImages({ registry_package: { name: 'lib', namespace: 'acme', package_type: 'npm', package_version: {} } })).toEqual([]);
    expect(
      pushedImages({ type: 'PUSH_ARTIFACT', event_data: { resources: [{ tag: 'main', resource_url: 'harbor.example.com/proj/api:main' }] } }),
    ).toEqual([{ registry: 'harbor.example.com', repository: 'proj/api', tag: 'main' }]);
    expect(
      pushedImages({
        events: [
          { action: 'pull', target: { repository: 'x/y', tag: 'a' } },
          { action: 'push', target: { repository: 'team/api', tag: 'prod' }, request: { host: 'registry.example.com:5000' } },
          { action: 'push', target: { repository: 'team/api', digest: 'sha256:abc' } },
        ],
      }),
    ).toEqual([{ registry: 'registry.example.com:5000', repository: 'team/api', tag: 'prod' }]);
    expect(pushedImages({ image: 'ghcr.io/acme/api:v3' })).toEqual([{ registry: 'ghcr.io', repository: 'acme/api', tag: 'v3' }]);
    expect(pushedImages({ repository: 'acme/api' })[0]).toMatchObject({ repository: 'acme/api', tag: 'latest' });
    expect(pushedImages('nope')).toEqual([]);
    expect(pushedImages({ image: 'acme/api@sha256:abc' })).toEqual([]);
  });

  it('matches the same repository and tag, and the registry when the payload names one', () => {
    expect(pushMatchesImage({ registry: 'index.docker.io', repository: 'library/nginx', tag: 'latest' }, 'nginx')).toBe(true);
    expect(pushMatchesImage({ registry: 'docker.io', repository: 'acme/api', tag: 'v1' }, 'acme/api:v1')).toBe(true);
    expect(pushMatchesImage({ registry: 'index.docker.io', repository: 'acme/api', tag: 'v2' }, 'acme/api:v1')).toBe(false);
    expect(pushMatchesImage({ registry: 'ghcr.io', repository: 'acme/api', tag: 'v1' }, 'acme/api:v1')).toBe(false);
    expect(pushMatchesImage({ registry: null, repository: 'acme/api', tag: 'v1' }, 'registry.example.com/acme/api:v1')).toBe(true);
    expect(pushMatchesImage({ registry: 'ghcr.io', repository: 'acme/api', tag: 'v1' }, 'ghcr.io/acme/api@sha256:abc')).toBe(false);
  });
});

let db: DB;
const OWNER = 7;
const member = asUser({ id: OWNER, isOperator: false });
const tokenPath = (url: string) => /\/v1(\/registry-hooks\/\d+\/[A-Za-z0-9_-]{32})$/.exec(url)![1]!;
const hub = (repo: string, tag: string) => ({ push_data: { tag }, repository: { repo_name: repo } });

beforeEach(async () => {
  vi.clearAllMocks();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 1, email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true },
    { id: OWNER, email: 'owner@example.com', passwordHash: 'x' },
  ]);
});

async function setup(values: Record<string, unknown> = {}) {
  const [svc] = await db
    .insert(services)
    .values({ name: 'api', slug: 'api', type: 'docker', image: 'acme/api:v1', branch: 'main', ownerUserId: OWNER, autoUpdateDigest: 'sha256:old', ...values } as never)
    .returning();
  const app = await buildTestApp({ db });
  await app.register(serviceRegistryHookRoutes, { prefix: '/services' });
  await app.register(publicRegistryHookRoutes, { prefix: '/registry-hooks' });
  const queued = async () => db.select().from(deployments).where(eq(deployments.serviceId, svc!.id));
  return { app, id: svc!.id, queued };
}

describe('registry hook routes', () => {
  it('shows the URL once, stores only its hash, rotates and turns off', async () => {
    const { app, id } = await setup();
    expect((await app.inject({ method: 'GET', url: `/services/${id}/registry-hook`, headers: member })).json()).toMatchObject({ enabled: false, url: null });
    const on = (await app.inject({ method: 'POST', url: `/services/${id}/registry-hook`, headers: member })).json() as { url: string; mine: boolean };
    expect(on.url).toMatch(new RegExp(`^https://panel\\.example\\.com/v1/registry-hooks/${id}/[A-Za-z0-9_-]{32}$`));
    expect(on.mine).toBe(true);
    const row = await db.query.settings.findFirst({ where: eq(settings.key, `registry_hook:${id}`) });
    expect(JSON.stringify(row?.value)).not.toContain(on.url.split('/').pop()!);
    expect((await app.inject({ method: 'GET', url: `/services/${id}/registry-hook`, headers: member })).json()).toMatchObject({ enabled: true, url: null, mine: true });

    const rotated = (await app.inject({ method: 'POST', url: `/services/${id}/registry-hook`, headers: member })).json() as { url: string };
    expect(auditMock.audit).toHaveBeenCalledWith(db, OWNER, 'service.registry_hook.rotate', 'api', { serviceId: id });
    expect((await app.inject({ method: 'POST', url: tokenPath(on.url), payload: hub('acme/api', 'v1') })).statusCode).toBe(404);
    await app.inject({ method: 'DELETE', url: `/services/${id}/registry-hook`, headers: member });
    expect((await app.inject({ method: 'POST', url: tokenPath(rotated.url), payload: hub('acme/api', 'v1') })).statusCode).toBe(404);
    await app.close();
  });

  it('refuses a service that is not deployed from an image', async () => {
    const { app, id } = await setup({ type: 'git', image: null, repoUrl: 'https://github.com/acme/api' });
    const res = await app.inject({ method: 'POST', url: `/services/${id}/registry-hook`, headers: member });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_an_image_service');
    await app.close();
  });

  it("deploys for the service's own image and tag only, once per queued deploy, as the hook's member", async () => {
    const { app, id, queued } = await setup();
    const { url } = (await app.inject({ method: 'POST', url: `/services/${id}/registry-hook`, headers: member })).json() as { url: string };
    const path = tokenPath(url);

    const other = await app.inject({ method: 'POST', url: path, payload: hub('acme/api', 'v2') });
    expect(other.statusCode).toBe(202);
    expect(other.json()).toMatchObject({ ignored: true });
    expect(await queued()).toHaveLength(0);

    const res = await app.inject({ method: 'POST', url: path, payload: hub('acme/api', 'v1') });
    expect(res.statusCode).toBe(202);
    const { deploymentId } = res.json() as { deploymentId: number };
    expect(deploymentId).toBeGreaterThan(0);
    expect(auditMock.audit).toHaveBeenCalledWith(db, OWNER, 'deploy.trigger', `api #${deploymentId}`, { serviceId: id, deploymentId, via: 'registry_hook' });
    expect((await db.query.services.findFirst({ where: eq(services.id, id) }))?.autoUpdateDigest).toBeNull();

    // A registry retry while the deploy has not started answers with it.
    const again = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/vnd.docker.distribution.events.v2+json' },
      payload: JSON.stringify({ events: [{ action: 'push', target: { repository: 'acme/api', tag: 'v1' } }] }),
    });
    expect(again.json()).toEqual({ deploymentId, alreadyQueued: true });
    expect(await queued()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/services/${id}/registry-hook`, headers: member })).json().lastPushAt).toEqual(expect.any(String));
    await app.close();
  });

  it('answers 404 once the member who made it is deleted, and for a malformed path', async () => {
    const { app, id } = await setup();
    const { url } = (await app.inject({ method: 'POST', url: `/services/${id}/registry-hook`, headers: member })).json() as { url: string };
    expect((await app.inject({ method: 'POST', url: `/registry-hooks/${id}/short`, payload: hub('acme/api', 'v1') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/registry-hooks/abc/${'a'.repeat(32)}`, payload: {} })).statusCode).toBe(404);
    await db.update(services).set({ ownerUserId: null }).where(eq(services.id, id));
    await db.delete(users).where(eq(users.id, OWNER));
    expect((await app.inject({ method: 'POST', url: tokenPath(url), payload: hub('acme/api', 'v1') })).statusCode).toBe(404);
    await app.close();
  });
});
