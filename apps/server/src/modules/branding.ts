import type { FastifyPluginAsync } from 'fastify';

/**
 * Branding HTTP surface — Sprint 4, Gap G-30.
 *
 * Single endpoint, mounted under `/v1/branding` and protected by the
 * standard `app.authenticate` hook:
 *
 *   - `GET /` returns the four branding fields an operator can
 *     override: `logoUrl`, `primaryColor`, `supportEmail`,
 *     `footerHtml`. The values are read from the `branding.*`
 *     config-center namespace; an absent value falls back to the
 *     hard-coded defaults baked into the panel.
 *
 *   - `PATCH /` writes one or more of the four fields. The handler
 *     performs a single config-center write per field so a panel
 *     audit log records each change with the operator as
 *     `actorUserId`.
 *
 * The values are cached in process for 60 s so a panel that
 * refreshes the branding tab does not hammer SQLite. The cache is
 * invalidated on every successful PATCH.
 */
const NS = 'branding';
const CACHE_TTL_MS = 60_000;

interface BrandingStatus {
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  footerHtml: string | null;
}

const DEFAULTS: BrandingStatus = {
  logoUrl: null,
  primaryColor: null,
  supportEmail: null,
  footerHtml: null,
};

interface CacheEntry {
  value: BrandingStatus;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

function invalidate(): void {
  cache = null;
}

export const brandingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get('/', async () => {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return cache.value;
    }
    const [logoUrl, primaryColor, supportEmail, footerHtml] = await Promise.all([
      app.kernel.configCenter.get<string | null>(`${NS}:logoUrl`, null),
      app.kernel.configCenter.get<string | null>(`${NS}:primaryColor`, null),
      app.kernel.configCenter.get<string | null>(`${NS}:supportEmail`, null),
      app.kernel.configCenter.get<string | null>(`${NS}:footerHtml`, null),
    ]);
    const value: BrandingStatus = {
      logoUrl: typeof logoUrl === 'string' && logoUrl.length > 0 ? logoUrl : null,
      primaryColor: typeof primaryColor === 'string' && primaryColor.length > 0 ? primaryColor : null,
      supportEmail: typeof supportEmail === 'string' && supportEmail.length > 0 ? supportEmail : null,
      footerHtml: typeof footerHtml === 'string' && footerHtml.length > 0 ? footerHtml : null,
    };
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  });

  // Instance-wide branding rewrites what EVERY tenant's panel looks like
  // (footer HTML is rendered content) — a write on the instance, not on a
  // workspace, so it sits behind the operator flag like the rest of the
  // instance-wide configuration surface.
  app.patch<{ Body: Partial<BrandingStatus> }>('/', { preHandler: app.requireOperator }, async (req) => {
    const body = req.body ?? {};
    const userId = req.user?.id;
    const fields: Array<keyof BrandingStatus> = ['logoUrl', 'primaryColor', 'supportEmail', 'footerHtml'];
    for (const f of fields) {
      if (body[f] !== undefined) {
        await app.kernel.configCenter.set(`${NS}:${f}`, body[f], {
          isSecret: false,
          category: NS,
          pluginId: 'g30-branding',
          userId,
          description: `Branding override: ${f}`,
        });
      }
    }
    invalidate();
    return { ok: true };
  });
};

/** Test helper — exported so the test can clear the in-process cache. */
export function _resetBrandingCacheForTests(): void {
  invalidate();
}
void DEFAULTS;
