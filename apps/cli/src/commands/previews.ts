import type { NineDeployClient } from '../client.js';
import { c, error, header, info, kv, spinner, success } from '../lib/format.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * PR preview settings of a git-backed service:
 *
 *   ninedeploy previews show <service> [--json]
 *   ninedeploy previews database-copies <service> <on|off>   (0.16.12)
 *   ninedeploy previews forks <service> <on|off>             (0.16.14)
 *
 * `<service>` is an id, a slug or a name. With database copies on, each PR
 * preview gets its own copy of the attached PostgreSQL and Redis-family
 * databases, made from the latest backup, and the copies are removed with the
 * preview. MySQL, MariaDB and MongoDB are not copied yet. With forks on, a
 * fork's pull request gets a preview too; each of its deploys waits for an
 * admin's approval, and it is cloned without the service's Git credential.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

const onOffText = (v: boolean | undefined): string => (v ? 'on' : 'off');

/** `on` / `off` (also true/false, yes/no); null after printing the usage error. */
export function parseOnOff(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === 'no') return false;
  error(`The setting must be on or off (got "${plain(raw ?? '')}")`);
  return null;
}

const COPY_SCOPE =
  'Each PR preview gets a copy of the attached PostgreSQL and Redis-family databases, made from the latest backup; the copies are removed with the preview. MySQL, MariaDB and MongoDB are not copied yet.';

/** `ninedeploy previews show <service> [--json]` */
export async function previewsShow(client: NineDeployClient, ref: string, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const svc = opts.json ? await client.services.get(id) : await spinner('Loading the service', () => client.services.get(id));
    const settings = {
      previewDeploymentsEnabled: svc.previewDeploymentsEnabled ?? false,
      previewAutoDestroyOnClose: svc.previewAutoDestroyOnClose ?? true,
      previewDatabaseCopy: svc.previewDatabaseCopy ?? false,
      previewForks: svc.previewForks ?? false,
      previewDomainPattern: svc.previewDomainPattern ?? null,
      previewMaxActive: svc.previewMaxActive ?? null,
    };
    if (opts.json) {
      console.log(JSON.stringify(settings, null, 2));
      return;
    }
    header(`PR previews: ${plain(svc.name)}`);
    if (svc.isEphemeralPreview) {
      info(`This is the preview of PR #${svc.prNumber ?? '?'}; its settings come from the parent service.`);
      if (svc.previewFromFork) info('The PR comes from a fork: each deploy waits for approval (ninedeploy approvals).');
      console.log();
      return;
    }
    kv('Previews', settings.previewDeploymentsEnabled ? c.green('on') : c.gray('off'));
    kv('Auto-destroy on close', onOffText(settings.previewAutoDestroyOnClose));
    kv('Database copies', onOffText(settings.previewDatabaseCopy));
    kv('Forks', settings.previewForks ? `${c.yellow('on')} ${c.gray('(each deploy waits for approval)')}` : onOffText(false));
    kv('Domain pattern', settings.previewDomainPattern ? plain(settings.previewDomainPattern) : c.gray('default'));
    kv('Max active', settings.previewMaxActive ?? c.gray('default'));
    console.log();
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy previews database-copies <service> <on|off>` */
export async function previewsDatabaseCopies(client: NineDeployClient, ref: string, value: string): Promise<void> {
  const on = parseOnOff(value);
  if (on === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const updated = await spinner('Saving', () => client.services.update(id, { previewDatabaseCopy: on }));
    success(`${plain(updated.name)}: database copies per preview ${onOffText(updated.previewDatabaseCopy ?? on)}.`);
    if (on) {
      info(COPY_SCOPE);
      if (!updated.previewDeploymentsEnabled) info('PR previews are off for this service; turn them on under Service → Settings → Previews.');
    }
  } catch (err) {
    error(message(err));
  }
}

const FORK_SCOPE =
  "A fork's pull request now gets a preview; each of its deploys waits for an admin's approval (ninedeploy approvals). It is cloned without this service's Git credential, so only a public fork builds, and it gets no database copies and no secret preview-only values.";

/** `ninedeploy previews forks <service> <on|off>` */
export async function previewsForks(client: NineDeployClient, ref: string, value: string): Promise<void> {
  const on = parseOnOff(value);
  if (on === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const updated = await spinner('Saving', () => client.services.update(id, { previewForks: on }));
    if (updated.previewForks === undefined) {
      error('This panel predates fork previews (0.16.14); nothing was changed.');
      return;
    }
    success(`${plain(updated.name)}: previews of pull requests from forks ${onOffText(updated.previewForks)}.`);
    if (on) {
      info(FORK_SCOPE);
      if (!updated.previewDeploymentsEnabled) info('PR previews are off for this service; turn them on under Service → Settings → Previews.');
    }
  } catch (err) {
    error(message(err));
  }
}
