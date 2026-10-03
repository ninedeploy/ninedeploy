/**
 * `ninedeploy databases pgbouncer <dbId> <action>` — G-32
 * PgBouncer sidecar. Only the `postgres` engine is
 * supported; the server returns 422 for any other engine.
 *
 * Actions:
 *   - enable  : start a co-located pgbouncer container and
 *               stamp the row.
 *   - disable : stop + remove the sidecar, clear the row.
 *   - status  : print the current sidecar state and the
 *               pooled connection string.
 */
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, spinner, success } from '../lib/format.js';

const num = (v: string, usage: string): number => {
  const n = Number(v);
  if (Number.isNaN(n)) {
    error(usage);
    throw new Error(usage);
  }
  return n;
};

export async function databasePgbouncer(
  client: NineDeployClient,
  dbIdStr: string,
  action: string,
  opts: { port?: number } = {},
): Promise<void> {
  const dbId = num(dbIdStr, 'Usage: ninedeploy databases pgbouncer <dbId> <enable|disable|status>');
  const normalized = action.toLowerCase();
  if (!['enable', 'disable', 'status'].includes(normalized)) {
    error('Action must be one of: enable, disable, status');
    process.exitCode = 1;
    return;
  }
  if (normalized === 'enable') {
    const res = await spinner('Starting PgBouncer sidecar', () =>
      client.databases.enablePgbouncer(dbId, opts.port ? { port: opts.port } : {}),
    );
    success(`PgBouncer sidecar started on port ${res.port}.`);
    info(`Connection URL: ${res.pooledConnectionString ?? '(pending)'}`);
    return;
  }
  if (normalized === 'disable') {
    const res = await spinner('Stopping PgBouncer sidecar', () => client.databases.disablePgbouncer(dbId));
    success('PgBouncer sidecar stopped.');
    if (res.enabled) info(`Sidecar still reporting enabled: ${res.containerName ?? '(unknown)'}`);
    return;
  }
  // status
  const res = await spinner('Reading sidecar status', () => client.databases.pgbouncerStatus(dbId));
  header('PgBouncer sidecar');
  info(`Enabled:     ${res.enabled ? 'yes' : 'no'}`);
  info(`Container:   ${res.containerName ?? c.dim('(none)')}`);
  info(`Port:        ${res.port}`);
  info(`Running:     ${res.running ? 'yes' : c.yellow('no — enabled but container is down')}`);
  if (res.poolMode) info(`Pool mode:   ${res.poolMode}`);
  if (res.pooledConnectionString) {
    console.log();
    info(`Pooled URL (use this for new attachments):`);
    console.log(`  ${c.cyan(res.pooledConnectionString)}`);
  }
}
