import { afterEach, describe, expect, it } from 'vitest';
import { brandingRoutes, _resetBrandingCacheForTests } from '../../src/modules/branding.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

/**
 * The `branding` route module is a thin shell over the kernel's
 * `IConfigCenter` for four override fields (`logoUrl`,
 * `primaryColor`, `supportEmail`, `footerHtml`). The values
 * are cached in process for 60 s; the cache is invalidated on
 * every successful PATCH. This file pins that contract.
 */
describe('branding routes', () => {
  afterEach(() => {
    // The cache is module-level state; clear it between tests
    // so a PATCH in one test cannot poison the next test's
    // GET (the cache would otherwise return a stale value
    // until the 60-second TTL elapses).
    _resetBrandingCacheForTests();
  });

  describe('GET /', () => {
    it('returns the four branding fields as null when no overrides are set', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        logoUrl: null,
        primaryColor: null,
        supportEmail: null,
        footerHtml: null,
      });
      await app.close();
    });

    it('returns the stored overrides verbatim (not coerced or normalized)', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      // Pre-populate the config center with the four overrides.
      // The route reads them via `configCenter.get<string | null>(...)`,
      // so a string in → a string out.
      await app.kernel.configCenter.set('branding:logoUrl', 'https://cdn.example.com/logo.svg', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'seed logoUrl',
      });
      await app.kernel.configCenter.set('branding:primaryColor', '#3366ff', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'seed primaryColor',
      });
      await app.kernel.configCenter.set('branding:supportEmail', 'help@example.com', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'seed supportEmail',
      });
      await app.kernel.configCenter.set('branding:footerHtml', '<p>© Example</p>', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'seed footerHtml',
      });
      await app.register(brandingRoutes);
      const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        logoUrl: 'https://cdn.example.com/logo.svg',
        primaryColor: '#3366ff',
        supportEmail: 'help@example.com',
        footerHtml: '<p>© Example</p>',
      });
      await app.close();
    });

    it('coerces an empty string override to null (so the panel can render defaults)', async () => {
      // The route does `typeof x === 'string' && x.length > 0 ? x : null`
      // — the operator can PATCH a value and then clear it by
      // PATCHing an empty string without a separate DELETE
      // endpoint. The GET should report `null` for the cleared
      // field so the panel renders the default.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.kernel.configCenter.set('branding:logoUrl', '', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'empty logoUrl',
      });
      await app.register(brandingRoutes);
      const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(res.json()).toMatchObject({ logoUrl: null });
      await app.close();
    });

    it('serves subsequent GETs from the 60-second in-process cache', async () => {
      // First call populates the cache from the config center;
      // second call must hit the cache (no second read). We
      // verify by mutating the config center between the two
      // GETs — the cached value should win.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      const first = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(first.json()).toEqual({
        logoUrl: null,
        primaryColor: null,
        supportEmail: null,
        footerHtml: null,
      });
      // Now seed an override DIRECTLY into the config center
      // (bypassing the route + cache invalidation). A fresh
      // GET that reads from the DB would see it; a cached GET
      // would still report null.
      await app.kernel.configCenter.set('branding:logoUrl', 'https://direct.example.com/logo.svg', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'direct seed',
      });
      const second = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      // The cache must still hold the previous (null) value.
      expect(second.json()).toEqual({
        logoUrl: null,
        primaryColor: null,
        supportEmail: null,
        footerHtml: null,
      });
      await app.close();
    });
  });

  describe('PATCH /', () => {
    it('persists each provided field and returns { ok: true }', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: asUser(),
        payload: {
          logoUrl: 'https://cdn.example.com/logo.svg',
          primaryColor: '#3366ff',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      // The persisted values are visible on a fresh GET — the
      // PATCH must have invalidated the cache for the next
      // read to see them.
      const get = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(get.json()).toMatchObject({
        logoUrl: 'https://cdn.example.com/logo.svg',
        primaryColor: '#3366ff',
        supportEmail: null,
        footerHtml: null,
      });
      await app.close();
    });

    it('persists supportEmail and footerHtml when they are the only fields provided', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: asUser(),
        payload: { supportEmail: 'help@example.com', footerHtml: '<p>© Example</p>' },
      });
      expect(res.statusCode).toBe(200);
      const get = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(get.json()).toMatchObject({
        logoUrl: null,
        primaryColor: null,
        supportEmail: 'help@example.com',
        footerHtml: '<p>© Example</p>',
      });
      await app.close();
    });

    it('skips fields that are not in the payload (undefined does not clear)', async () => {
      // The route's guard is `if (body[f] !== undefined)` — a
      // missing field is a no-op, NOT a clear. The operator
      // PATCHes a single field and the others keep their
      // previous value.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      // Seed logoUrl and primaryColor.
      await app.kernel.configCenter.set('branding:logoUrl', 'https://seed.example.com/logo.svg', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'seed logoUrl',
      });
      await app.kernel.configCenter.set('branding:primaryColor', '#000000', {
        isSecret: false,
        category: 'branding',
        pluginId: 'g30-branding',
        userId: 1,
        description: 'seed primaryColor',
      });
      _resetBrandingCacheForTests();
      // PATCH only the supportEmail; the seeded values must survive.
      const patch = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: asUser(),
        payload: { supportEmail: 'help@example.com' },
      });
      expect(patch.statusCode).toBe(200);
      const get = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(get.json()).toEqual({
        logoUrl: 'https://seed.example.com/logo.svg',
        primaryColor: '#000000',
        supportEmail: 'help@example.com',
        footerHtml: null,
      });
      await app.close();
    });

    it('clears a field by PATCHing an empty string (operator workflow: blank out the form)', async () => {
      // Per the route's GET contract (empty string → null), the
      // PATCH must persist the empty string as-is — the GET's
      // coercion to null is what hides it from the panel.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      await app.inject({
        method: 'PATCH',
        url: '/',
        headers: asUser(),
        payload: { logoUrl: 'https://cdn.example.com/logo.svg' },
      });
      const cleared = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: asUser(),
        payload: { logoUrl: '' },
      });
      expect(cleared.statusCode).toBe(200);
      const get = await app.inject({ method: 'GET', url: '/', headers: asUser() });
      expect(get.json()).toMatchObject({ logoUrl: null });
      await app.close();
    });

    it('accepts an empty body and returns { ok: true } without writing anything', async () => {
      // `req.body ?? {}` covers the case where the panel sends
      // a PATCH with no body. The for-loop sees no fields to
      // write, the cache is still invalidated, the response
      // is 200 ok.
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: asUser(),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      await app.close();
    });

    it('still 200s when the body parser hands the route an explicit `undefined` (req.body ?? {} fallback)', async () => {
      // Under fastify's default JSON parser, `req.body` is the
      // parsed object — never `undefined`. The `?? {}` is a
      // belt-and-braces guard for legacy parsers / future
      // content-type plugins that resolve to `undefined` on
      // empty input. We install a one-off parser that returns
      // `undefined` to exercise the fallback path. The route
      // must still 200 with `{ ok: true }` (the for-loop sees
      // no fields on an empty object).
      const app = await buildTestApp({ db: createFakeDb() });
      app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, _body, done) => done(null, undefined));
      await app.register(brandingRoutes);
      const res = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: { ...asUser(), 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      await app.close();
    });

    it('records actorUserId in the config center audit metadata for each written field', async () => {
      const app = await buildTestApp({ db: createFakeDb() });
      await app.register(brandingRoutes);
      const setSpy = vi.spyOn(app.kernel.configCenter, 'set');
      const res = await app.inject({
        method: 'PATCH',
        url: '/',
        headers: asUser({ id: 42 }),
        payload: { primaryColor: '#ff00ff' },
      });
      expect(res.statusCode).toBe(200);
      // Exactly one configCenter.set call (for primaryColor),
      // and the userId matches the authenticated operator.
      const setCall = setSpy.mock.calls.find(([k]) => k === 'branding:primaryColor');
      expect(setCall).toBeDefined();
      // The 3rd positional arg is the `set` options object;
      // the userId lives there.
      const opts = setCall?.[2] as { userId?: number; category?: string; pluginId?: string };
      expect(opts?.userId).toBe(42);
      expect(opts?.category).toBe('branding');
      expect(opts?.pluginId).toBe('g30-branding');
      setSpy.mockRestore();
      await app.close();
    });
  });
});

// Imported here (not at top of file) so the `vi.spyOn` reference
// is in scope where the test that needs it lives.
import { vi } from 'vitest';
