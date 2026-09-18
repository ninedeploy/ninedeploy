import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

interface RecordedInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface RecordedCall {
  url: string;
  init: RecordedInit;
}

interface FakeResponse {
  status: number;
  body?: unknown;
}

function makeFetch(respond: (url: string, init: RecordedInit) => FakeResponse) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init: RecordedInit) => {
    calls.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), init });
    const { status, body } = respond(url, init);
    const bodyStr = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => bodyStr,
      json: async () => (bodyStr === '' ? undefined : JSON.parse(bodyStr)),
    } as unknown as Response;
  });
  return { fetchMock, calls };
}

const ok = (body?: unknown): FakeResponse => ({ status: 200, body });

describe('Sprint 11 SDK surface (G-13 / G-15 / G-30 / G-24 / G-47 / G-16)', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe('templates.community', () => {
    it('list calls GET /v1/templates/community', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ entries: [], totalBytes: 0, errors: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.templates.community.list();
      expect(res.entries).toEqual([]);
      expect(calls[0]?.url).toBe('/v1/templates/community');
      expect(calls[0]?.init.method).toBe('GET');
    });

    it('import sends POST /v1/templates/community/import with content + replace', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ ok: true, id: 'c1', file: 'c1.json', bytes: 5 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.templates.community.import('{"a":1}', { replace: true });
      expect(res).toEqual({ ok: true, id: 'c1', file: 'c1.json', bytes: 5 });
      expect(calls[0]?.url).toBe('/v1/templates/community/import');
      expect(calls[0]?.init.method).toBe('POST');
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({
        content: '{"a":1}',
        replace: true,
      });
    });

    it('remove sends DELETE /v1/templates/community/<id>', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ ok: true, id: 'c1', removed: true }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.templates.community.remove('c1');
      expect(res.removed).toBe(true);
      expect(calls[0]?.url).toBe('/v1/templates/community/c1');
      expect(calls[0]?.init.method).toBe('DELETE');
    });

    it('import without opts sends an empty options object (branch coverage)', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ ok: true, id: 'c1', file: 'c1.json', bytes: 5 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.templates.community.import('{}');
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ content: '{}' });
    });
  });

  describe('traefik certificate inventory', () => {
    it('certificateInventory forwards the threshold and parses the report', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({
          summary: {
            total: 1,
            valid: 1,
            expiringSoon: 0,
            expired: 0,
            expiringThresholdDays: 7,
            fetchedAt: '2026-01-01T00:00:00Z',
          },
          certificates: [
            {
              host: 'a.example.com',
              status: 'valid',
              daysToExpiry: 90,
              notAfter: '2026-04-01T00:00:00Z',
              autoRenew: true,
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.traefik.certificateInventory({ threshold: 7 });
      expect(res.summary.total).toBe(1);
      expect(calls[0]?.url).toBe('/v1/traefik/certificates/inventory?threshold=7');
    });

    it('expiringCertificates forwards the days window', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ threshold: 30, count: 0, certificates: [] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.traefik.expiringCertificates({ days: 30 });
      expect(res.count).toBe(0);
      expect(calls[0]?.url).toBe('/v1/traefik/certificates/expiring?days=30');
    });

    it('certificateInventory without opts omits the threshold query string', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ summary: { total: 0, valid: 0, expiringSoon: 0, expired: 0, expiringThresholdDays: 30, fetchedAt: 'x' }, certificates: [] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.traefik.certificateInventory();
      expect(calls[0]?.url).toBe('/v1/traefik/certificates/inventory');
    });

    it('expiringCertificates without opts omits the days query string', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ threshold: 30, count: 0, certificates: [] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.traefik.expiringCertificates();
      expect(calls[0]?.url).toBe('/v1/traefik/certificates/expiring');
    });
  });

  describe('plugins.marketplace', () => {
    it('uses the default (no refresh) URL when opts is omitted', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ entries: [], refreshedAt: '2026-01-01T00:00:00Z' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.plugins.marketplace();
      expect(res.entries).toEqual([]);
      expect(calls[0]?.url).toBe('/v1/plugins/marketplace');
    });

    it('appends ?refresh=true when opts.refresh is true', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ entries: [], refreshedAt: '2026-01-01T00:00:00Z' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.plugins.marketplace({ refresh: true });
      expect(calls[0]?.url).toBe('/v1/plugins/marketplace?refresh=true');
    });
  });

  describe('logDrains.search', () => {
    it('sends the search body to /v1/log-drains/search', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ lines: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.logDrains.search({ query: 'error' });
      expect(res.lines).toEqual([]);
      expect(calls[0]?.url).toBe('/v1/log-drains/search');
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ query: 'error' });
    });
  });

  describe('emailTemplates (G-30)', () => {
    it('list calls GET /v1/workspaces/<id>/email-templates', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ workspaceId: 1, templates: [] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.emailTemplates.list(1);
      expect(res.workspaceId).toBe(1);
      expect(calls[0]?.url).toBe('/v1/workspaces/1/email-templates');
    });

    it('preview posts name + vars (defaulting vars to {})', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ subject: 'S', text: 'T', overridden: false }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.emailTemplates.preview(1, 'password-reset');
      expect(res.subject).toBe('S');
      expect(calls[0]?.url).toBe('/v1/workspaces/1/email-templates/preview');
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({
        name: 'password-reset',
        vars: {},
      });
    });

    it('set PUTs subject + text', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.emailTemplates.set(1, 'password-reset', 'S', 'T');
      expect(res.ok).toBe(true);
      expect(calls[0]?.url).toBe('/v1/workspaces/1/email-templates/password-reset');
      expect(calls[0]?.init.method).toBe('PUT');
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ subject: 'S', text: 'T' });
    });

    it('reset DELETEs the override', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.emailTemplates.reset(1, 'password-reset');
      expect(res.ok).toBe(true);
      expect(calls[0]?.url).toBe('/v1/workspaces/1/email-templates/password-reset');
      expect(calls[0]?.init.method).toBe('DELETE');
    });
  });

  describe('housekeeping images (G-47)', () => {
    it('listImages calls GET /v1/housekeeping/images', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ images: [], totalCount: 0, totalBytes: 0 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.housekeeping.listImages();
      expect(res.totalCount).toBe(0);
      expect(calls[0]?.url).toBe('/v1/housekeeping/images');
    });

    it('pruneImages posts the filter body to /v1/housekeeping/images/prune', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ removed: [], freedBytes: 0, dryRun: false }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.housekeeping.pruneImages({ keepLast: 5 });
      expect(res.freedBytes).toBe(0);
      expect(calls[0]?.url).toBe('/v1/housekeeping/images/prune');
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ keepLast: 5 });
    });
  });

  describe('settings.namecheap (G-25 follow-up)', () => {
    it('get calls GET /v1/settings/dns-records/namecheap', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ configured: true, apiUser: 'u', clientIp: '1.2.3.4', hasKey: true }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.settings.namecheap.get();
      expect(res.configured).toBe(true);
      expect(calls[0]?.url).toBe('/v1/settings/dns-records/namecheap');
    });

    it('set PUTs the namecheap config', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true, apiUser: 'u' }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.settings.namecheap.set({ apiUser: 'u', apiKey: 'k' });
      expect(res.ok).toBe(true);
      expect(calls[0]?.url).toBe('/v1/settings/dns-records/namecheap');
      expect(calls[0]?.init.method).toBe('PUT');
    });
  });

  describe('databases backupDrill / pgbouncer (G-17 / G-32)', () => {
    it('drillBackup posts to /v1/databases/<id>/backups/drill', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({
          id: 1,
          status: 'passed',
          durationMs: 100,
          error: null,
          details: { tool: 'pg_restore' },
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:00:01Z',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.databases.drillBackup(1, { backupId: 2 });
      expect(res.status).toBe('passed');
      expect(calls[0]?.url).toBe('/v1/databases/1/backups/drill');
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ backupId: 2 });
    });

    it('drills lists /v1/databases/<id>/drills', async () => {
      const { fetchMock, calls } = makeFetch(() => ok([]));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.databases.drills(1);
      expect(res).toEqual([]);
      expect(calls[0]?.url).toBe('/v1/databases/1/drills');
    });

    it('pgbouncerStatus / enable / disable pgbouncer', async () => {
      const status = {
        enabled: true,
        containerName: 'nd-pgb-mydb',
        port: 6432,
        running: true,
        poolMode: 'transaction',
        pooledConnectionString: 'postgres://nine:plainpw@nd-pgb-mydb:6432/app',
      };
      const { fetchMock, calls } = makeFetch(() => ok(status));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const s = await client.databases.pgbouncerStatus(1);
      expect(s.enabled).toBe(true);
      expect(calls[0]?.url).toBe('/v1/databases/1/pgbouncer');
      await client.databases.enablePgbouncer(1, { port: 7000 });
      expect(calls[1]?.url).toBe('/v1/databases/1/pgbouncer/enable');
      expect(calls[1]?.init.method).toBe('POST');
      expect(JSON.parse(calls[1]?.init.body ?? '{}')).toEqual({ port: 7000 });
      await client.databases.disablePgbouncer(1);
      expect(calls[2]?.url).toBe('/v1/databases/1/pgbouncer/disable');
      expect(calls[2]?.init.method).toBe('POST');
    });

    it('enablePgbouncer works with no input (defaults to {})', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ enabled: true }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.databases.enablePgbouncer(1);
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({});
    });
  });

  describe('domainTransfers (G-29)', () => {
    it('transfer posts to /v1/domains/<id>/transfer', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ transferId: 1, acceptUrl: 'https://panel/x', expiresAt: '2026-02-01T00:00:00Z' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.domains.transfer(1, { targetEmail: 'a@b.com' });
      expect(res.transferId).toBe(1);
      expect(calls[0]?.url).toBe('/v1/domains/1/transfer');
    });

    it('previewTransfer / acceptTransfer / cancelTransfer', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ transferId: 1, hostname: 'x.com', status: 'pending' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.domains.previewTransfer('tok');
      expect(calls[0]?.url).toBe('/v1/domain-transfers/tok');
      expect(calls[0]?.init.method).toBe('GET');
      await client.domains.acceptTransfer('tok', { targetServiceId: 2 });
      expect(calls[1]?.url).toBe('/v1/domain-transfers/tok/accept');
      await client.domains.cancelTransfer('tok');
      expect(calls[2]?.url).toBe('/v1/domain-transfers/tok/cancel');
    });
  });

  describe('domainPresets / configPresets / orchestrators / branding / egress / sso', () => {
    it('domainPresets.list / apply', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ providers: ['cloudflare'] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.domainPresets.list();
      expect(res.providers).toEqual(['cloudflare']);
      expect(calls[0]?.url).toBe('/v1/domain-presets');
      await client.domainPresets.apply({ hostname: 'x.com', provider: 'cloudflare' });
      expect(calls[1]?.url).toBe('/v1/domain-presets/apply');
    });

    it('configPresets CRUD round-trip', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true, id: 'p1', keyCount: 2 }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.configPresets.list();
      expect(calls[0]?.url).toBe('/v1/config-presets');
      await client.configPresets.get('p1');
      expect(calls[1]?.url).toBe('/v1/config-presets/p1');
      await client.configPresets.register({ id: 'p1', description: 'd', values: {} });
      expect(calls[2]?.url).toBe('/v1/config-presets');
      expect(calls[2]?.init.method).toBe('POST');
      await client.configPresets.apply('p1');
      expect(calls[3]?.url).toBe('/v1/config-presets/p1/apply');
      expect(calls[3]?.init.method).toBe('PUT');
      await client.configPresets.remove('p1');
      expect(calls[4]?.url).toBe('/v1/config-presets/p1');
      expect(calls[4]?.init.method).toBe('DELETE');
    });

    it('configPresets.apply forwards opts when provided', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ ok: true, id: 'p1' }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.configPresets.apply('p1', { values: { x: 1 } });
      expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ values: { x: 1 } });
    });

    it('orchestrators.list / stacks / stackStatus', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ orchestrators: [{ name: 'default', stacks: [] }] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.orchestrators.list();
      expect(res.orchestrators[0]?.name).toBe('default');
      expect(calls[0]?.url).toBe('/v1/orchestrators');

      await client.orchestrators.stacks('default');
      expect(calls[1]?.url).toBe('/v1/orchestrators/default/stacks');

      // r036: the stack is addressed by its own segment. Passing only the
      // orchestrator meant the API asked for a stack named after the
      // orchestrator and answered null for every real one.
      await client.orchestrators.stackStatus('swarm', 'web');
      expect(calls[2]?.url).toBe('/v1/orchestrators/swarm/stacks/web');
    });

    it('branding.get / set', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ logoUrl: null, primaryColor: null, supportEmail: null, footerHtml: null }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.branding.get();
      expect(res.logoUrl).toBeNull();
      expect(calls[0]?.url).toBe('/v1/branding');
      await client.branding.set({ logoUrl: 'https://x' });
      expect(calls[1]?.url).toBe('/v1/branding');
      expect(calls[1]?.init.method).toBe('PATCH');
    });

    it('egress.list / set / clear', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ drivers: [] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.egress.list();
      expect(calls[0]?.url).toBe('/v1/egress');
      await client.egress.set({ driver: 'default', selector: { projectId: 1 }, ip: '1.2.3.4' });
      expect(calls[1]?.url).toBe('/v1/egress');
      expect(calls[1]?.init.method).toBe('POST');
      await client.egress.clear(1);
      expect(calls[2]?.url).toBe('/v1/egress/1');
      expect(calls[2]?.init.method).toBe('DELETE');
      await client.egress.clear(2, 'wg-quick');
      expect(calls[3]?.url).toBe('/v1/egress/2?driver=wg-quick');
    });

    it('sso providers CRUD', async () => {
      const { fetchMock, calls } = makeFetch(() => ok({ providers: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      await client.sso.listProviders();
      expect(calls[0]?.url).toBe('/v1/sso/providers');
      await client.sso.addProvider({ type: 'oidc', name: 'okta', config: {} });
      expect(calls[1]?.url).toBe('/v1/sso/providers');
      expect(calls[1]?.init.method).toBe('POST');
      await client.sso.removeProvider(1);
      expect(calls[2]?.url).toBe('/v1/sso/providers/1');
      expect(calls[2]?.init.method).toBe('DELETE');
    });
  });

  describe('auth.introspectToken / services.manifest.apply (Sprint 11 follow-ups)', () => {
    it('introspectToken calls GET /v1/auth/token', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ active: true, userId: 1, scopes: [], expiresAt: '2026-02-01T00:00:00Z' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.auth.introspectToken();
      expect(res.active).toBe(true);
      expect(calls[0]?.url).toBe('/v1/auth/token');
    });

    it('services.manifest.apply posts the manifest to /v1/services/<id>/manifest/apply', async () => {
      const { fetchMock, calls } = makeFetch(() =>
        ok({ ok: true, serviceId: 1, touched: ['service', 'build_config'], diff: { service: {}, build: {} } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = createClient({ baseUrl: 'https://panel.test', token: 't' });
      const res = await client.services.manifest.apply(1, {
        manifest: { version: '1', run: { port: 3000 } },
        strategy: 'merge',
      });
      expect(res.ok).toBe(true);
      expect(calls[0]?.url).toBe('/v1/services/1/manifest/apply');
      expect(calls[0]?.init.method).toBe('POST');
    });
  });
});
