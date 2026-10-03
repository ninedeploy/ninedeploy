import { afterEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import { webhookMgmtRoutes } from '../src/modules/hooks.js';
import { asUser, buildTestApp, createFakeDb, svcRow, webhookRow } from './helpers.js';

/**
 * The auto-deploy card prints this URL verbatim for pasting into GitHub/GitLab.
 * It must point at the panel's real origin (Settings→Security panel domain or
 * NINEDEPLOY_DOMAIN) instead of the NINEDEPLOY_PUBLIC_URL default of
 * http://localhost:3000 — the regression that made every hook look local.
 */

const svc = svcRow({ id: 1 });
const hookRow = () => webhookRow({ id: 5, serviceId: 1, secretEncrypted: encrypt('s') });

async function listWebhookUrls(settingsSequence: Array<Record<string, unknown> | undefined>) {
  let call = 0;
  const db = createFakeDb({
    findFirst: {
      services: svc,
      // panelOrigin reads panel_domain first, then acme_email (for the scheme).
      settings: () => settingsSequence[call++],
    },
    findMany: { webhooks: [hookRow()] },
  });
  const app = await buildTestApp({ db });
  await app.register(webhookMgmtRoutes, { prefix: '/services' });
  const res = await app.inject({
    method: 'GET',
    url: '/services/1/webhooks',
    headers: asUser({ id: 1, isOperator: true }),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as Array<{ url: string }>).map((w) => w.url);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('auto-deploy webhook URL origin', () => {
  it('falls back to NINEDEPLOY_PUBLIC_URL when no panel domain is set', async () => {
    vi.stubEnv('NINEDEPLOY_DOMAIN', '');
    const urls = await listWebhookUrls([undefined, undefined]);
    expect(urls).toEqual(['http://localhost:3000/v1/hooks/5']);
  });

  it('uses https://<panel domain> when the domain and ACME email are configured', async () => {
    vi.stubEnv('NINEDEPLOY_DOMAIN', '');
    const urls = await listWebhookUrls([
      { key: 'panel_domain', value: 'panel.example.com' },
      { key: 'acme_email', value: 'ops@example.com' },
    ]);
    expect(urls).toEqual(['https://panel.example.com/v1/hooks/5']);
  });

  it('stays on http when no ACME email is configured yet', async () => {
    vi.stubEnv('NINEDEPLOY_DOMAIN', '');
    const urls = await listWebhookUrls([
      { key: 'panel_domain', value: 'panel.example.com' },
      { key: 'acme_email', value: '' }, // cleared in Settings → getAcmeEmail falls back to env → null
    ]);
    expect(urls).toEqual(['http://panel.example.com/v1/hooks/5']);
  });

  it('honours NINEDEPLOY_DOMAIN without a stored panel domain', async () => {
    vi.stubEnv('NINEDEPLOY_DOMAIN', 'panel.env.example.com');
    // Read order: panel_domain (missing here), then acme_email.
    const urls = await listWebhookUrls([undefined, { key: 'acme_email', value: 'ops@example.com' }]);
    expect(urls).toEqual(['https://panel.env.example.com/v1/hooks/5']);
  });

  it('rejects garbage values that sanitize to nothing', async () => {
    vi.stubEnv('NINEDEPLOY_DOMAIN', '');
    const urls = await listWebhookUrls([
      { key: 'panel_domain', value: '.!! $$ .' },
      { key: 'acme_email', value: 'ops@example.com' },
    ]);
    expect(urls).toEqual(['http://localhost:3000/v1/hooks/5']);
  });
});
