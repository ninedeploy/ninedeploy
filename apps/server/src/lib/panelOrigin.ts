import type { DB } from '@ninedeploy/db';
import { config } from '../config.js';
import { getAcmeEmail } from '../engine/proxy.js';
import { getSettingString } from './settings.js';

/**
 * Webhook URLs are pasted into GitHub/GitLab by the operator, so they must
 * point at the address the panel is actually reachable on. The
 * Settings→Security "panel domain" (or NINEDEPLOY_DOMAIN) is that runtime
 * truth; NINEDEPLOY_PUBLIC_URL defaults to http://localhost:3000 and would
 * otherwise leak a localhost URL into every copied hook. Scheme mirrors the
 * Traefik panel router: TLS only when an ACME email is configured.
 *
 * Moved out of `modules/hooks.ts` (0.13) unchanged, so the GitHub App routes
 * build their webhook and callback URLs from the same origin.
 */
export async function panelOrigin(db: DB): Promise<string> {
  let host = '';
  try {
    host = String((await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? '')
      .replace(/[^A-Za-z0-9.\-*]/g, '')
      .replace(/^\.+|\.+$/g, '');
  } catch {
    host = '';
  }
  if (!host || host === '*' || host.startsWith('.')) return config.publicUrl;
  const tls = await getAcmeEmail(db).catch(() => config.acmeEmail);
  return `${tls ? 'https' : 'http'}://${host}`;
}
