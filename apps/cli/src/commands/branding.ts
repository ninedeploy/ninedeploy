/**
 * `ninedeploy branding {get,set}` — Sprint 4, Gap G-30.
 *
 * Operator-side wrapper around the four branding fields the panel
 * can override: `logoUrl`, `primaryColor`, `supportEmail`,
 * `footerHtml`. The CLI is the canonical way to set them when
 * provisioning a fresh instance (the panel is the read path; the
 * CLI is the write path operators actually use at the terminal).
 */
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

export interface BrandingStatus {
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
  footerHtml: string | null;
}

export interface BrandingSetOptions {
  logoUrl?: string;
  primaryColor?: string;
  supportEmail?: string;
  footerHtml?: string;
}

// ── `ninedeploy branding get` ─────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function brandingGet(client: NineDeployClient): Promise<BrandingStatus> {
  return await client.branding.get();
}

export async function brandingGetAction(client: NineDeployClient): Promise<void> {
  header('Branding');
  let result: BrandingStatus;
  try {
    result = await brandingGet(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  info(`logoUrl:      ${result.logoUrl ?? '(default)'}`);
  info(`primaryColor: ${result.primaryColor ?? '(default)'}`);
  info(`supportEmail: ${result.supportEmail ?? '(default)'}`);
  info(`footerHtml:   ${result.footerHtml ? `${result.footerHtml.length} chars` : '(default)'}`);
}

// ── `ninedeploy branding set` ─────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function brandingSet(
  client: NineDeployClient,
  opts: BrandingSetOptions = {},
): Promise<{ ok: boolean }> {
  if (
    opts.logoUrl === undefined &&
    opts.primaryColor === undefined &&
    opts.supportEmail === undefined &&
    opts.footerHtml === undefined
  ) {
    throw new Error('At least one of --logo-url, --primary-color, --support-email, --footer-html is required');
  }
  return await client.branding.set(opts);
}

export async function brandingSetAction(
  client: NineDeployClient,
  opts: BrandingSetOptions = {},
): Promise<void> {
  header('Branding set');
  let result: Awaited<ReturnType<typeof brandingSet>>;
  try {
    result = await brandingSet(client, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  success(`Branding updated (${Object.keys(opts).filter((k) => opts[k as keyof BrandingSetOptions] !== undefined).join(', ')})`);
  void result;
}
