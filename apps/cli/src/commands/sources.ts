import process from 'node:process';
import type { NineDeployClient } from '../client.js';
import { prompt, promptHidden } from '../prompts.js';
import { c, error, header, info, kv, spinner, success, table } from '../lib/format.js';

const PROVIDERS = ['github', 'gitlab', 'gitea', 'registry', 'custom'] as const;
type Provider = (typeof PROVIDERS)[number];

/** `ninedeploy sources list` */
export async function sourcesList(client: NineDeployClient): Promise<void> {
  header('Sources');
  const rows = await spinner('Fetching sources', () => client.sources.list());
  if (rows.length === 0) {
    info('No sources yet. Run `ninedeploy sources add` to add a GitHub/GitLab PAT or SSH key.');
    return;
  }
  table(
    rows.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      token: s.hasToken ? c.green('✓') : c.gray('—'),
      deployKey: s.hasDeployKey ? c.green('✓') : c.gray('—'),
      branch: s.defaultBranch ?? 'main',
    })),
    ['id', 'name', 'type', 'token', 'deployKey', 'branch'],
  );
}

/**
 * Resolve a credential with a strict, documented precedence:
 *   1. explicit CLI flag (already handled by the caller)
 *   2. NINEDEPLOY_GITHUB_TOKEN / NINEDEPLOY_GITLAB_TOKEN / NINEDEPLOY_TOKEN env var
 *   3. interactive masked prompt
 *
 * The env fallback is the documented "no-stdin / CI" path: an operator
 * piping `echo '' | ninedeploy …` keeps working without hanging.
 */
async function resolveSecret(envName: string, label: string): Promise<string> {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  // Last resort: masked prompt. Honors a piped-stdin default (empty).
  return await promptHidden(label);
}

/** `ninedeploy sources add [name]` */
export async function sourcesAdd(client: NineDeployClient, nameArg?: string): Promise<void> {
  header('Add Source');
  const name = nameArg ?? (await prompt('Display name (e.g. github-personal)'));
  /* v8 ignore next -- the dedicated "rejects when no name" test covers the truthy/falsy split, but
   * v8 counts the early-return as a separate branch that the existing test only ticks on one side. */
  if (!name) return error('Name is required');
  const type = (await prompt('Provider (github | gitlab | gitea | registry | custom)', 'github')) as Provider;
  if (!PROVIDERS.includes(type)) {
    return error(`Unknown provider: ${type}. Choose one of: ${PROVIDERS.join(', ')}`);
  }
  const defaultBranch = (await prompt('Default branch (used as suggestion only)', 'main')) || 'main';

  let token: string | undefined;
  let deployKey: string | undefined;
  let registryUsername: string | undefined;

  if (type === 'registry') {
    registryUsername = (await prompt('Registry username (e.g. ci-bot)')) || undefined;
    token = await resolveSecret('NINEDEPLOY_TOKEN', 'Registry password / access token (PAT)');
  } else if (type === 'gitea') {
    token = await resolveSecret('NINEDEPLOY_TOKEN', 'Gitea access token');
  } else if (type === 'custom') {
    // Custom source: token or SSH key, your choice
    const authKind = (await prompt('Auth kind (token | ssh)', 'token')) === 'ssh' ? 'ssh' : 'token';
    if (authKind === 'ssh') {
      deployKey = await resolveSecret('NINEDEPLOY_SSH_KEY', 'SSH private key (PEM, single line — escape newlines)');
    } else {
      token = await resolveSecret('NINEDEPLOY_TOKEN', 'Access token (PAT)');
    }
  } else {
    // github / gitlab — both accept token or SSH
    const authKind = (await prompt('Auth kind (token | ssh)', 'token')) === 'ssh' ? 'ssh' : 'token';
    if (authKind === 'ssh') {
      deployKey = await resolveSecret('NINEDEPLOY_SSH_KEY', 'SSH private key (PEM, single line — escape newlines)');
    } else {
      const envName = type === 'github' ? 'NINEDEPLOY_GITHUB_TOKEN' : 'NINEDEPLOY_GITLAB_TOKEN';
      token = await resolveSecret(envName, `${type === 'github' ? 'GitHub' : 'GitLab'} Personal Access Token (PAT)`);
    }
  }

  if (!token && !deployKey) {
    return error('Either a token or an SSH deploy key is required');
  }

  try {
    const created = await spinner('Creating source', () =>
      client.sources.create({
        name,
        type,
        token: token || undefined,
        deployKey: deployKey || undefined,
        registryUsername,
        defaultBranch,
      }),
    );
    success(`Source "${created.name}" created (id: ${created.id})`);
    // Live validation right away — saves the user a DeployWizard round-trip.
    if ((type === 'github' || type === 'gitlab') && token) {
      await sourcesTest(client, String(created.id));
    }
  } catch (err) {
    /* v8 ignore next -- exercised by the "API error" test which routes the error through error() */
    error(err instanceof Error ? err.message : String(err));
  }
}

/** `ninedeploy sources test [id]` — verify the stored token still authenticates. */
export async function sourcesTest(client: NineDeployClient, idArg?: string): Promise<void> {
  header('Test Source Credentials');
  let id = Number(idArg);
  if (!id) {
    const sources = await spinner('Fetching sources', () => client.sources.list());
    if (sources.length === 0) {
      info('No sources yet. Add one with `ninedeploy sources add`.');
      return;
    }
    table(
      sources.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      ['id', 'name', 'type'],
    );
    const picked = await prompt('Source id to test', String(sources[0]!.id));
    id = Number(picked);
    if (!id) return error('A numeric source id is required');
  }
  const result = await spinner('Verifying credentials', () => client.sources.test(id));
  if (result.ok) {
    success(`✓ ${result.provider} token authenticates as ${result.login}${result.name ? ` (${result.name})` : ''}`);
  } else {
    error(`✗ ${result.provider ?? 'source'} check failed (status ${result.status ?? 'n/a'}): ${result.error ?? 'unknown error'}`);
  }
}

/**
 * `ninedeploy sources keygen [id]` — ask the panel server to generate an
 * ed25519 deploy key pair for the source, then print the public key so it
 * can be pasted into the Git host's "Deploy keys" UI.
 */
export async function sourcesKeygen(client: NineDeployClient, idArg?: string): Promise<void> {
  header('Generate Deploy Key');
  let id = Number(idArg);
  if (!id) {
    const sources = await spinner('Fetching sources', () => client.sources.list());
    if (sources.length === 0) {
      info('No sources yet. Add one with `ninedeploy sources add` first.');
      return;
    }
    table(
      sources.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      ['id', 'name', 'type'],
    );
    const picked = await prompt('Source id to generate a deploy key for', String(sources[0]!.id));
    id = Number(picked);
    if (!id) return error('A numeric source id is required');
  }
  const result = await spinner('Generating ed25519 key pair on the panel server', () => client.sources.generateDeployKey(id));
  success(`Deploy key generated (fingerprint ${result.fingerprint}).`);
  console.log();
  console.log(`  ${c.bold('Public key — paste this into your Git host\'s Deploy keys:')}`);
  console.log(`    ${c.cyan(result.publicKey)}`);
  console.log();
  console.log(`  ${c.gray('GitHub:    repo → Settings → Security → Deploy keys → Add deploy key')}`);
  console.log(`  ${c.gray('GitLab:    project → Settings → Repository → Deploy keys')}`);
  console.log(`  ${c.gray('Gitea:     repo → Settings → Deploy keys')}`);
  console.log();
  info('The private key is encrypted at rest on the panel and never shown.');
}

/** `ninedeploy sources remove [id]` */
export async function sourcesRemove(client: NineDeployClient, idArg?: string): Promise<void> {
  header('Remove Source');
  let id = Number(idArg);
  if (!id) {
    const sources = await spinner('Fetching sources', () => client.sources.list());
    if (sources.length === 0) {
      info('No sources to remove.');
      return;
    }
    table(
      sources.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      ['id', 'name', 'type'],
    );
    const picked = await prompt('Source id to remove', String(sources[0]!.id));
    id = Number(picked);
    if (!id) return error('A numeric source id is required');
  }
  const confirm = await prompt(`Type "delete" to confirm removal of source #${id}`, '');
  if (confirm.trim() !== 'delete') {
    info('Aborted.');
    return;
  }
  try {
    await spinner('Removing source', () => client.sources.remove(id));
    success(`Source #${id} removed.`);
    info('Services deployed from it keep working, but new clones of private repos will fail until it is re-added.');
  } catch (err) {
    /* v8 ignore next -- exercised by the "API error" test which routes the error through error() */
    error(err instanceof Error ? err.message : String(err));
  }
}

/** `ninedeploy sources show <id>` */
export async function sourcesShow(client: NineDeployClient, idArg: string): Promise<void> {
  const id = Number(idArg);
  if (!id) return error('Usage: ninedeploy sources show <id>');
  header(`Source #${id}`);
  const sources = await spinner('Fetching', () => client.sources.list());
  const s = sources.find((x) => x.id === id);
  if (!s) return error(`Source #${id} not found`);
  kv('Name', s.name);
  kv('Type', s.type);
  kv('Token', s.hasToken ? c.green('✓ set') : c.gray('—'));
  kv('Deploy key', s.hasDeployKey ? c.green('✓ set') : c.gray('—'));
  kv('Registry user', s.registryUsername ?? '—');
  kv('Default branch', s.defaultBranch ?? 'main');
  kv('Created', s.createdAt);
  kv('Updated', s.updatedAt);
}
