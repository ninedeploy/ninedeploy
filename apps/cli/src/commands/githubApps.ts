import { readFileSync } from 'node:fs';
import process from 'node:process';
import type { GithubApp, GithubAppInstallation, ServiceGithubLink } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { loadConfig } from '../config.js';
import { prompt } from '../prompts.js';
import { c, error, header, info, kv, spinner, success, table } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * 0.13: GitHub App registration (`ninedeploy github-app …`) and a service's
 * App link (`ninedeploy services github <id>`). App names, slugs, owners,
 * account logins and repository names come from GitHub, so every one of them
 * goes through the F1011 terminal sanitiser before it is printed.
 *
 * Secrets never travel on argv: the private key is read from a file
 * (`--key-file`) or `NINEDEPLOY_GITHUB_APP_KEY`, and a webhook secret only
 * from `NINEDEPLOY_GITHUB_APP_WEBHOOK_SECRET`.
 */

const KEY_ENV = 'NINEDEPLOY_GITHUB_APP_KEY';
const WEBHOOK_SECRET_ENV = 'NINEDEPLOY_GITHUB_APP_WEBHOOK_SECRET';

/** Canonical decimal id only, as the server's parseId accepts it (F598). */
function parseId(raw: string | undefined): number {
  const t = (raw ?? '').trim();
  return /^[1-9]\d*$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : 0;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function installationState(inst: GithubAppInstallation): string {
  if (inst.removedAt) return c.red('removed');
  if (inst.suspendedAt) return c.yellow('suspended');
  return c.green('active');
}

function printInstallations(rows: GithubAppInstallation[]): void {
  if (rows.length === 0) {
    info('No installations yet. Install the App on GitHub, then run `ninedeploy github-app sync <id>`.');
    return;
  }
  table(
    rows.map((i) => ({
      id: i.id,
      account: plain(i.accountLogin ?? `installation ${i.installationId}`),
      type: plain(i.accountType ?? '—'),
      repos: i.repositorySelection,
      state: installationState(i),
      source: i.sourceId ?? '—',
    })),
    ['id', 'account', 'type', 'repos', 'state', 'source'],
  );
}

/** `ninedeploy github-app list` */
export async function githubAppList(client: NineDeployClient): Promise<void> {
  header('GitHub Apps');
  const apps = await spinner('Fetching GitHub Apps', () => client.githubApps.list());
  if (apps.length === 0) {
    const panel = loadConfig().baseUrl.replace(/\/+$/, '');
    info(`No GitHub App registered. One-click setup runs in the browser: ${panel}/sources → GitHub Apps → Create GitHub App.`);
    info('For GitHub Enterprise Server or an existing App: `ninedeploy github-app add-manual`.');
    return;
  }
  table(
    apps.map((a) => ({
      id: a.id,
      name: plain(a.name),
      appId: a.appId,
      owner: plain(a.ownerLogin ?? '—'),
      host: plain(new URL(a.webBaseUrl).host),
    })),
    ['id', 'name', 'appId', 'owner', 'host'],
  );
}

function printApp(app: GithubApp): void {
  kv('Name', plain(app.name));
  kv('App ID', app.appId);
  kv('Slug', app.slug ? plain(app.slug) : null);
  kv('Owner', app.ownerLogin ? `${plain(app.ownerLogin)}${app.ownerType ? ` (${plain(app.ownerType)})` : ''}` : null);
  kv('GitHub', plain(app.webBaseUrl));
  kv('API', plain(app.apiBaseUrl));
  kv('Webhook URL', app.webhookUrl);
  kv('Install URL', app.installUrl ? plain(app.installUrl) : null);
  kv('Private key', app.hasPrivateKey ? c.green('✓ set') : c.red('missing'));
}

/** `ninedeploy github-app show <id>` */
export async function githubAppShow(client: NineDeployClient, idArg: string): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error('Usage: ninedeploy github-app show <id>');
  header(`GitHub App #${id}`);
  try {
    const [app, installations] = await spinner('Fetching', () => Promise.all([client.githubApps.get(id), client.githubApps.installations(id)]));
    printApp(app);
    console.log();
    printInstallations(installations);
  } catch (err) {
    error(message(err));
  }
}

/** The private key from `--key-file`, else NINEDEPLOY_GITHUB_APP_KEY (with `\n` escapes turned back into newlines). */
function readPrivateKey(keyFile: string | undefined): string | null {
  if (keyFile) return readFileSync(keyFile, 'utf8').trim();
  const fromEnv = process.env[KEY_ENV]?.trim();
  return fromEnv ? fromEnv.replace(/(?:\\r)?\\n/g, '\n') : null;
}

export interface AddManualOptions {
  name?: string;
  appId?: string;
  keyFile?: string;
  webBaseUrl?: string;
  apiBaseUrl?: string;
}

/** `ninedeploy github-app add-manual` — an existing App, or one on GitHub Enterprise Server. */
export async function githubAppAddManual(client: NineDeployClient, opts: AddManualOptions = {}): Promise<void> {
  header('Add GitHub App');
  const name = (opts.name ?? (await prompt('Display name (e.g. NineDeploy GHES)'))).trim();
  if (!name) return error('A name is required');
  const appId = parseId(opts.appId ?? (await prompt('GitHub App ID')));
  if (!appId) return error('A numeric GitHub App ID is required');
  if ((opts.webBaseUrl === undefined) !== (opts.apiBaseUrl === undefined)) {
    return error('--web-base-url and --api-base-url go together (omit both for github.com)');
  }
  let privateKey: string | null;
  try {
    privateKey = readPrivateKey(opts.keyFile);
  } catch (err) {
    return error(`Could not read the private key: ${message(err)}`);
  }
  if (!privateKey) return error(`A private key is required: pass --key-file <path.pem> or set ${KEY_ENV}`);
  const key = privateKey;
  const webhookSecret = process.env[WEBHOOK_SECRET_ENV]?.trim() || undefined;
  try {
    const app = await spinner('Verifying the key with GitHub and saving', () =>
      client.githubApps.create({
        name,
        appId,
        privateKey: key,
        ...(webhookSecret ? { webhookSecret } : {}),
        ...(opts.webBaseUrl !== undefined ? { webBaseUrl: opts.webBaseUrl, apiBaseUrl: opts.apiBaseUrl } : {}),
      }),
    );
    success(`GitHub App "${plain(app.name)}" registered (id: ${app.id})`);
    if (!webhookSecret) info('The panel generated a webhook secret and pointed the App\'s webhook at itself.');
    if (app.installUrl) info(`Install it: ${plain(app.installUrl)} — then run \`ninedeploy github-app sync ${app.id}\`.`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy github-app sync <id>` */
export async function githubAppSync(client: NineDeployClient, idArg: string): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error('Usage: ninedeploy github-app sync <id>');
  header(`Sync installations of GitHub App #${id}`);
  try {
    const res = await spinner('Syncing installations from GitHub', () => client.githubApps.syncInstallations(id));
    success(`${res.created} new, ${res.updated} updated, ${res.removed} removed; ${res.sourcesCreated} source(s) created`);
    if (res.truncated) info('The installation list hit the page cap; nothing was marked removed.');
    printInstallations(res.installations);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy github-app rotate-key <id> [--key-file <path>]` */
export async function githubAppRotateKey(client: NineDeployClient, idArg: string, opts: { keyFile?: string } = {}): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error('Usage: ninedeploy github-app rotate-key <id> --key-file <path.pem>');
  header(`Rotate the private key of GitHub App #${id}`);
  let privateKey: string | null;
  try {
    privateKey = readPrivateKey(opts.keyFile);
  } catch (err) {
    return error(`Could not read the private key: ${message(err)}`);
  }
  if (!privateKey) return error(`A private key is required: pass --key-file <path.pem> or set ${KEY_ENV}`);
  const key = privateKey;
  try {
    await spinner('Verifying the new key with GitHub', () => client.githubApps.rotateKey(id, key));
    success('Private key replaced. Revoke the old key on GitHub.');
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy github-app remove <id> [--yes]` */
export async function githubAppRemove(client: NineDeployClient, idArg: string, opts: { yes?: boolean } = {}): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error('Usage: ninedeploy github-app remove <id>');
  header(`Remove GitHub App #${id}`);
  if (!opts.yes) {
    const confirm = await prompt(`Type "delete" to forget GitHub App #${id}`, '');
    if (confirm.trim() !== 'delete') {
      info('Aborted.');
      return;
    }
  }
  try {
    await spinner('Removing', () => client.githubApps.remove(id));
    success(`GitHub App #${id} removed.`);
    info('Its installation sources stay; clones through them fail until the App is registered again.');
  } catch (err) {
    error(message(err));
  }
}

export interface ServiceGithubOptions {
  status?: string;
  prComment?: string;
  migrate?: string;
  finalize?: boolean;
  unlink?: boolean;
}

/** `on` / `off` → boolean; anything else is a usage error (null). */
function onOff(value: string | undefined): boolean | undefined | null {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'on') return true;
  if (v === 'off') return false;
  return null;
}

function printLink(link: ServiceGithubLink | null): void {
  if (!link) {
    info('Not linked to a GitHub App installation. Link it with `--migrate <sourceId>` (a gh-app:… source).');
    return;
  }
  kv('Repository', plain(link.repoFullName));
  kv('State', link.active ? c.green('active (App webhooks deploy it)') : c.yellow(link.enabled ? 'inactive (installation suspended or removed)' : 'disabled'));
  kv('Token scope', link.tokenScope);
  kv('Commit status', link.reportStatus ? 'on' : 'off');
  kv('PR comment', link.prComment ? 'on' : 'off');
  kv('Source', link.sourceId ?? null);
  kv('Previous src', link.previousSourceId ?? null);
}

/**
 * `ninedeploy services github <id> [--status on|off] [--pr-comment on|off]
 *  [--migrate <sourceId>] [--finalize] [--unlink]` — without flags it shows
 * the link. Steps run in order: migrate, feedback, finalize. `--unlink`
 * (revert) runs alone; the server answers 409 with the reason when the
 * service clones through the App source itself.
 */
export async function serviceGithub(client: NineDeployClient, idArg: string, opts: ServiceGithubOptions = {}): Promise<void> {
  const id = parseId(idArg);
  if (!id) return error('Usage: ninedeploy services github <id> [--status on|off] [--pr-comment on|off] [--migrate <sourceId>] [--finalize] [--unlink]');
  const reportStatus = onOff(opts.status);
  const prComment = onOff(opts.prComment);
  if (reportStatus === null) return error('--status takes on or off');
  if (prComment === null) return error('--pr-comment takes on or off');
  const migrateTo = opts.migrate === undefined ? undefined : parseId(opts.migrate);
  if (migrateTo === 0) return error(`Invalid --migrate source id: ${opts.migrate}`);
  const changes = migrateTo !== undefined || reportStatus !== undefined || prComment !== undefined || opts.finalize === true;
  if (opts.unlink && changes) return error('--unlink runs on its own');
  header(`GitHub link of service #${id}`);
  try {
    if (opts.unlink) {
      const res = await spinner('Reverting to the previous source', () => client.services.github.unlink(id));
      success(`Unlinked. Source is now ${res.sourceId ?? 'none'}; ${res.webhooksReactivated} webhook(s) switched back on.`);
      return;
    }
    if (migrateTo !== undefined) {
      await spinner('Linking to the GitHub App installation', () => client.services.github.migrate(id, migrateTo));
      success('Linked. The previous source and webhook stay as a fallback until --finalize.');
    }
    if (reportStatus !== undefined || prComment !== undefined) {
      await spinner('Updating GitHub feedback', () =>
        client.services.github.feedback(id, {
          ...(reportStatus !== undefined ? { reportStatus } : {}),
          ...(prComment !== undefined ? { prComment } : {}),
        }),
      );
      success('GitHub feedback updated.');
    }
    if (opts.finalize) {
      const res = await spinner('Finalizing', () => client.services.github.finalize(id));
      success(`Finalized; ${res.webhooksDeactivated} webhook(s) switched off.`);
    }
    const { link } = await spinner('Fetching the link', () => client.services.github.get(id));
    printLink(link);
  } catch (err) {
    error(message(err));
  }
}
