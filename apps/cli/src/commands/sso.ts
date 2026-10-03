/**
 * `ninedeploy sso {list,add,remove}` — Sprint 5, Gap G-22.
 *
 * Operator-side wrapper for the SSO provider list. The CLI is the
 * canonical write path; the panel is the read + login surface.
 */
import type { NineDeployClient } from '../client.js';
import { error, header, info, success } from '../lib/format.js';

export interface SsoProviderListItem {
  id: number;
  type: 'oidc' | 'saml';
  name: string;
  createdAt: string;
}

// ── `ninedeploy sso list` ─────────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function ssoList(client: NineDeployClient): Promise<{ providers: SsoProviderListItem[] }> {
  return await client.sso.listProviders();
}

export async function ssoListAction(client: NineDeployClient): Promise<void> {
  header('SSO providers');
  let result: { providers: SsoProviderListItem[] };
  try {
    result = await ssoList(client);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (result.providers.length === 0) {
    info('No SSO providers configured. Run `ninedeploy sso add oidc --name <id> --issuer <url> --client-id <id> --client-secret <secret>`.');
    return;
  }
  for (const p of result.providers) {
    info(`#${p.id}  ${p.name}  (${p.type})`);
  }
}

// ── `ninedeploy sso add` ──────────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function ssoAdd(
  client: NineDeployClient,
  type: 'oidc' | 'saml',
  name: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; id?: number; error?: string }> {
  return await client.sso.addProvider({ type, name, config });
}

export async function ssoAddAction(
  client: NineDeployClient,
  type: string,
  name: string,
  config: Record<string, unknown>,
): Promise<void> {
  if (type !== 'oidc' && type !== 'saml') {
    error('Usage: ninedeploy sso add <oidc|saml> <name> --config-key value --config-key value ...');
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof ssoAdd>>;
  try {
    result = await ssoAdd(client, type, name, config);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    error(result.error ?? 'unknown error');
    process.exitCode = 1;
    return;
  }
  success(`Added SSO provider "${name}" (id=${result.id})`);
}

// ── `ninedeploy sso remove` ───────────────────────────────────────────────

/** Pure entry point — same shape used by the CLI action and the unit test. */
export async function ssoRemove(client: NineDeployClient, id: number): Promise<{ ok: boolean }> {
  return await client.sso.removeProvider(id);
}

export async function ssoRemoveAction(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!Number.isFinite(id)) {
    error('Usage: ninedeploy sso remove <id>');
    process.exitCode = 1;
    return;
  }
  let result: Awaited<ReturnType<typeof ssoRemove>>;
  try {
    result = await ssoRemove(client, id);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  success(`Removed SSO provider #${id}`);
  void result;
}
