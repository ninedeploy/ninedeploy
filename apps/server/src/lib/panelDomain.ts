import type { DB } from '@ninedeploy/db';
import { getSettingString } from './settings.js';

/**
 * The panel's own hostname as configured: the value under Settings →
 * Security first, then `NINEDEPLOY_DOMAIN` (install.sh --domain). Null when
 * none is set. The value is as written; the proxy keeps only what a hostname
 * may hold. The proxy, the domain checks and `panelOrigin` each read the two
 * sources the same way; this is for callers that only need to know whether a
 * domain exists.
 */
export async function configuredPanelDomain(db: DB): Promise<string | null> {
  let value: string | null;
  try {
    value = (await getSettingString(db, 'panel_domain', null)) ?? process.env['NINEDEPLOY_DOMAIN'] ?? null;
  } catch {
    value = process.env['NINEDEPLOY_DOMAIN'] ?? null;
  }
  const text = String(value ?? '').trim();
  return text ? text : null;
}
