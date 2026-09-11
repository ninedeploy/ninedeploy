import { NineDeployError } from '@ninedeploy/sdk';
import { getClient } from '../client.js';
import { prompt } from '../prompts.js';

/**
 * Normalise a typed scope answer. Accepts the legacy
 * `read | write | operator` shorthand AND the fine-grained
 * `nd://scope/(read|write|admin)/<resource>` form
 * introduced in G-08. Anything unrecognised is dropped
 * rather than silently widening the token. An empty
 * result means "no scopes given": callers omit the field
 * and the server applies its read-only default (the
 * server refuses an explicit `[]`, which would be stored
 * as a legacy unrestricted token).
 */
export function parseScopes(answer: string): string[] {
  const legacy = new Set(['read', 'write', 'operator']);
  const resourceScope = /^nd:\/\/scope\/(read|write|admin)\/[a-z][a-z0-9_]{0,63}$/;
  return answer
    .split(',')
    .map((s) => s.trim())
    .filter((s) => legacy.has(s) || resourceScope.test(s));
}

/** `ninedeploy token create` — mint an API token (shown once). */
export async function tokenCreateAction(): Promise<void> {
  const name = (await prompt('Token name', 'ci')) || 'ci';
  // read = safe methods only · write = mutate as a non-operator ·
  // operator = no extra restriction. Blank = read-only (server default).
  const scopes = parseScopes(await prompt('Scopes (read,write,operator — blank = read)', 'write'));
  try {
    const created = await getClient().auth.tokens.create(scopes.length ? { name, scopes } : { name });
    console.log(`✓ Token "${created.name}" created (id: ${created.id}).`);
    console.log(`  Scopes: ${created.scopes.length ? created.scopes.join(', ') : 'unrestricted (legacy)'}`);
    console.log('  This token is shown ONCE — store it securely:');
    console.log(`  ${created.token}`);
    console.log('  Use it as: Authorization: Bearer <token>');
  } catch (err) {
    console.error(
      '✗ Could not create token:',
      err instanceof NineDeployError ? err.message : err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  }
}

/** `ninedeploy token list` — list API tokens (without secrets). */
export async function tokenListAction(): Promise<void> {
  const tokens = await getClient().auth.tokens.list();
  if (tokens.length === 0) {
    console.log('No API tokens.');
    return;
  }
  console.table(
    tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes.length ? t.scopes.join(',') : 'unrestricted',
      lastUsed: t.lastUsedAt ?? 'never',
      expires: t.expiresAt ?? 'never',
      created: t.createdAt,
    })),
  );
}
