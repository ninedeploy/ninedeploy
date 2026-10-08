#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { getClient } from './client.js';
import { loadConfig, saveConfig } from './config.js';
import { banner, error } from './lib/format.js';
import { loginAction } from './commands/login.js';
import { setupAction } from './commands/setup.js';
import {
  servicesCompose, servicesCreate, servicesDelete, servicesDeploy, servicesExport,
  servicesGet, servicesInspect, servicesLifecycle, servicesList, servicesLogs,
  servicesStickyAction,
} from './commands/services.js';
import {
  dbCreate, dbList, deploysCancel, deploysList, deploysQueue, deploysRemove, deploysRollback,
  systemDashboard, systemInfo, systemRotateKeys, systemUpdateCheck, tplDeploy, tplList,
  tokenCreate, tokenList,
} from './commands/misc.js';
import {
  activityList, alertsCreate, alertsList, alertsRemove,
  backupsCreate, backupsDrill, backupsDrills, backupsList, backupsRestore,
  deploysWatch, domainsAcceptTransfer, domainsAdd, domainsCancelTransfer, domainsList,
  domainsPreviewTransfer, domainsRemove, domainsTransfer, domainsVerify,
  envList, envRemove, envSet, networksCreate, networksList, networksRemove,
  sessionsList, sessionsRevoke, systemExport, systemImport,
  usersList, usersResetLink, volumesList, volumesRemove,
} from './commands/manage.js';
import {
  notificationsCreateFcm as _notifCreateFcm,
  notificationsCreateWebhook as _notifCreateWebhook,
  notificationsList as _notifList,
  notificationsRemove as _notifRemove,
  notificationsTest as _notifTest,
} from './commands/notifications.js';
import { databasePgbouncer } from './commands/pgbouncer.js';
import { backupPolicyGet, backupPolicySet } from './commands/backupPolicy.js';
import { logsSearch } from './commands/logs.js';
import {
  emailTemplatesList,
  emailTemplatesPreview,
  emailTemplatesReset,
  emailTemplatesSet,
} from './commands/emailTemplates.js';
import {
  certificatesCustomDelete,
  certificatesCustomList,
  certificatesCustomReplace,
  certificatesCustomUpload,
  certificatesExpiring,
  certificatesList,
} from './commands/certificates.js';
import {
  databaseImport, databaseImports, databasePublicAccess, type ImportCliOptions, type PublicAccessOptions,
} from './commands/databaseAccess.js';
import { proxyConfigClear, proxyConfigGet, proxyConfigSet, proxyConfigValidate } from './commands/proxyConfig.js';
import {
  secretProvidersDelete, secretProvidersList, secretProvidersSetAws, secretProvidersSetVault, secretProvidersTest,
  type AwsCliOptions, type VaultCliOptions,
} from './commands/secretProviders.js';
import {
  accessGrantsAdd, accessGrantsList, accessGrantsRemove, accessGrantsUpdate, accessMe,
  terminalOpen, terminalsKill, terminalsList, terminalsShow, trafficService, trafficSettings, trafficSummary,
  type TerminalOpenOptions, type TerminalsListOptions,
} from './commands/operations.js';
import {
  communityTemplatesImport,
  communityTemplatesList,
  communityTemplatesRemove,
} from './commands/communityTemplates.js';
import {
  pluginsList, pluginsMarketplace, pluginsMarketplaceRefresh, pluginsInstall,
  pluginsEnable, pluginsDisable, pluginsUninstall,
  pluginsInspect, pluginsReload,
} from './commands/plugins.js';
import {
  configCenterList, configCenterGet, configCenterSet, configCenterDelete,
} from './commands/configCenter.js';
import { demoSeed } from './commands/demo.js';
import {
  workspacesList, workspacesGet, workspacesCreate, workspacesDelete,
} from './commands/workspaces.js';
import { housekeepingPrune, imagesList, imagesPrune, positiveIntOption } from './commands/housekeeping.js';
import {
  serverStartAction, serverStopAction, serverStatusAction, serverLogsAction,
} from './commands/server.js';
import { doctorAction } from './commands/doctor.js';
import {
  firewallStatus, firewallToggle, firewallAddRule, firewallDeleteRule, firewallApplyRecommended,
} from './commands/firewall.js';
import {
  sourcesAdd, sourcesKeygen, sourcesList, sourcesRemove, sourcesShow, sourcesTest,
} from './commands/sources.js';
import {
  githubAppAddManual, githubAppList, githubAppRemove, githubAppRotateKey, githubAppShow, githubAppSync, serviceGithub,
} from './commands/githubApps.js';
import {
  webhooksAdd, webhooksList, webhooksRemove, webhooksShow,
} from './commands/webhooks.js';
import { deployFromGithub } from './commands/deploy.js';
import { manifestApply, manifestInit, manifestShow, manifestValidate } from './commands/manifest.js';
import { templatesInit } from './commands/templates.js';
import {
  domainsPresetAddNamecheapAction,
  domainsPresetApplyAction,
  domainsPresetListAction,
} from './commands/domains.js';
import {
  configPresetApplyAction, configPresetGetAction,
  configPresetListAction, configPresetRegisterAction, configPresetRemoveAction,
} from './commands/configPresets.js';
import {
  metricsFlushAction, metricsShowAction,
} from './commands/metrics.js';
import {
  buildCacheStatsAction,
} from './commands/buildCache.js';
import {
  brandingGetAction, brandingSetAction,
} from './commands/branding.js';
import {
  egressClearAction, egressListAction, egressSetAction,
} from './commands/egress.js';
import {
  ssoAddAction, ssoListAction, ssoRemoveAction,
} from './commands/sso.js';
import {
  panelBackupDecryptAction, panelBackupListAction, panelBackupNowAction, panelBackupSetAction, panelBackupStatusAction,
  type PanelBackupSetOptions,
} from './commands/panelBackup.js';

const program = new Command();

program
  .name('ninedeploy')
  .description('NineDeploy — self-hosted deployment platform CLI\n\n  Deploy apps from Git or Docker Hub in one click.')
  // r195: read from package.json — the literal was stuck at 0.7.9.
  .version((createRequire(import.meta.url)('../package.json') as { version: string }).version)
  .helpOption('-h, --help', 'Display this help');

// ── Auth ──────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize local instance and setup admin user (alias for setup)')
  .action(() => setupAction());

program
  .command('setup')
  .description('Create the first admin user on a fresh instance')
  .action(() => setupAction());

program
  .command('login')
  .description('Authenticate against a NineDeploy server')
  .action(() => loginAction());

program
  .command('logout')
  .description('Revoke this CLI session and clear stored credentials')
  .action(async () => {
    const cfg = loadConfig();
    // r551: revoke ONLY this CLI's session. `POST /auth/logout` bumps the
    // user's tokenVersion and revokes every session — signing out of the CLI
    // used to sign the user out of every browser too. It is also on the
    // no-refresh list, so with an expired access token it failed silently and
    // the long-lived refresh token stayed live server-side. The sessions list
    // is refresh-aware and flags the caller's own row (`current`), which
    // `DELETE /auth/sessions/:id` then revokes. Best-effort: local credentials
    // are always cleared, and the outcome is printed either way.
    let outcome = 'No stored credentials — nothing to revoke on the server.';
    if (cfg.token || cfg.refreshToken) {
      try {
        const client = getClient();
        const current = (await client.auth.sessions.list()).find((s) => s.current);
        if (current) {
          await client.auth.sessions.revoke(current.id);
          outcome = `Revoked this CLI session (#${current.id}) on ${cfg.baseUrl}; other sessions stay signed in.`;
        } else {
          outcome = 'The stored credential is not a login session (API token?) — nothing was revoked server-side; delete the token from the dashboard if it should stop working.';
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = `Could not revoke the session on the server (${msg}). Revoke it from the dashboard or \`ninedeploy sessions revoke <id>\` after logging in again.`;
      }
    }
    saveConfig({ baseUrl: cfg.baseUrl });
    console.log('  ✓ Signed out (local credentials cleared).');
    console.log(`  ${outcome}`);
  });

program
  .command('whoami')
  .description('Show the currently authenticated user and server')
  .action(async () => {
    const cfg = loadConfig();
    if (!cfg.token) { console.log('  Not logged in. Run `ninedeploy login`.'); process.exit(1); }
    try {
      const user = await getClient().auth.me();
      console.log(`  ${user.email}  (${user.isOperator ? 'operator' : 'member'})  @  ${cfg.baseUrl}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Could not reach the server (${msg}). Check the URL/network, or run \`ninedeploy login\` if the token expired.`);
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Show or change the server URL')
  .option('-s, --server <url>', 'Set server URL')
  .action((opts: { server?: string }) => {
    if (opts.server) {
      const cfg = loadConfig();
      // Tokens are issuer-scoped: carrying credentials (especially the
      // refresh token) across a server switch would replay server A's
      // bearer at B. Keep them only when the URL is genuinely unchanged.
      const same = cfg.baseUrl === opts.server;
      saveConfig({
        baseUrl: opts.server,
        token: same ? cfg.token : undefined,
        refreshToken: same ? cfg.refreshToken : undefined,
      });
      console.log(`  ✓ Server set to ${opts.server}`);
    } else {
      const cfg = loadConfig();
      console.log(`  Server:  ${cfg.baseUrl}`);
      console.log(`  Token:   ${cfg.token ? '✓ configured' : '✗ not set'}`);
    }
  });

// ── Services ──────────────────────────────────────────────────────────────
const services = program.command('services').alias('service').description('Manage services');

services.command('list').description('List all services').action(() => servicesList(getClient()));

services.command('create').description('Create a service (interactive wizard)').action(() => servicesCreate(getClient()));

services.command('get <id>').description('Show service details').action((id: string) => servicesGet(getClient(), id));

services.command('deploy <id>').description('Trigger a new deployment').action((id: string) => servicesDeploy(getClient(), id));

services.command('logs <id>').description('View runtime container logs').action((id: string) => servicesLogs(getClient(), id));

services.command('stop <id>').description('Stop a running service').action((id: string) => servicesLifecycle(getClient(), 'stop', id));

services.command('start <id>').description('Start a stopped service').action((id: string) => servicesLifecycle(getClient(), 'start', id));

services.command('restart <id>').description('Restart a service').action((id: string) => servicesLifecycle(getClient(), 'restart', id));

services.command('delete <id>').description('Delete a service (with confirmation)').action((id: string) => servicesDelete(getClient(), id));

services.command('export <id>').description('Export a service as a JSON bundle').action((id: string) => servicesExport(getClient(), id));

services.command('compose <id>').description('Show generated runtime Docker Compose YAML').action((id: string) => servicesCompose(getClient(), id));

services.command('inspect <id>').description('Inspect runtime container and Traefik tags').action((id: string) => servicesInspect(getClient(), id));

services.command('sticky <id>')
  .description('Toggle sticky-session routing (Traefik sticky cookie, G-28)')
  .option('--enable', 'Route every request to the same backend container')
  .option('--disable', 'Remove the sticky-cookie middleware')
  .action((id: string, opts: { enable?: boolean; disable?: boolean }) => servicesStickyAction(getClient(), id, opts));

// 0.13: the service's GitHub App link (show, feedback, migrate/finalize/revert).
services.command('github <id>')
  .description('Show or change the GitHub App link (commit statuses, PR comments, migrate, finalize, unlink)')
  .option('--status <onOff>', 'Commit statuses for deploys: on | off')
  .option('--pr-comment <onOff>', 'PR preview comments: on | off')
  .option('--migrate <sourceId>', 'Link to the GitHub App installation behind this gh-app source')
  .option('--finalize', 'Detach the previous source and switch the per-service webhooks off')
  .option('--unlink', 'Revert: restore the previous source and webhooks, remove the link')
  .action((id: string, opts: { status?: string; prComment?: string; migrate?: string; finalize?: boolean; unlink?: boolean }) =>
    serviceGithub(getClient(), id, opts));

// ── Databases ────────────────────────────────────────────────────────────
const databases = program.command('databases').description('Manage databases');

databases.command('list').description('List all databases').action(() => dbList(getClient()));

databases.command('create').description('Create a database (interactive)').action(() => dbCreate(getClient()));

// ── PgBouncer sidecar (G-32) ─────────────────────────────────────────────
databases
  .command('pgbouncer <dbId> <action>')
  .description('Manage the PgBouncer sidecar: enable | disable | status (postgres only)')
  .option('--port <port>', 'Override the listen port (enable only)', (v: string) => Number(v))
  .action((dbId: string, action: string, opts: { port?: number }) =>
    databasePgbouncer(getClient(), dbId, action, opts),
  );

// ── Per-database backup policy (0.12) ────────────────────────────────────
const backupPolicyCmd = databases
  .command('backup-policy')
  .description('Per-database backup schedule, retention and destination');
backupPolicyCmd
  .command('get <dbId>')
  .description('Show the backup policy (or the built-in daily schedule)')
  .action((dbId: string) => backupPolicyGet(getClient(), dbId));
backupPolicyCmd
  .command('set <dbId>')
  .description('Save the backup policy; unset flags keep their current value')
  .option('--cron <expr>', '5-field cron (minute hour day month weekday), server local time')
  .option('--preset <name>', 'daily | 6h | weekly')
  .option('--keep <n>', 'Scheduled dumps kept locally (1-365)')
  .option('--keep-remote <n>', 'Remote copies kept (1-365; default: same as --keep)')
  .option('--destination <dest>', 'Backup destination id, "active" or "local"')
  .option('--enable', 'Turn scheduled backups on')
  .option('--disable', 'Turn scheduled backups off for this database')
  .action((dbId: string, opts: { cron?: string; preset?: string; keep?: string; keepRemote?: string; destination?: string; enable?: boolean; disable?: boolean }) =>
    backupPolicySet(getClient(), dbId, opts),
  );

// ── Public access and dump import (0.14) ────────────────────────────────
/* v8 ignore start -- the FakeCommand in test/index.test.ts records but never invokes the action;
 * the implementations are exercised by test/databaseAccess.test.ts. */
databases
  .command('public-access <id>')
  .description('Show, enable/update (--enable) or disable (--disable) public access through a TCP sidecar (operator)')
  .option('--enable', 'Enable or update public access; unset flags keep their current value')
  .option('--disable', 'Remove the sidecar (the settings are kept)')
  .option('--port <port>', 'Host port, 1024-65535')
  .option('--allow <cidr...>', 'Allowed source addresses or CIDRs (replaces the allow-list)')
  .option('--tls <mode>', 'none | terminate (not for mysql/mariadb)')
  .option('--tls-host <host>', 'Hostname clients connect to (and the TLS name in terminate mode)')
  .action((id: string, opts: PublicAccessOptions) => databasePublicAccess(getClient(), id, opts));
databases
  .command('import <id>')
  .description('Import a dump from a local file (chunked, resumable) or a backup destination object (operator)')
  .option('--file <path>', 'Dump file to upload')
  .option('--from-s3 <destinationId>', 'Backup destination to read the object from (operator)')
  .option('--key <key>', 'Object key inside the destination prefix (with --from-s3)')
  .option('--clean', 'postgres custom format: drop objects before recreating them')
  .option('--no-single-transaction', 'postgres: do not wrap the restore in one transaction')
  .option('--drop', 'mongo: drop each collection before restoring it')
  .option('--confirm-replace', 'redis/valkey: required, the RDB replaces the whole dataset')
  .option('--no-safety-backup', 'Skip the pre-import backup (operator, or a database created in the last 10 minutes)')
  .option('--resume <importId>', 'Continue an interrupted upload of the same file')
  .option('--no-wait', 'Return once the import has started')
  .action((id: string, opts: ImportCliOptions) => databaseImport(getClient(), id, opts));
databases
  .command('imports <id>')
  .description('List a database\'s imports')
  .option('--watch', 'Keep polling until no import is uploading, pending or running')
  .action((id: string, opts: { watch?: boolean }) => databaseImports(getClient(), id, opts));
/* v8 ignore stop */

// ── Templates ─────────────────────────────────────────────────────────────
const templates = program.command('templates').description('Browse the template hub and scaffold starter manifests from it');

templates.command('list').description('List all templates').action(() => tplList(getClient()));

templates.command('deploy <id>').description('Deploy a template by ID').action((id: string) => tplDeploy(getClient(), id));

// ── Community templates (G-13) ───────────────────────────────────────────
const community = templates.command('community').description('Manage per-instance community template contributions');
community
  .command('list')
  .description('List every community template (curated + community merged in the regular `list`)')
  .action(() => communityTemplatesList(getClient()));
community
  .command('import <file>')
  .description('Import a community template (file path, or `-` for stdin)')
  .option('--replace', 'Overwrite an existing template with the same id')
  .action((file: string, opts: { replace?: boolean }) => communityTemplatesImport(getClient(), file, opts));
community
  .command('remove <id>')
  .description('Remove a community template by id')
  .action((id: string) => communityTemplatesRemove(getClient(), id));

// ── Deploys ───────────────────────────────────────────────────────────────
const deploys = program.command('deploys').description('Manage deployments');

deploys
  .command('queue')
  .description('List every in-flight (queued / building / deploying) deploy across all services you can see')
  .action(() => deploysQueue(getClient()));

deploys.command('list <serviceId>').description('List deployments for a service').action((id: string) => deploysList(getClient(), id));

deploys.command('rollback <serviceId> <deployId>').description('Rollback to a previous deployment').action((svcId: string, depId: string) => deploysRollback(getClient(), svcId, depId));

deploys.command('cancel <serviceId> <deployId>').description('Cancel a queued or in-flight deployment').action((svcId: string, depId: string) => deploysCancel(getClient(), svcId, depId));

deploys.command('rm <serviceId> <deployId>')
  .description('Remove a finished deployment from history, with its build log')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((svcId: string, depId: string, opts: { yes?: boolean }) => deploysRemove(getClient(), svcId, depId, opts.yes === true));

// ── Token ─────────────────────────────────────────────────────────────────
const token = program.command('token').description('Manage API tokens');

token.command('create').description('Create a new API token').action(() => tokenCreate(getClient()));

token.command('list').description('List API tokens').action(() => tokenList(getClient()));

// ── System ────────────────────────────────────────────────────────────────
const system = program.command('system').description('System information & tools');

system.command('info').description('Show version, stats, and tech stack').action(() => systemInfo(getClient()));

system.command('dashboard').description('Live dashboard with service health').action(() => systemDashboard(getClient()));
system.command('update-check').description('Compare the running version with the latest release')
  .option('-f, --force', 'Bypass the 6h cache')
  .action((opts: { force?: boolean }) => systemUpdateCheck(getClient(), opts.force === true));
system.command('rotate-keys')
  .description('Re-encrypt every stored secret onto the newest NINEDEPLOY_MASTER_KEYS version')
  .action(() => systemRotateKeys(getClient()));

// ── Env vars ──────────────────────────────────────────────────────────────
const envCmd = program.command('env').description('Manage service environment variables');

// 0.12 `--preview`: the service's preview-only set — injected ONLY into its
// PR previews (overriding the parent's non-secret values there), never into
// the service itself. Previews still never receive the service's secrets.
const PREVIEW_FLAG = 'Target the preview-only set: values only this service\'s PR previews receive';

envCmd.command('list <serviceId>').description('List a service\'s env vars')
  .option('--preview', PREVIEW_FLAG)
  .action((id: string, opts?: { preview?: boolean }) => envList(getClient(), id, opts));

envCmd.command('set <serviceId> <key> <value>')
  .description('Create or update an env var (secret by default)')
  .option('--public', 'Store as a plain (non-secret) value')
  .option('--preview', PREVIEW_FLAG)
  .action((id: string, key: string, value: string, opts: { public?: boolean; preview?: boolean }) => envSet(getClient(), id, key, value, opts));

envCmd.command('rm <serviceId> <key>').description('Remove an env var by key')
  .option('--preview', PREVIEW_FLAG)
  .action((id: string, key: string, opts?: { preview?: boolean }) => envRemove(getClient(), id, key, opts));

// ── Domains ────────────────────────────────────────────────────────────────
const domainsCmd = program.command('domains').description('Manage domains & routing');

domainsCmd.command('list').description('List all domains').action(() => domainsList(getClient()));

domainsCmd.command('add <serviceId> <host>')
  .description('Route a hostname to a service')
  .option('-p, --path <path>', 'Path prefix', '/')
  .option('--no-ssl', 'Serve over plain HTTP (no TLS)')
  .action((id: string, host: string, opts: { path?: string; ssl?: boolean }) => domainsAdd(getClient(), id, host, opts));

domainsCmd.command('rm <serviceId> <domainId>').description('Remove a domain').action((svcId: string, domId: string) => domainsRemove(getClient(), svcId, domId));

domainsCmd.command('verify <serviceId> <domainId>')
  .description('Check a pending domain TXT ownership challenge and bring it live')
  .action((svcId: string, domId: string) => domainsVerify(getClient(), svcId, domId));

// Domain transfer (G-29) — start / preview / accept / cancel.
domainsCmd
  .command('transfer <domainId>')
  .description('Start a domain transfer to a target email; prints an accept URL')
  .requiredOption('--to <email>', 'Email of the target user (existing or future)')
  .action((domainId: string, opts: { to: string }) => domainsTransfer(getClient(), domainId, opts));

domainsCmd
  .command('preview-transfer <token>')
  .description('Preview a pending transfer by token (no auth required)')
  .action((token: string) => domainsPreviewTransfer(getClient(), token));

domainsCmd
  .command('accept-transfer <token>')
  .description('Accept a transfer as the target user; the domain moves to the given service')
  .requiredOption('--service-id <id>', 'Target service id (must be one the caller can admin)')
  .action((token: string, opts: { serviceId: string }) => domainsAcceptTransfer(getClient(), token, opts));

domainsCmd
  .command('cancel-transfer <token>')
  .description('Cancel a pending transfer (source user or instance operator only)')
  .action((token: string) => domainsCancelTransfer(getClient(), token));

const domainsPresetsCmd = domainsCmd.command('preset').description('Manage DNS presets (IDomainProvider automation)');
domainsPresetsCmd.command('list').description('List registered IDomainProvider drivers').action(() => domainsPresetListAction(getClient()));
domainsPresetsCmd.command('apply <hostname>')
  .description('Create a DNS record for the given hostname via the active provider')
  .option('-c, --content <content>', 'Override the record content (A record IPv4 or CNAME hostname)')
  .action((hostname: string, opts: { content?: string }) => domainsPresetApplyAction(getClient(), hostname, { content: opts.content }));
// r200: the spec used to be the bare words "add namecheap" — commander reads the bare word as a
// REQUIRED ARGUMENT, so the action received the string "namecheap" as `opts`
// and posted undefined credentials. The provider is now a real argument.
domainsPresetsCmd
  .command('add <provider>')
  .description('Save DNS provider API credentials (supported: namecheap) so dns_records_provider can use it')
  .requiredOption('--api-user <user>', 'Namecheap username (account owner)')
  .requiredOption('--api-key <key>', 'Namecheap API key (the key itself; the server encrypts it at rest)')
  .requiredOption('--client-ip <ip>', 'Public IPv4 of this server, already whitelisted on the Namecheap account panel')
  .action((provider: string, opts: { apiUser: string; apiKey: string; clientIp: string }) => {
    if (provider !== 'namecheap') {
      error(`Unsupported DNS provider "${provider}" (supported: namecheap)`);
      process.exitCode = 1;
      return;
    }
    return domainsPresetAddNamecheapAction(getClient(), { apiUser: opts.apiUser, apiKey: opts.apiKey, clientIp: opts.clientIp });
  });

// ── Config Presets ───────────────────────────────────────────────────────
const configPresetsCmd = program.command('config-preset').description('Manage named configCenter bundles that can be re-applied to a fresh instance');

configPresetsCmd.command('list').description('List every registered preset id').action(() => configPresetListAction(getClient()));

configPresetsCmd.command('get <id>').description('Show a preset\'s values and description').action((id: string) => configPresetGetAction(getClient(), id));

configPresetsCmd.command('register <id>')
  .description('Register a preset from a JSON values file (key → value object)')
  .option('-f, --file <file>', 'JSON file with key → value pairs (required, validated inside the action)')
  .option('-d, --description <text>', 'Optional human description (max 500 chars)')
  .action((id: string, opts: { file?: string; description?: string }) => configPresetRegisterAction(getClient(), id, { file: opts.file, description: opts.description }));

configPresetsCmd.command('apply <id>')
  .description('Write every value in the preset to configCenter (idempotent)')
  .option('--override <json>', 'Inline JSON object of one-shot overrides for this call only')
  .action((id: string, opts: { override?: string }) => {
    let override: Record<string, unknown> | undefined;
    if (opts.override) {
      try {
        override = JSON.parse(opts.override);
      } catch (err) {
        error(`Invalid --override JSON: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    }
    void configPresetApplyAction(getClient(), id, { override });
  });

configPresetsCmd.command('remove <id>').description('Unregister a preset (does NOT undo the live apply)').action((id: string) => configPresetRemoveAction(getClient(), id));

// ── Metrics (G-09) ────────────────────────────────────────────────────────
const metricsCmd = program.command('metrics').description('Metric history plugin — archive kernel events to a pluggable backend (G-09)');
metricsCmd.command('show').description('Show the active backend, events, and last flush marker').action(() => metricsShowAction(getClient()));
metricsCmd.command('flush').description('Run the built-in backend retention sweep').action(() => metricsFlushAction(getClient()));

// ── Build Cache (G-01) ────────────────────────────────────────────────────
const buildCacheCmd = program.command('build-cache').description('Build cache plugin — per-backend LRU stats (G-01)');
buildCacheCmd.command('stats').description('Show per-backend cache counters and the merged totals').action(() => buildCacheStatsAction(getClient()));

// ── Branding (G-30) ───────────────────────────────────────────────────────
const brandingCmd = program.command('branding').description('Override the panel logo, color, support email and footer (G-30)');
brandingCmd.command('get').description('Show the current branding overrides').action(() => brandingGetAction(getClient()));
brandingCmd
  .command('set')
  .description('Override one or more branding fields')
  .option('--logo-url <url>', 'Logo URL (use --logo-url="" to clear)')
  .option('--primary-color <hex>', 'Primary color (hex code, e.g. #1d4ed8)')
  .option('--support-email <addr>', 'Support email shown in the help menu')
  .option('--footer-html <html>', 'Custom footer HTML for the sign-in page')
  .action((opts: { logoUrl?: string; primaryColor?: string; supportEmail?: string; footerHtml?: string }) => {
    // Empty strings map to `null` so the operator can clear a value.
    const cleaned: Record<string, string> = {};
    if (opts.logoUrl !== undefined) cleaned.logoUrl = opts.logoUrl;
    if (opts.primaryColor !== undefined) cleaned.primaryColor = opts.primaryColor;
    if (opts.supportEmail !== undefined) cleaned.supportEmail = opts.supportEmail;
    if (opts.footerHtml !== undefined) cleaned.footerHtml = opts.footerHtml;
    void brandingSetAction(getClient(), cleaned);
  });

// ── Egress IP (G-15) ─────────────────────────────────────────────────────
const egressCmd = program.command('egress').description('Manage per-project outbound IP rules (G-15)');
egressCmd.command('list').description('Show every egress IP rule across every registered driver').action(() => egressListAction(getClient()));
egressCmd
  .command('set <projectId> <ip>')
  .description('Attach a stable outbound IP to a project (e.g. after creating a VPS)')
  .option('--driver <name>', 'Target a specific driver (default: first registered)')
  .action((projectId: string, ip: string, opts: { driver?: string }) => egressSetAction(getClient(), projectId, ip, opts));
egressCmd
  .command('clear <projectId>')
  .description('Detach the egress rule for a project')
  .option('--driver <name>', 'Target a specific driver (default: first registered)')
  .action((projectId: string, opts: { driver?: string }) => egressClearAction(getClient(), projectId, opts));

// ── SSO (G-22) ───────────────────────────────────────────────────────────
const ssoCmd = program.command('sso').description('Manage OIDC / SAML SSO providers (G-22)');
ssoCmd.command('list').description('List every configured provider').action(() => ssoListAction(getClient()));
ssoCmd
  .command('add <oidc|saml> <name>')
  .description('Register a new OIDC or SAML provider (config flags become the config_json blob)')
  .option('--issuer <url>', 'OIDC issuer URL (OIDC only)')
  .option('--client-id <id>', 'OIDC client id (OIDC only)')
  .option('--client-secret <secret>', 'OIDC client secret (OIDC only)')
  .option('--redirect-uri <uri>', 'OIDC redirect URI (OIDC only)')
  .option('--metadata-url <url>', 'SAML IdP metadata URL (SAML only)')
  .action((type: string, name: string, opts: { issuer?: string; clientId?: string; clientSecret?: string; redirectUri?: string; metadataUrl?: string }) => {
    const config: Record<string, unknown> = {};
    if (type === 'oidc') {
      if (opts.issuer) config.issuer = opts.issuer;
      if (opts.clientId) config.clientId = opts.clientId;
      if (opts.clientSecret) config.clientSecret = opts.clientSecret;
      if (opts.redirectUri) config.redirectUri = opts.redirectUri;
    } else {
      if (opts.metadataUrl) config.metadataUrl = opts.metadataUrl;
    }
    void ssoAddAction(getClient(), type, name, config);
  });
ssoCmd.command('remove <id>').description('Remove a provider by id').action((id: string) => ssoRemoveAction(getClient(), id));

// ── Volumes ────────────────────────────────────────────────────────────────
const volumesCmd = program.command('volumes').description('Manage Docker volumes');

volumesCmd.command('list').description('List all volumes').action(() => volumesList(getClient()));

volumesCmd.command('rm <name>').description('Delete a volume (with confirmation)').action((name: string) => volumesRemove(getClient(), name));

// ── Networks ───────────────────────────────────────────────────────────────
const networksCmd = program.command('networks').description('Manage Docker networks');

networksCmd.command('list').description('List user-defined networks').action(() => networksList(getClient()));

networksCmd.command('create <name> [driver]').description('Create a network (bridge|overlay)').action((name: string, driver: string) => networksCreate(getClient(), name, driver === 'overlay' ? 'overlay' : 'bridge'));

networksCmd.command('rm <name>').description('Delete a network (with confirmation)').action((name: string) => networksRemove(getClient(), name));

// ── Sessions ───────────────────────────────────────────────────────────────
const sessionsCmd = program.command('sessions').description('Manage your active sessions');

sessionsCmd.command('list').description('List active sessions').action(() => sessionsList(getClient()));

sessionsCmd.command('revoke <id>').description('Revoke a session').action((id: string) => sessionsRevoke(getClient(), id));

// ── Backups ────────────────────────────────────────────────────────────────
const backupsCmd = program.command('backups').description('Manage database backups');

backupsCmd.command('list [databaseId]').description('List backups (all, or one database\'s)').action((id?: string) => backupsList(getClient(), id));

backupsCmd.command('create <databaseId>').description('Back a database up now').action((id: string) => backupsCreate(getClient(), id));

backupsCmd.command('restore <databaseId> <backupId>').description('Restore a backup (destructive)').action((id: string, bId: string) => backupsRestore(getClient(), id, bId));

backupsCmd
  .command('drill <databaseId> <backupId>')
  .description('Smoke-test a backup without restoring it into a live database')
  .action((id: string, bId: string) => backupsDrill(getClient(), id, bId));

backupsCmd
  .command('drills <databaseId>')
  .description('List recent backup drills for a database')
  .action((id: string) => backupsDrills(getClient(), id));

// ── Alerts ─────────────────────────────────────────────────────────────────
const alertsCmd = program.command('alerts').description('Manage alert rules');

alertsCmd.command('list').description('List alert rules').action(() => alertsList(getClient()));

alertsCmd.command('create <name> <metric> <operator> <threshold>')
  .description('Create an alert rule (metric: cpu|memory|cert-expiry|disk|server_offline, operator: > or <)')
  .option('-w, --windows <n>', 'Consecutive 30s samples before firing', '1')
  .option('-s, --service <id>', 'Scope to a service (default: host-wide)')
  .action((name: string, metric: string, op: string, threshold: string, opts: { windows?: string; service?: string }) => alertsCreate(getClient(), name, metric, op, threshold, opts));

alertsCmd.command('rm <id>').description('Delete an alert rule').action((id: string) => alertsRemove(getClient(), id));

// ── Notifications (G-06) ───────────────────────────────────────────────────
const notificationsCmd = program.command('notifications').description('Manage notification channels (admin)');
notificationsCmd.command('list').description('List configured channels').action(() => _notifList(getClient()));
notificationsCmd
  .command('create-webhook <name> <url>')
  .description('Create a webhook channel (HMAC-signed POST; G-06)')
  .option('--secret <s>', 'HMAC secret used to sign the body')
  .option('--header <h>', 'Signature header name (default: X-NineDeploy-Signature)')
  .option('--algo <algo>', 'Hash algorithm: sha256 (default) or sha1', 'sha256')
  .option('--event-filter <prefix>', 'Comma-separated event prefixes to match (default: all)')
  .option('--template <kv>', 'Body template field (key=value, repeatable)', (v: string, prev: string[] = []) => [...prev, v])
  .action(
    (name: string, url: string, opts: { secret?: string; header?: string; algo?: 'sha256' | 'sha1'; eventFilter?: string; template?: string[] }) =>
      _notifCreateWebhook(getClient(), name, url, opts),
  );
notificationsCmd
  .command('create-fcm <name> <deviceToken>')
  .description('Create an FCM push channel (Firebase Cloud Messaging HTTP v1; G-22)')
  .requiredOption('--service-account <file>', 'Path to a Firebase service account JSON file')
  .action((name: string, deviceToken: string, opts: { serviceAccount: string }) =>
    _notifCreateFcm(getClient(), name, deviceToken, opts),
  );
notificationsCmd.command('test <id>').description('Fire a test event through the channel').action((id: string) => _notifTest(getClient(), id));
notificationsCmd.command('rm <id>').description('Remove a channel').action((id: string) => _notifRemove(getClient(), id));

// ── Users & activity ───────────────────────────────────────────────────────
program.command('users').description('List users (admin)').action(() => usersList(getClient()));
program.command('reset-link <idOrEmail>').description('Generate a one-time password reset link (admin)')
  .action((who: string) => usersResetLink(getClient(), who));

program.command('activity').description('Show recent activity').action(() => activityList(getClient()));

// ── Plugins & Microkernel ───────────────────────────────────────────────────
const plugins = program.command('plugins').description('Manage plugins and marketplace extensions');
plugins.command('list').description('List all installed plugins').action(() => pluginsList(getClient()));
plugins.command('marketplace').description('Browse verified marketplace extensions').action(() => pluginsMarketplace(getClient()));
plugins.command('marketplace-refresh').description('Bypass the cache and re-fetch the live signed marketplace index').action(() => pluginsMarketplaceRefresh(getClient()));
plugins.command('inspect <id>').description('Inspect plugin manifest and runtime telemetry').action((id: string) => pluginsInspect(getClient(), id));
plugins.command('install <target>').description('Install a plugin (marketplace, sandbox)')
  // r440: only what the server can actually load — npm/git/local were
  // advertised here and always answered 400 UnsupportedPluginSourceError.
  .option('-s, --source <source>', 'Source type (marketplace, sandbox)', 'marketplace')
  .option('-n, --name <name>', 'Custom display name')
  .option('-v, --version <version>', 'Custom version')
  .option('-d, --desc <description>', 'Description')
  .action((target: string, opts: any) => pluginsInstall(getClient(), target, opts));
plugins.command('enable <id>').description('Enable an installed plugin').action((id: string) => pluginsEnable(getClient(), id));
plugins.command('disable <id>').description('Disable a plugin').action((id: string) => pluginsDisable(getClient(), id));
plugins.command('reload <id>').description('Hot-reload a plugin').action((id: string) => pluginsReload(getClient(), id));
plugins.command('uninstall <id>').description('Uninstall a plugin').action((id: string) => pluginsUninstall(getClient(), id));

// ── Configuration Center ────────────────────────────────────────────────────
const configCenter = program.command('config-center').description('Manage central configuration entries and secrets');
configCenter.command('list').description('List configuration entries')
  .option('-c, --category <category>', 'Filter by category')
  .option('-p, --plugin <pluginId>', 'Filter by plugin id')
  .option('-r, --reveal', 'Reveal decrypted secrets (admin only)')
  .action((opts: any) => configCenterList(getClient(), opts));
configCenter.command('get <key>').description('Get a configuration key in detail').action((key: string) => configCenterGet(getClient(), key));
configCenter.command('set <key> <value>').description('Set or update a configuration key')
  .option('-s, --secret', 'Mark as encrypted secret')
  .option('-d, --desc <description>', 'Description')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .action((key: string, value: string, opts: any) => configCenterSet(getClient(), key, value, opts));
configCenter.command('delete <key>').description('Delete a custom configuration key').action((key: string) => configCenterDelete(getClient(), key));

// ── Workspaces & Teams ──────────────────────────────────────────────────────
const workspaces = program.command('workspaces').description('Manage workspaces and team organizations');
workspaces.command('list').description('List accessible workspaces').action(() => workspacesList(getClient()));
workspaces.command('get <id>').description('Get workspace details and team members').action((id: string) => workspacesGet(getClient(), id));
workspaces.command('create <name>').description('Create a new workspace')
  .option('-d, --desc <description>', 'Workspace description')
  .action((name: string, opts: { desc?: string }) => workspacesCreate(getClient(), name, { description: opts.desc }));
workspaces.command('delete <id>').description('Delete a workspace').action((id: string) => workspacesDelete(getClient(), id));

// ── Housekeeping ────────────────────────────────────────────────────────────
system.command('prune').description('Run system housekeeping prune (images, containers, build artifacts)').action(() => housekeepingPrune(getClient()));

// ── Images (G-12) ───────────────────────────────────────────────────────────
const images = program.command('images').description('Inspect and prune Docker images on the host');
images
  .command('ls')
  .description('List every image on the host with size / age / in-use metadata')
  .option('--sort <field>', 'Sort by `size` (default) or `age`', 'size')
  .action((opts: { sort?: 'size' | 'age' }) => imagesList(getClient(), { sort: opts.sort }));
images
  .command('prune')
  .description('Prune images. Refuses to run with no filter; pass --dry-run first.')
  // r554: validated whole numbers (the server's bounds) — `Number(v)` let
  // `1.5` / `abc` through to an opaque 422.
  .option('--keep-last <n>', 'Keep the newest N images per repo:tag (rest are candidates)', positiveIntOption(1000))
  .option('--older-than <hours>', 'Only prune images older than N hours', positiveIntOption(8760))
  .option('--dangling', 'Only prune dangling images (repo/tag both <none>)')
  .option('--dry-run', 'Report what would be deleted without actually deleting')
  .action(
    (opts: { keepLast?: number; olderThan?: number; dangling?: boolean; dryRun?: boolean }) =>
      imagesPrune(getClient(), {
        keepLast: opts.keepLast,
        olderThan: opts.olderThan,
        dangling: opts.dangling,
        dryRun: opts.dryRun,
      }),
  );

// ── Demo Mode ──────────────────────────────────────────────────────────────
const demo = program.command('demo').description('Demo mode operations');
demo.command('seed').description('Seed Next.js Docker + PM2 demo environment with PostgreSQL database').action(() => demoSeed(getClient()));

// ── Server Management (Local Docker) ───────────────────────────────────────
const serverCmd = program.command('server').description('Manage local NineDeploy Docker server');
serverCmd.command('start')
  .description('Start local NineDeploy server container')
  .option('-p, --port <port>', 'Host port to bind', '3000')
  .option('-i, --image <image>', 'Docker image tag', 'ghcr.io/ninedeploy/ninedeploy:latest')
  .option('-n, --name <name>', 'Container name', 'ninedeploy')
  .action((opts: { port?: string; image?: string; name?: string }) => serverStartAction(opts));

serverCmd.command('stop')
  .description('Stop local NineDeploy server container')
  .option('-n, --name <name>', 'Container name', 'ninedeploy')
  .action((opts: { name?: string }) => serverStopAction(opts));

serverCmd.command('status')
  .description('Check local server container and health status')
  .option('-p, --port <port>', 'Host port', '3000')
  .option('-n, --name <name>', 'Container name', 'ninedeploy')
  .action((opts: { port?: string; name?: string }) => serverStatusAction(opts));

serverCmd.command('logs')
  .description('View local server container logs')
  .option('-n, --lines <lines>', 'Number of lines to show', '50')
  .option('-c, --name <name>', 'Container name', 'ninedeploy')
  .action((opts: { lines?: string; name?: string }) => serverLogsAction(opts));

// ── Cluster log search (G-16) ─────────────────────────────────────────────
const logsCmd = program.command('logs').description('Search the configured log drain (Loki)');
logsCmd
  .command('search <query>')
  .description('Full-text search across the configured Loki drain')
  .option('--service <id>', 'Restrict to one service id')
  .option('--since <window>', 'How far back to search (e.g. 15m, 2h, 1d)', '15m')
  .option('--limit <n>', 'Max lines to return (default 200, max 1000)')
  .option('--drain <id>', 'Query a specific drain (default: first enabled Loki drain)')
  .option('--json', 'Print raw JSON instead of the human-readable table')
  .action(
    (query: string, opts: { service?: string; since?: string; limit?: string; drain?: string; json?: boolean }) =>
      logsSearch(getClient(), query, opts),
  );

// ── Email templates (G-30) ─────────────────────────────────────────────────
const emailTemplatesCmd = program.command('email-templates').description('Manage per-workspace email template overrides');
emailTemplatesCmd
  .command('list <workspaceId>')
  .description('List the built-in templates and whether the workspace has overridden each')
  .action((wid: string) => emailTemplatesList(getClient(), wid));

emailTemplatesCmd
  .command('preview <workspaceId> <name> [vars...]')
  .description('Render a template with the supplied vars (key=value pairs)')
  .action((wid: string, name: string, vars: string[]) => emailTemplatesPreview(getClient(), wid, name, vars));

emailTemplatesCmd
  .command('set <workspaceId> <name>')
  .description('Upsert the workspace override for a template (admin only)')
  .requiredOption('--subject <subject>', 'Override subject line')
  .requiredOption('--text <text>', 'Override plain-text body (use {{var}} placeholders)')
  .action((wid: string, name: string, opts: { subject: string; text: string }) => emailTemplatesSet(getClient(), wid, name, opts));

emailTemplatesCmd
  .command('reset <workspaceId> <name>')
  .description('Drop the workspace override and fall back to the built-in default')
  .action((wid: string, name: string) => emailTemplatesReset(getClient(), wid, name));

// ── System export/import + deploy log streaming ────────────────────────────
system.command('export [file]').description('Export the full system state as JSON').action((file?: string) => systemExport(file));

system.command('import <file>').description('Import a system bundle (destructive)').action((file: string) => systemImport(file));

// ── Panel self-backup (0.12) ────────────────────────────────────────────────
const panelBackupCmd = system.command('panel-backup').description("Scheduled, passphrase-sealed backups of the panel's own state");
panelBackupCmd.command('status').description('Show the schedule, destination, retention and the last run').action(() => panelBackupStatusAction(getClient()));
panelBackupCmd
  .command('set')
  .description('Change the panel backup settings (omitted options keep their value)')
  .option('--enable', 'Turn scheduled panel backups on')
  .option('--disable', 'Turn scheduled panel backups off')
  .option('--cron <expr>', '5-field cron expression, e.g. "0 3 * * *"')
  .option('--destination <id>', 'Backup destination id (see Settings → Integrations)')
  .option('--retain <n>', 'How many panel backups to keep in the destination')
  .option('--passphrase', 'Prompt for a new recovery passphrase (keep it off this server)')
  .action((opts: PanelBackupSetOptions) => panelBackupSetAction(getClient(), opts));
panelBackupCmd
  .command('now')
  .description('Back up the panel now')
  .option('--wait', 'Wait for the run to finish and report its outcome')
  .action((opts: { wait?: boolean }) => panelBackupNowAction(getClient(), opts));
panelBackupCmd
  .command('list')
  .description('List the panel backups in the destination, newest first')
  .option('--destination <id>', 'Destination to list (default: the configured one)')
  .action((opts: { destination?: string }) => panelBackupListAction(getClient(), opts));
panelBackupCmd
  .command('decrypt <file> [out]')
  .description('Offline: open a downloaded .ndpb with the recovery passphrase into a .tar.gz for `system import`')
  .action((file: string, out?: string) => panelBackupDecryptAction(file, out));

// ── Certificates (G-15) ─────────────────────────────────────────────────────
const certificates = program.command('certificates').description('Traefik certificate inventory and renewal status');
certificates
  .command('list')
  .description('List every certificate the panel knows about with days-to-expiry and status')
  .option('--threshold <days>', 'Expiring-soon threshold in days (default 30)')
  .action((opts: { threshold?: string }) => certificatesList(getClient(), opts));
certificates
  .command('expiring')
  .description('Focused list of certificates expiring within N days')
  .option('--days <days>', 'Window in days (default 30)')
  .action((opts: { days?: string }) => certificatesExpiring(getClient(), opts));
// 0.14: uploaded certificates (operator).
const customCerts = certificates.command('custom').description('Uploaded TLS certificates (operator)');
/* v8 ignore start -- exercised by test/certificates.test.ts. */
customCerts.command('list').description('List uploaded certificates, their hostnames, expiry and covered domains')
  .action(() => certificatesCustomList(getClient()));
customCerts.command('upload')
  .description('Upload a certificate chain and its unencrypted private key')
  .option('--name <name>', 'Display name')
  .option('--cert <path>', 'PEM certificate chain, leaf first')
  .option('--key <path>', 'PEM private key (unencrypted)')
  .action((opts: { name?: string; cert?: string; key?: string }) => certificatesCustomUpload(getClient(), opts));
customCerts.command('replace <id>')
  .description('Replace a certificate (e.g. after renewal)')
  .option('--name <name>', 'New display name')
  .option('--cert <path>', 'PEM certificate chain, leaf first')
  .option('--key <path>', 'PEM private key (unencrypted)')
  .action((id: string, opts: { name?: string; cert?: string; key?: string }) => certificatesCustomReplace(getClient(), id, opts));
customCerts.command('delete <id>')
  .description('Delete a certificate (covered domains fall back to ACME)')
  .alias('rm')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((id: string, opts: { yes?: boolean }) => certificatesCustomDelete(getClient(), id, opts));
/* v8 ignore stop */

// ── Proxy custom config (0.14) ──────────────────────────────────────────────
const proxyCmd = program.command('proxy').description('Traefik proxy management (operator)');
const proxyConfigCmd = proxyCmd.command('config').description('Custom Traefik dynamic config (custom.yml)');
/* v8 ignore start -- exercised by test/proxyConfig.test.ts. */
proxyConfigCmd.command('get').description('Show the custom config, its status and the last error').action(() => proxyConfigGet(getClient()));
proxyConfigCmd.command('validate')
  .description('Validate a YAML file without applying it')
  .option('--file <path>', 'YAML file')
  .action((opts: { file?: string }) => proxyConfigValidate(getClient(), opts));
proxyConfigCmd.command('set')
  .description('Validate and apply a YAML file')
  .option('--file <path>', 'YAML file')
  .action((opts: { file?: string }) => proxyConfigSet(getClient(), opts));
proxyConfigCmd.command('clear')
  .description('Remove the custom config')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((opts: { yes?: boolean }) => proxyConfigClear(getClient(), opts));
/* v8 ignore stop */

// ── Secret managers (0.14) ──────────────────────────────────────────────────
const secretsCmd = program.command('secrets').description('Deploy-time secret references');
const providersCmd = secretsCmd.command('providers').description('HashiCorp Vault / OpenBao and AWS Secrets Manager (operator)');
/* v8 ignore start -- exercised by test/secretProviders.test.ts. */
providersCmd.command('list').description('List the secret managers and their last test').action(() => secretProvidersList(getClient()));
providersCmd.command('set-vault')
  .description('Configure Vault / OpenBao (KV v2); token from --token-file or NINEDEPLOY_VAULT_TOKEN')
  .option('--address <url>', 'Vault address (https)')
  .option('--namespace <ns>', 'Vault Enterprise / OpenBao namespace')
  .option('--mount <path>', 'KV v2 mount (default secret)')
  .option('--auth <method>', 'token | approle (default token)')
  .option('--approle-mount <path>', 'AppRole auth mount (default approle)')
  .option('--token-file <path>', 'File holding the token (or NINEDEPLOY_VAULT_TOKEN)')
  .option('--role-id-file <path>', 'File holding the AppRole role id (or NINEDEPLOY_VAULT_ROLE_ID)')
  .option('--secret-id-file <path>', 'File holding the AppRole secret id (or NINEDEPLOY_VAULT_SECRET_ID)')
  .option('--enable', 'Enable the provider')
  .option('--disable', 'Disable the provider (references stay literal)')
  .action((opts: VaultCliOptions) => secretProvidersSetVault(getClient(), opts));
providersCmd.command('set-aws')
  .description('Configure AWS Secrets Manager; secret key from --secret-access-key-file or NINEDEPLOY_AWS_SECRET_ACCESS_KEY')
  .option('--region <region>', 'AWS region, e.g. eu-west-1')
  .option('--endpoint <url>', 'VPC endpoint or compatible service (https)')
  .option('--role-arn <arn>', 'IAM role to assume')
  .option('--external-id <id>', 'External id for the role (with --role-arn)')
  .option('--role-session-name <name>', 'Session name (default ninedeploy)')
  .option('--access-key-id <id>', 'Access key id (or NINEDEPLOY_AWS_ACCESS_KEY_ID)')
  .option('--secret-access-key-file <path>', 'File holding the secret access key (or NINEDEPLOY_AWS_SECRET_ACCESS_KEY)')
  .option('--session-token-file <path>', 'File holding a session token (or NINEDEPLOY_AWS_SESSION_TOKEN)')
  .option('--enable', 'Enable the provider')
  .option('--disable', 'Disable the provider (references stay literal)')
  .action((opts: AwsCliOptions) => secretProvidersSetAws(getClient(), opts));
providersCmd.command('test <kind>')
  .description('Test a provider (vault | aws), optionally reading one secret')
  .option('--probe-path <path>', 'vault: also read this path (relative to the mount)')
  .option('--probe-secret-id <id>', 'aws: also read this secret')
  .action((kind: string, opts: { probePath?: string; probeSecretId?: string }) => secretProvidersTest(getClient(), kind, opts));
providersCmd.command('delete <kind>')
  .description('Remove a provider (vault | aws); its references stay literal at deploy')
  .alias('rm')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((kind: string, opts: { yes?: boolean }) => secretProvidersDelete(getClient(), kind, opts));
/* v8 ignore stop */

// ── 0.15: terminals, traffic analytics, access grants ────────────────────
const terminalsCmd = program.command('terminals').description('Terminal session history and termination (operator)');
/* v8 ignore start -- exercised by test/operations.test.ts. */
terminalsCmd.command('list')
  .description('List terminal sessions, newest first (metadata only)')
  .option('--status <status>', 'pending | active | ended | failed | expired')
  .option('--target <kind>', 'service | database | container | host')
  .option('--limit <n>', 'Page size (1-200, default 50)')
  .option('--before <id>', 'Page back from this session id')
  .action((opts: TerminalsListOptions) => terminalsList(getClient(), opts));
terminalsCmd.command('show <id>').description('Show one terminal session').action((id: string) => terminalsShow(getClient(), id));
terminalsCmd.command('kill <id>')
  .description('Terminate a live session (or revoke a pending one)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((id: string, opts: { yes?: boolean }) => terminalsKill(getClient(), id, opts));
/* v8 ignore stop */
const terminalCmd = program.command('terminal').alias('shell').description('Open an interactive shell (operator; needs a TTY)');
/* v8 ignore start -- exercised by test/operations.test.ts. */
terminalCmd.command('service <id>')
  .description('Shell into the container of a service')
  .option('--replica <n>', 'Replica number (1-based)')
  .option('--node <serverId>', 'A node the service runs on (fan-out target)')
  .action((id: string, opts: TerminalOpenOptions) => terminalOpen(getClient(), 'service', id, opts));
terminalCmd.command('db <id>')
  .description('Shell into the container of a database')
  .option('--client', 'Open the engine client (psql, mysql, redis-cli) with the stored credentials')
  .action((id: string, opts: TerminalOpenOptions) => terminalOpen(getClient(), 'db', id, opts));
terminalCmd.command('container <name>')
  .description('Shell into a managed container on the panel host')
  .action((name: string) => terminalOpen(getClient(), 'container', name));
terminalCmd.command('host [serverId]')
  .description('Root shell on the panel host or a node (off by default; asks for your password)')
  .action((serverId: string | undefined) => terminalOpen(getClient(), 'host', serverId));
/* v8 ignore stop */
const trafficCmd = program.command('traffic').description('Traffic analytics (opt-in)');
/* v8 ignore start -- exercised by test/operations.test.ts. */
trafficCmd.command('settings')
  .description('Show or change traffic analytics (enabling or disabling recreates Traefik once)')
  .option('--enable', 'Turn analytics on')
  .option('--disable', 'Turn analytics off')
  .option('--retention <days>', 'Keep hourly rows this many days (1-400)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((opts: { enable?: boolean; disable?: boolean; retention?: string; yes?: boolean }) => trafficSettings(getClient(), opts));
trafficCmd.command('summary')
  .description('Instance traffic: totals, percentiles and top domains (operator)')
  .option('--range <range>', '1h | 24h | 7d | 30d (default 24h)')
  .option('--top <n>', 'Top domains (1-50, default 10)')
  .action((opts: { range?: string; top?: string }) => trafficSummary(getClient(), opts));
trafficCmd.command('service <id>')
  .description('Traffic of one service, by domain')
  .option('--range <range>', '1h | 24h | 7d | 30d (default 24h)')
  .action((id: string, opts: { range?: string }) => trafficService(getClient(), id, opts));
/* v8 ignore stop */
const accessCmd = program.command('access').description('Project and environment access grants');
const grantsCmd = accessCmd.command('grants').description('Manage access grants in a workspace (workspace admin)');
/* v8 ignore start -- exercised by test/operations.test.ts. */
grantsCmd.command('list')
  .description('List the grants in a workspace')
  .option('--workspace <id>', 'Workspace id')
  .option('--user <id>', 'Only this user')
  .option('--project <id>', 'Only this project')
  .option('--environment <id>', 'Only this environment')
  .action((opts: { workspace?: string; user?: string; project?: string; environment?: string }) => accessGrantsList(getClient(), opts));
grantsCmd.command('add')
  .description('Grant a role on a project, an environment, or both')
  .option('--workspace <id>', 'Workspace id')
  .option('--email <email>', 'The user, by email')
  .option('--user <id>', 'The user, by id')
  .option('--project <id>', 'Project id')
  .option('--environment <id>', 'Environment id')
  .option('--role <role>', 'viewer | member | admin')
  .action((opts: { workspace?: string; email?: string; user?: string; project?: string; environment?: string; role?: string }) =>
    accessGrantsAdd(getClient(), opts),
  );
grantsCmd.command('update <grantId>')
  .description('Change the role of a grant')
  .option('--workspace <id>', 'Workspace id')
  .option('--role <role>', 'viewer | member | admin')
  .action((grantId: string, opts: { workspace?: string; role?: string }) => accessGrantsUpdate(getClient(), grantId, opts));
grantsCmd.command('remove <grantId>')
  .alias('rm')
  .description('Revoke a grant')
  .option('--workspace <id>', 'Workspace id')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((grantId: string, opts: { workspace?: string; yes?: boolean }) => accessGrantsRemove(getClient(), grantId, opts));
accessCmd.command('me').description('Your own grants and guest workspaces').action(() => accessMe(getClient()));
/* v8 ignore stop */

deploys.command('watch <serviceId> <deployId>').description('Stream a deployment\'s build logs live').action((svcId: string, depId: string) => deploysWatch(svcId, depId));

// ── Diagnostics ───────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Run system, Docker, server connectivity, and auth diagnostics')
  .option('--fix', 'Automatically attempt to heal and repair detected issues')
  .action((opts: { fix?: boolean }) => doctorAction(getClient(), opts));

// ── Sources (private repo credentials) ────────────────────────────────────
const sources = program.command('sources').alias('creds').description('Manage private repository credentials (PATs / SSH keys)');
/* v8 ignore start -- the FakeCommand in test/index.test.ts records but never invokes the action;
 * the implementation is exercised end-to-end by test/sources.test.ts. */
sources.command('list').description('List configured sources').action(() => sourcesList(getClient()));
sources.command('show <id>').description('Show one source in detail').action((id: string) => sourcesShow(getClient(), id));
sources.command('add [name]')
  .description('Add a new source (interactive; PAT/SSH key from env or masked prompt)')
  .option('--base-url <url>', 'Gitea base URL, e.g. https://git.example.com (enables the live test and repo list)')
  .action((name: string | undefined, opts: { baseUrl?: string }) => sourcesAdd(getClient(), name, opts));
sources.command('test [id]').description('Verify that a stored source token still authenticates').action((id?: string) => sourcesTest(getClient(), id));
sources.command('keygen [id]').description('Generate an ed25519 deploy-key pair on the panel and print the public key').action((id?: string) => sourcesKeygen(getClient(), id));
sources.command('remove [id]').description('Remove a source (with confirmation)').alias('rm').action((id?: string) => sourcesRemove(getClient(), id));
/* v8 ignore stop */

// ── GitHub Apps (0.13) ─────────────────────────────────────────────────────
const githubApp = program.command('github-app').description('Manage GitHub Apps (one-click setup runs in the panel: Sources → GitHub Apps)');
/* v8 ignore start -- see sources.ts note above; exercised by test/githubApps.test.ts. */
githubApp.command('list').description('List registered GitHub Apps').action(() => githubAppList(getClient()));
githubApp.command('show <id>').description('Show a GitHub App and its installations').action((id: string) => githubAppShow(getClient(), id));
githubApp.command('add-manual')
  .description('Register an existing GitHub App or one on GitHub Enterprise Server (key from --key-file or NINEDEPLOY_GITHUB_APP_KEY)')
  .option('--name <name>', 'Display name')
  .option('--app-id <id>', 'GitHub App ID')
  .option('--key-file <path>', 'Path to the App private key (.pem)')
  .option('--web-base-url <url>', 'GHES web URL, e.g. https://github.example.com (with --api-base-url)')
  .option('--api-base-url <url>', 'GHES API URL, e.g. https://github.example.com/api/v3 (with --web-base-url)')
  .action((opts: { name?: string; appId?: string; keyFile?: string; webBaseUrl?: string; apiBaseUrl?: string }) => githubAppAddManual(getClient(), opts));
githubApp.command('sync <id>').description('Sync installations from GitHub (creates their gh-app sources)').action((id: string) => githubAppSync(getClient(), id));
githubApp.command('rotate-key <id>')
  .description('Replace the App private key (verified with GitHub first)')
  .option('--key-file <path>', 'Path to the new private key (.pem)')
  .action((id: string, opts: { keyFile?: string }) => githubAppRotateKey(getClient(), id, opts));
githubApp.command('remove <id>')
  .description('Forget a GitHub App (its installation sources stay)')
  .alias('rm')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action((id: string, opts: { yes?: boolean }) => githubAppRemove(getClient(), id, opts));
/* v8 ignore stop */

// ── Deploy (one-shot private GitHub deploy) ────────────────────────────────
const deploy = program.command('deploy').description('End-to-end deploy helpers');
/* v8 ignore start -- see sources.ts note above */
deploy.command('create-from-github [url]')
  .description('One-shot: add source (PAT), analyse repo, create service, set env, trigger deploy, optional webhook')
  .alias('from-github')
  .action((url?: string) => deployFromGithub(getClient(), url));
/* v8 ignore stop */

// ── Webhooks (auto-deploy on push) ─────────────────────────────────────────
const webhooksCmd = program.command('webhooks').description('Manage auto-deploy webhooks');
/* v8 ignore start -- see sources.ts note above */
webhooksCmd.command('list <serviceId>').description('List a service\'s webhooks').action((id: string) => webhooksList(getClient(), id));
webhooksCmd.command('show <serviceId> <hookId>').description('Show one webhook in detail').action((svc: string, hook: string) => webhooksShow(getClient(), svc, hook));
webhooksCmd.command('add <serviceId> [branch]')
  .description('Add a webhook (returns the HMAC secret once for pasting into GitHub)')
  .action((svc: string, branch?: string) => webhooksAdd(getClient(), svc, branch));
webhooksCmd.command('remove <serviceId> <hookId>').description('Remove a webhook (with confirmation)').alias('rm').action((svc: string, hook: string) => webhooksRemove(getClient(), svc, hook));
/* v8 ignore stop */

// ── Firewall & Security ───────────────────────────────────────────────────
const fw = program.command('firewall').description('Manage host firewall (UFW) and open ports');
fw.command('status').description('Show host firewall status, default policies, and active rules').action(() => firewallStatus(getClient()));
fw.command('enable').description('Enable host firewall (ensures SSH port 22 is permitted)').action(() => firewallToggle(getClient(), true));
fw.command('disable').description('Disable host firewall').action(() => firewallToggle(getClient(), false));
fw.command('recommended').description('Apply standard VPS profile (allows 22 SSH, 80 HTTP, 443 HTTPS and enables firewall)').action(() => firewallApplyRecommended(getClient()));
fw.command('allow <port>')
  .description('Open a host port (e.g. 5432 or 8080)')
  .option('-p, --proto <proto>', 'Protocol (tcp|udp|any)', 'tcp')
  .option('-f, --from <ip>', 'Source IP/CIDR to restrict access to')
  .option('-c, --comment <text>', 'Rule description/comment')
  .action((port: string, opts: any) => firewallAddRule(getClient(), port, { ...opts, action: 'allow' }));
fw.command('deny <port>')
  .description('Block a host port')
  .option('-p, --proto <proto>', 'Protocol (tcp|udp|any)', 'tcp')
  .option('-f, --from <ip>', 'Source IP/CIDR')
  .option('-c, --comment <text>', 'Rule description/comment')
  .action((port: string, opts: any) => firewallAddRule(getClient(), port, { ...opts, action: 'deny' }));
fw.command('rm <id>').description('Delete a firewall rule by ID').action((id: string) => firewallDeleteRule(getClient(), id));

// ── .ninedeploy manifest (project-side) ───────────────────────────────────
// Lives at the end of the command list so the sidebar/help shows it last;
// operators discover it after they've explored services/sources/etc.
const manifest = program
  .command('manifest')
  .description('Manage the .ninedeploy file in this repo');
manifest
  .command('init')
  .description('Scaffold a starter .ninedeploy based on detected project kind')
  .action(() => manifestInit(process.cwd()));
manifest
  .command('validate')
  .description('Parse + schema-check the .ninedeploy in the current directory')
  .action(() => manifestValidate(process.cwd()));
manifest
  .command('show')
  .description('Print a human-readable summary of the parsed manifest')
  .action(() => manifestShow(process.cwd()));
manifest
  .command('apply <serviceId>')
  .description('Apply the .ninedeploy manifest to a service (requires admin role)')
  .action((serviceId: string) => manifestApply(getClient(), process.cwd(), Number(serviceId)));

// ── Templates (one-click starter manifests from the panel registry) ───────
templates
  .command('init <templateId>')
  .description('Fetch a template from the panel and emit a starter .ninedeploy')
  .option('--host <host>', 'Default `routes[0].host` for the starter manifest')
  .option('--filename <name>', 'Filename to write when --write is set (default .ninedeploy)')
  .option('--write', 'Write to a file in the current directory instead of stdout')
  .action((templateId: string, opts: { host?: string; filename?: string; write?: boolean }) =>
    templatesInit(getClient(), templateId, process.cwd(), {
      host: opts.host,
      filename: opts.filename,
      write: Boolean(opts.write),
    }),
  );

// ── Banner on bare `ninedeploy` ───────────────────────────────────────────
if (process.argv.length <= 2) {
  banner();
  console.log(`  ${'Quick start:'.padEnd(20)} ninedeploy init`);
  console.log(`  ${'Server management:'.padEnd(20)} ninedeploy server start`);
  console.log(`  ${'Diagnostics:'.padEnd(20)} ninedeploy doctor`);
  console.log(`  ${'Browse templates:'.padEnd(20)} ninedeploy templates list`);
  console.log(`  ${'Deploy a service:'.padEnd(20)} ninedeploy services create`);
  console.log(`  ${'Deploy from GitHub:'.padEnd(28)} ninedeploy deploy create-from-github <url>`);
  console.log(`  ${'Manage private repo creds:'.padEnd(28)} ninedeploy sources add|list|test|remove`);
  console.log(`  ${'Manage auto-deploy webhooks:'.padEnd(28)} ninedeploy webhooks add|list|remove`);
  console.log(`  ${'View dashboard:'.padEnd(20)} ninedeploy system dashboard`);
  console.log(`  ${'Full help:'.padEnd(20)} ninedeploy --help`);
  console.log();
  process.exit(0);
}

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? `\n  ✗ ${err.message}\n` : String(err));
  process.exit(1);
});
