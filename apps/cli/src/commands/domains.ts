/**
 * `ninedeploy domains preset {list,apply}` — Sprint 2, Gap G-07, PR-D.
 *
 * The plugin (G-07 PR-C) reacts to the audit firehose so a `domain.add`
 * from the panel can create the matching DNS record on its own. This
 * CLI subcommand lets an operator do the same thing on demand without
 * having to round-trip through the panel's domain flow — useful when a
 * record is missing after a partial outage, or when an operator is
 * testing the DNS pipeline against a fresh hostname.
 *
 * Split:
 *   - `list` calls `GET /v1/domain-presets` and prints the registered
 *     `IDomainProvider` names so the operator can sanity-check the
 *     kernel boot before chasing a misconfiguration on the provider
 *     side.
 *   - `apply <hostname>` calls `POST /v1/domain-presets/apply`, which
 *     resolves the active provider from the existing
 *     `dns_records_provider` setting, calls `findZoneForHost` +
 *     `createRecord` on it, and emits a `domain.preset.manual` audit
 *     event so the panel's activity log mirrors what the audit-bus path
 *     produces. The `--content` flag lets the operator override the
 *     resolved record content (handy for CNAME setups or smoke tests).
 */
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

export interface DomainsPresetApplyOptions {
  /** Optional override for the record content (e.g. an explicit CNAME target). */
  content?: string;
}

// ── `ninedeploy domains preset list` ────────────────────────────────────────

/**
 * Pure entry point — same shape used by the CLI action and the unit
 * test. Returns the parsed provider list so the test can assert it
 * without depending on stdout framing.
 */
export async function domainsPresetList(
  client: NineDeployClient,
): Promise<{ providers: string[] }> {
  return await client.domainPresets.list();
}

export async function domainsPresetListAction(client: NineDeployClient): Promise<void> {
  header('Domain presets');
  let result: { providers: string[] };
  try {
    result = await domainsPresetList(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.providers.length === 0) {
    info('No IDomainProvider drivers are registered on this kernel.');
    info('Set dns_records_provider in Settings → DNS to enable one.');
    return;
  }
  for (const name of result.providers) {
    info(`• ${name}`);
  }
}

// ── `ninedeploy domains preset apply <hostname>` ────────────────────────────

/**
 * Pure entry point — same shape used by the CLI action and the unit
 * test. Returns the upstream response so the test can assert it
 * without depending on stdout framing.
 */
export async function domainsPresetApply(
  client: NineDeployClient,
  hostname: string,
  opts: DomainsPresetApplyOptions = {},
): Promise<{
  hostname: string;
  provider: string;
  zone: string;
  recordId: string;
  type: 'A' | 'CNAME';
  content: string;
}> {
  return await client.domainPresets.apply({ hostname, content: opts.content });
}

export async function domainsPresetApplyAction(
  client: NineDeployClient,
  hostname: string,
  opts: DomainsPresetApplyOptions = {},
): Promise<void> {
  header('Domain preset apply');

  if (!hostname) {
    error('Usage: ninedeploy domains preset apply <hostname> [--content <value>]');
    process.exitCode = 1;
    return;
  }

  let result: Awaited<ReturnType<typeof domainsPresetApply>>;
  try {
    result = await domainsPresetApply(client, hostname, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  success(`Applied ${result.type} record for ${result.hostname}`);
  info(`Provider: ${result.provider}`);
  info(`Zone:     ${result.zone}`);
  info(`Record:   ${result.recordId}`);
  info(`Content:  ${result.content}`);
}

// ── `ninedeploy domains preset add namecheap` ────────────────────────────

export interface DomainsPresetAddNamecheapOptions {
  /** Namecheap username (the account owner). */
  apiUser?: string;
  /** Namecheap API key (encrypted at rest by the server). */
  apiKey?: string;
  /** Whitelisted public IP of the server. */
  clientIp?: string;
}

/**
 * Pure entry point for the Namecheap credential upsert. The handler
 * shape mirrors the rest of the file (returns the upstream response,
 * the action layer frames stdout/exit-code).
 */
export async function domainsPresetAddNamecheap(
  client: NineDeployClient,
  opts: DomainsPresetAddNamecheapOptions,
): Promise<{ ok: boolean; apiUser: string }> {
  if (!opts.apiUser || !opts.apiKey || !opts.clientIp) {
    throw new Error('Missing required flags: --api-user, --api-key, --client-ip');
  }
  return await client.settings.namecheap.set({
    apiUser: opts.apiUser,
    apiKey: opts.apiKey,
    clientIp: opts.clientIp,
  });
}

export async function domainsPresetAddNamecheapAction(
  client: NineDeployClient,
  opts: DomainsPresetAddNamecheapOptions,
): Promise<void> {
  header('Domain preset add (Namecheap)');

  if (!opts.apiUser || !opts.apiKey || !opts.clientIp) {
    error('Usage: ninedeploy domains preset add namecheap --api-user <u> --api-key <k> --client-ip <ip>');
    error('The client IP must already be whitelisted on the Namecheap account panel.');
    process.exitCode = 1;
    return;
  }

  let result: Awaited<ReturnType<typeof domainsPresetAddNamecheap>>;
  try {
    result = await domainsPresetAddNamecheap(client, opts);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  success(`Saved Namecheap credentials for ${result.apiUser}`);
  info('Set dns_records_provider=namecheap in Settings → DNS to use them.');
}
