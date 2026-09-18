import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * r222 guard: `audit()` is the fan-out point — it writes the audit log AND
 * feeds notifications, the live activity feed and the plugin event bus. A
 * mutation route that skips it is invisible to all of them (env CRUD, alert
 * rules, notification channels, webhook secrets, system import/export and
 * more were). Every POST/PUT/PATCH/DELETE route in src/modules must reach
 * audit() — directly or through a helper named below — or be listed here
 * with the reason it is not a state change worth a trail.
 */
const EXEMPT: Record<string, string> = {
  'auth.ts POST /passkey/register/options': 'issues a WebAuthn challenge; the verify step is audited',
  'auth.ts POST /passkey/login/options': 'issues a WebAuthn challenge',
  'auth.ts POST /refresh': 'token rotation of an existing session',
  'auth.ts POST /logout': 'ends the caller\u2019s own session',
  'auth.ts POST /oidc/:slug/callback': 'SSO sign-in (session issuance), not a config change',
  'sso.ts POST /:name/saml-callback': 'SSO sign-in (session issuance), not a config change',
  'backupDestinations.ts POST /:id/test': 'connectivity probe, no state change',
  'settings.ts POST /vault/test': 'connectivity probe, no state change',
  'settings.ts POST /dns-records/test': 'connectivity probe, no state change',
  'notifications.ts POST /channels/:id/test': 'sends a test message, no state change',
  'buildCache.ts POST /store': 'agent-side cache upload, not a user action',
  'emailTemplates.ts POST /:wid/email-templates/preview': 'renders a preview, no state change',
  'services.ts POST /compose/preview': 'analyses YAML, no state change',
  'hooks.ts POST /:id': 'inbound git webhook; the deploy it queues is audited by the pipeline',
  'insights.ts POST /': 'repository analysis, no state change',
  'insights.ts POST /:id/insights/refresh': 're-runs repository analysis, no state change',
  'logSearch.ts POST /search': 'read (POST only for the body)',
  'metricHistory.ts POST /flush': 'flushes in-memory samples to storage',
  'templates.ts POST /:id/prepare': 'shared `queue` handler, audited as template.deploy',
  'templates.ts POST /:id/deploy': 'shared `queue` handler, audited as template.deploy',
};

const HELPERS = /\baudit\(|\bdeactivateUser\(|\bregisterAccount\(|\bcreateFirstAdmin\(/;
const ROUTE = /\b(?:app|scope|api|r|instance|protectedScope|admin)\.(post|put|patch|delete)\b(?:<[\s\S]*?>)?\(\s*'([^']*)'/g;

describe('audit coverage (r222)', () => {
  it('every mutation route in src/modules reaches audit() or is exempt with a reason', () => {
    const dir = new URL('../src/modules/', import.meta.url);
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()) {
      const src = readFileSync(new URL(file, dir), 'utf8');
      const hits = [...src.matchAll(ROUTE)];
      hits.forEach((m, i) => {
        const key = `${file} ${m[1]!.toUpperCase()} ${m[2]}`;
        seen.add(key);
        const body = src.slice(m.index, i + 1 < hits.length ? hits[i + 1]!.index : src.length);
        if (!HELPERS.test(body) && !EXEMPT[key]) missing.push(key);
      });
    }
    expect(missing).toEqual([]);
    // Keep the exemption list honest: a stale entry would hide a new route.
    expect(Object.keys(EXEMPT).filter((k) => !seen.has(k))).toEqual([]);
  });
});
