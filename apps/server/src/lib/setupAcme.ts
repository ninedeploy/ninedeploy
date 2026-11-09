import type { DB } from '@ninedeploy/db';
import { config } from '../config.js';
import { audit } from './audit.js';
import { getSettingString, setSettingString } from './settings.js';

/**
 * A2 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): the first-run form can hand
 * the new operator's email to Let's Encrypt, so automatic HTTPS works without
 * a separate Settings → Security step.
 *
 * Whether ACME is already configured (a saved email, or NINEDEPLOY_ACME_EMAIL
 * from the installer). The public status route reports it only before setup.
 */
export async function acmeConfigured(db: DB): Promise<boolean> {
  return Boolean((await getSettingString(db, 'acme_email', null)) || config.acmeEmail);
}

/**
 * Store the setup form's ACME email, unless one is already configured (an
 * explicit choice is never overwritten), then apply it to Traefik a moment
 * later, the same way PUT /v1/settings/acme-email does. Never throws: the
 * account exists already, and a failed proxy apply is retried by the watchdog.
 */
export async function adoptSetupAcmeEmail(
  db: DB,
  userId: number,
  email: string,
  log: { error: (obj: object, msg: string) => void },
): Promise<boolean> {
  try {
    if (await acmeConfigured(db)) return false;
    await setSettingString(db, 'acme_email', email);
    void audit(db, userId, 'settings.acme', email, { source: 'setup' });
    const timer = setTimeout(() => {
      void (async () => {
        // Loaded lazily: the public status route imports this module, and the
        // proxy engine is not needed until an email is actually adopted.
        const { ensureNetwork, ensureTraefik, traefikInputs, writeDynamicConfig } = await import('../engine/proxy.js');
        const line = () => undefined;
        await ensureNetwork(line);
        const t = await traefikInputs(db);
        await ensureTraefik(line, t.acmeEmail, t.dns, t);
        await writeDynamicConfig(db);
      })().catch((err: unknown) => log.error({ err, component: 'setup' }, 'failed to apply the setup ACME email to Traefik'));
    }, 1000);
    timer.unref();
    return true;
  } catch (err) {
    log.error({ err, component: 'setup' }, 'failed to store the setup ACME email');
    return false;
  }
}
