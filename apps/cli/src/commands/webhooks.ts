import type { NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, header, info, kv, spinner, success, table } from '../lib/format.js';

/** `ninedeploy webhooks list <serviceId>` */
export async function webhooksList(client: NineDeployClient, svcArg: string): Promise<void> {
  const serviceId = Number(svcArg);
  if (!serviceId) return error('Usage: ninedeploy webhooks list <serviceId>');
  header(`Webhooks for service #${serviceId}`);
  const rows = await spinner('Fetching', () => client.webhooks.list(serviceId));
  if (rows.length === 0) {
    info('No webhooks yet. Add one with `ninedeploy webhooks add`.');
    return;
  }
  table(
    rows.map((w) => ({
      id: w.id,
      branch: w.branch,
      source: w.sourceId ?? c.gray('—'),
      active: w.active ? c.green('✓') : c.red('✗'),
      url: w.url,
    })),
    ['id', 'branch', 'source', 'active', 'url'],
  );
}

/**
 * `ninedeploy webhooks add <serviceId> [branch]`
 *
 * Returns the secret ONCE so the operator can paste it into GitHub as the
 * webhook "Secret" value. The CLI never stores it; the panel only ever sees
 * the HMAC digest.
 */
export async function webhooksAdd(client: NineDeployClient, svcArg: string, branchArg?: string): Promise<void> {
  const serviceId = Number(svcArg);
  if (!serviceId) return error('Usage: ninedeploy webhooks add <serviceId> [branch]');
  const branch = branchArg ?? (await prompt('Branch to deploy on push', 'main'));
  if (!branch) return error('Branch is required');

  const watchPaths = (await prompt('Watch paths (newline/comma-separated globs; empty = all files)', '')) || undefined;

  const created = await spinner('Creating webhook', () =>
    client.webhooks.create(serviceId, { branch, watchPaths }),
  );
  success(`Webhook #${created.id} created for branch "${created.branch}"`);
  console.log();
  console.log(`  ${c.bold('URL')}`);
  console.log(`    ${c.cyan(created.url)}`);
  console.log();
  console.log(`  ${c.bold('Secret (shown once — paste into GitHub):')}`);
  console.log(`    ${c.green(created.secret)}`);
  console.log();
  console.log(`  ${c.gray('GitHub steps: Repo → Settings → Webhooks → Add')}`);
  console.log(`  ${c.gray('  • Payload URL  : the URL above')}`);
  console.log(`  ${c.gray('  • Content type : application/json')}`);
  console.log(`  ${c.gray('  • Secret       : the secret above')}`);
  console.log(`  ${c.gray('  • SSL          : enabled (the panel runs behind HTTPS via Traefik)')}`);
  console.log(`  ${c.gray('  • Events       : "Just the push event."')}`);
  console.log();
  info('Tip: set `NINEDEPLOY_PUBLIC_URL` on the server to a public HTTPS URL so the URL is reachable from GitHub.');
}

/** `ninedeploy webhooks remove <serviceId> <hookId>` */
export async function webhooksRemove(client: NineDeployClient, svcArg: string, hookArg: string): Promise<void> {
  const serviceId = Number(svcArg);
  const hookId = Number(hookArg);
  if (!serviceId || !hookId) return error('Usage: ninedeploy webhooks remove <serviceId> <hookId>');
  const confirm = await prompt(`Type "delete" to confirm removal of webhook #${hookId}`, '');
  if (confirm.trim() !== 'delete') {
    info('Aborted.');
    return;
  }
  await spinner('Removing webhook', () => client.webhooks.remove(serviceId, hookId));
  success(`Webhook #${hookId} removed.`);
}

/** `ninedeploy webhooks show <serviceId> <hookId>` */
export async function webhooksShow(client: NineDeployClient, svcArg: string, hookArg: string): Promise<void> {
  const serviceId = Number(svcArg);
  const hookId = Number(hookArg);
  if (!serviceId || !hookId) return error('Usage: ninedeploy webhooks show <serviceId> <hookId>');
  header(`Webhook #${hookId}`);
  const rows = await spinner('Fetching', () => client.webhooks.list(serviceId));
  const w = rows.find((x) => x.id === hookId);
  if (!w) return error(`Webhook #${hookId} not found on service #${serviceId}`);
  kv('ID', w.id);
  kv('Branch', w.branch);
  kv('Source', w.sourceId ?? c.gray('— (inherits service default)'));
  kv('Active', w.active ? c.green('yes') : c.red('no'));
  kv('Watch paths', w.watchPaths || c.gray('— (all files)'));
  kv('URL', w.url);
  kv('Created', w.createdAt);
}
