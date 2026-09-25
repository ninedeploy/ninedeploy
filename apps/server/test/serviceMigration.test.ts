import { describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import { serviceMigrationRoutes } from '../src/modules/serviceMigration.js';
import { asUser, buildTestApp, captureAudits, createFakeDb, dbRow, svcRow } from './helpers.js';

// r351: the retained-volume probe asks Docker; stubbed here, asserted as wired below.
const retainedMocks = vi.hoisted(() => ({ assertSlugVolumeNotRetained: vi.fn(async (_slug: string, _type: string) => undefined) }));
vi.mock('../src/lib/retainedSlugVolume.js', () => retainedMocks);

async function buildApp(db: ReturnType<typeof createFakeDb>) {
  const app = await buildTestApp({ db });
  await app.register(serviceMigrationRoutes, { prefix: '/services' });
  return app;
}

describe('service migration routes', () => {
  describe('GET /services/:id/export', () => {
    it('exports a full service bundle', async () => {
      const app = await buildApp(
        createFakeDb({
          findFirst: {
            services: svcRow({ repoUrl: 'https://github.com/acme/web.git', image: null, cpuShares: 512, memLimitMb: 256 }),
            buildConfigs: { id: 9, serviceId: 1, buildPack: 'auto', baseDir: '/app', installCmd: 'npm i', buildCmd: null, startCmd: 'npm start', dockerfilePath: 'Dockerfile' },
            databases: dbRow({ id: 10, name: 'pg', engine: 'postgres' }),
          },
          findMany: {
            envVars: [{ id: 1, serviceId: 1, key: 'PORT', valueEncrypted: encrypt('3000'), isSecret: false }],
            domains: [{ id: 1, serviceId: 1, hostname: 'web.example.com', path: '/', ssl: true }],
            webhooks: [{ id: 1, serviceId: 1, branch: 'main', events: ['push'], secretEncrypted: encrypt('hooksecret') }],
            databaseAttachments: [{ id: 1, serviceId: 1, databaseId: 10, envAlias: 'DB_URL' }],
          },
        }),
      );

      const res = await app.inject({ method: 'GET', url: '/services/1/export', headers: asUser() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.version).toBe('1.0.0');
      expect(body.service).toMatchObject({ name: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', cpuShares: 512, memLimitMb: 256 });
      expect(body.buildConfig).toMatchObject({ buildPack: 'auto', baseDir: '/app', installCmd: 'npm i', startCmd: 'npm start' });
      expect(body.envVars).toEqual([{ key: 'PORT', value: '3000', isSecret: false }]);
      expect(body.domains).toEqual([{ hostname: 'web.example.com', path: '/', ssl: true }]);
      expect(body.webhooks).toEqual([{ branch: 'main', events: ['push'], secret: 'hooksecret' }]);
      expect(body.attachments).toEqual([{ envAlias: 'DB_URL', databaseName: 'pg', databaseEngine: 'postgres' }]);
      expect(res.headers['content-disposition']).toContain('web-export.json');
    });

    it('r283: an export (every secret in plaintext) writes a service.export audit row without the values', async () => {
      const db = createFakeDb({
        findFirst: { services: svcRow() },
        findMany: {
          envVars: [{ id: 1, serviceId: 1, key: 'DB_PASSWORD', valueEncrypted: encrypt('hunter2'), isSecret: true }],
          webhooks: [{ id: 1, serviceId: 1, branch: 'main', events: ['push'], secretEncrypted: encrypt('hooksecret') }],
        },
      });
      const audits = captureAudits(db);
      const app = await buildApp(db);
      const res = await app.inject({ method: 'GET', url: '/services/1/export', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(audits).toEqual([
        expect.objectContaining({ action: 'service.export', entity: 'web', meta: expect.objectContaining({ envVars: 1, webhooks: 1 }) }),
      ]);
      expect(JSON.stringify(audits)).not.toMatch(/hunter2|hooksecret/);
    });

    it('exports with no build config and skips attachments whose database is missing', async () => {
      const app = await buildApp(
        createFakeDb({
          findFirst: { services: svcRow(), buildConfigs: undefined, databases: undefined },
          findMany: {
            envVars: [],
            domains: [],
            webhooks: [],
            databaseAttachments: [{ id: 1, serviceId: 1, databaseId: 99, envAlias: 'MISSING' }],
          },
        }),
      );

      const res = await app.inject({ method: 'GET', url: '/services/1/export', headers: asUser() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.buildConfig).toBeNull();
      expect(body.attachments).toEqual([]);
    });

    it('returns 404 for an unknown service', async () => {
      const app = await buildApp(createFakeDb({ findFirst: { services: undefined } }));
      const res = await app.inject({ method: 'GET', url: '/services/999/export', headers: asUser() });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /services/import', () => {
    const bundle = {
      version: '1.0.0',
      exportedAt: '2026-01-01T00:00:00.000Z',
      service: { name: 'Imported', type: 'docker', repoUrl: null, branch: 'main', image: null, port: 3000, volumeMount: null, healthPath: '', cpuShares: 0, memLimitMb: 0 },
      buildConfig: { buildPack: 'auto', baseDir: '', installCmd: null, buildCmd: null, startCmd: null, dockerfilePath: null },
      envVars: [{ key: 'PORT', value: '3000', isSecret: false }],
      domains: [{ hostname: 'imported.example.com', path: '/', ssl: false }, { hostname: 'internal-only', path: '/', ssl: false }],
      webhooks: [{ branch: 'main', events: ['push'], secret: 'hooksecret' }],
      attachments: [{ envAlias: 'DB_URL', databaseName: 'pg', databaseEngine: 'postgres' }, { envAlias: 'MISSING', databaseName: 'gone', databaseEngine: 'redis' }],
    };

    it('rejects a bundle without service data', async () => {
      const app = await buildApp(createFakeDb());
      const res = await app.inject({ method: 'POST', url: '/services/import', headers: asUser(), payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('Invalid bundle');
    });

    it('rejects a bundle with an unknown service type', async () => {
      const app = await buildApp(createFakeDb());
      const res = await app.inject({
        method: 'POST', url: '/services/import', headers: asUser(),
        payload: { ...bundle, service: { ...bundle.service, type: 'k8s' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('service.type');
    });

    it('rejects a bundle with an env var key that would inject into the env-file', async () => {
      const app = await buildApp(createFakeDb());
      const res = await app.inject({
        method: 'POST', url: '/services/import', headers: asUser(),
        payload: { ...bundle, envVars: [{ key: 'EV=IL\nNEW=1', value: 'x', isSecret: false }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('bad env var key');
    });

    it('rejects a bundle with a non-string env var value', async () => {
      const app = await buildApp(createFakeDb());
      const res = await app.inject({
        method: 'POST', url: '/services/import', headers: asUser(),
        payload: { ...bundle, envVars: [{ key: 'OK', value: 42, isSecret: false }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('has no value');
    });

    it('imports a bundle whose optional arrays are missing (defaults to empty)', async () => {
      const { envVars: _e, domains: _d, webhooks: _w, attachments: _a, buildConfig: _b, ...bare } = bundle;
      const app = await buildApp(createFakeDb({ insert: { services: () => [svcRow({ id: 9 })] } }));
      const res = await app.inject({ method: 'POST', url: '/services/import', headers: asUser(), payload: bare });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('r351: gates the imported slug on a deleted service\'s retained volume before inserting', async () => {
      const { HttpError } = await import('../src/lib/errors.js');
      retainedMocks.assertSlugVolumeNotRetained.mockRejectedValueOnce(new HttpError(409, 'slug_volume_retained', 'retained'));
      const db = createFakeDb({ insert: { services: () => [svcRow({ id: 9 })] } });
      const insert = vi.spyOn(db, 'insert');
      const app = await buildApp(db);
      const res = await app.inject({ method: 'POST', url: '/services/import', headers: asUser(), payload: bundle });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('slug_volume_retained');
      const [slug, type] = retainedMocks.assertSlugVolumeNotRetained.mock.calls.at(-1)!;
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(type).toBe(bundle.service.type);
      expect(insert).not.toHaveBeenCalled();
    });

    it('imports a full bundle and recreates every entity', async () => {
      const inserted: string[] = [];
      const app = await buildApp(
        createFakeDb({
          findFirst: { databases: dbRow({ id: 10, name: 'pg', engine: 'postgres' }) },
          insert: {
            services: () => { inserted.push('services'); return [svcRow({ id: 7, name: 'Imported' })]; },
            build_configs: () => { inserted.push('buildConfigs'); return [{}]; },
            env_vars: () => { inserted.push('envVars'); return [{}]; },
            domains: () => { inserted.push('domains'); return [{}]; },
            webhooks: () => { inserted.push('webhooks'); return [{}]; },
            database_attachments: () => { inserted.push('databaseAttachments'); return [{}]; },
          },
        }),
      );

      const res = await app.inject({ method: 'POST', url: '/services/import', headers: asUser(), payload: bundle });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.serviceId).toBe(7);
      expect(body.slug).toMatch(/^imported-[a-z0-9]+$/);
      expect(body.message).toContain('Imported');
      expect(inserted).toEqual(expect.arrayContaining(['services', 'buildConfigs', 'envVars', 'domains', 'webhooks', 'databaseAttachments']));
      // Only the custom domain (with a dot) is recreated; the internal-only one is skipped.
      expect(inserted.filter((i) => i === 'domains')).toHaveLength(1);
    });

    it('skips build config when absent and skips unmatched attachments', async () => {
      const inserted: string[] = [];
      const app = await buildApp(
        createFakeDb({
          findFirst: { databases: undefined },
          insert: {
            services: () => { inserted.push('services'); return [svcRow({ id: 2 })]; },
            build_configs: () => { inserted.push('buildConfigs'); return [{}]; },
            env_vars: () => { inserted.push('envVars'); return [{}]; },
            domains: () => { inserted.push('domains'); return [{}]; },
            webhooks: () => { inserted.push('webhooks'); return [{}]; },
            database_attachments: () => { inserted.push('databaseAttachments'); return [{}]; },
          },
        }),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/services/import',
        headers: asUser(),
        payload: { ...bundle, buildConfig: null },
      });
      expect(res.statusCode).toBe(200);
      expect(inserted).not.toContain('buildConfigs');
      expect(inserted).not.toContain('databaseAttachments');
    });

    it('returns 400 when the service insert fails', async () => {
      const app = await buildApp(
        createFakeDb({
          insert: { services: () => [] },
        }),
      );
      const res = await app.inject({ method: 'POST', url: '/services/import', headers: asUser(), payload: bundle });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('Could not create service');
    });
  });
});
