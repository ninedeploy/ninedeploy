import type { ManagedDatabase, TemplateSummary } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { c, error, fmtTime, header, info, kv, spinner, success, table, banner } from '../lib/format.js';
import { prompt } from '../prompts.js';
import { parseScopes } from './token.js';

/** `ninedeploy databases list` */
export async function dbList(client: NineDeployClient): Promise<void> {
  header('Databases');
  await spinner('Fetching', async () => {
    const dbs = await client.databases.list();
    if (dbs.length === 0) { info('No databases.'); return; }
    table(dbs.map((d: ManagedDatabase) => ({ id: d.id, name: d.name, engine: d.engine, status: d.status, port: d.port ?? '—' })), ['id', 'name', 'engine', 'status', 'port']);
  });
}

/** `ninedeploy databases create` */
export async function dbCreate(client: NineDeployClient): Promise<void> {
  header('Create Database');
  const name = await prompt('Database name');
  if (!name) return error('Name required');
  console.log('  Engines: 1=PostgreSQL  2=MySQL  3=MariaDB  4=Redis  5=MongoDB  6=Valkey  7=ClickHouse  8=Meilisearch  9=RabbitMQ');
  const choice = await prompt('Select engine (1-9)', '1');
  const engines = ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq'] as const;
  const engine = engines[Number(choice) - 1];
  // A fat-fingered number used to silently provision PostgreSQL — fail
  // instead of guessing.
  if (!engine) return error(`Unknown engine selection: ${choice}`);
  try {
    const db = await spinner('Creating database', () => client.databases.create({ name, engine }));
    success(`Database "${db.name}" created (id: ${db.id})`);
    if (db.connectionString) { info(`Connection: ${c.cyan(db.connectionString)}`); }
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy templates list` */
export async function tplList(client: NineDeployClient): Promise<void> {
  header('Template Hub');
  await spinner('Fetching templates', async () => {
    const templates = await client.templates.list();
    if (templates.length === 0) { info('No templates.'); return; }
    table(templates.map((t: TemplateSummary) => ({ emoji: t.emoji, name: t.name, category: t.category, featured: t.featured ? '★' : '' })), ['emoji', 'name', 'category', 'featured']);
  });
}

/** `ninedeploy templates deploy <id>` */
export async function tplDeploy(client: NineDeployClient, id: string): Promise<void> {
  if (!id) return error('Usage: ninedeploy templates deploy <template-id>');
  try {
    const res = await spinner(`Deploying ${id}`, () => client.templates.deploy(id));
    success(`Deployed! Service ID: ${res.serviceId}`);
    info(`Watch: ninedeploy services logs ${res.serviceId}`);
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy deploys list <serviceId>` */
export async function deploysList(client: NineDeployClient, svcIdStr: string): Promise<void> {
  const svcId = Number(svcIdStr);
  if (!svcId) return error('Usage: ninedeploy deploys list <serviceId>');
  header('Deployments');
  await spinner('Fetching', async () => {
    const deps = await client.deploys.list(svcId);
    if (deps.length === 0) { info('No deployments.'); return; }
    table(deps.map((d) => ({ id: d.id, status: d.status, commit: d.commitSha?.slice(0, 7) ?? '—', trigger: d.trigger, time: fmtTime(d.createdAt) })), ['id', 'status', 'commit', 'trigger', 'time']);
  });
}

/**
 * `ninedeploy deploys queue`
 *
 * Global queue view: every in-flight (queued / building / deploying) deploy
 * across every service the caller can see. The same data the web panel's
 * `/deploys` page renders, so an operator can audit the build pipeline
 * without leaving the terminal or opening a browser tab.
 */
export async function deploysQueue(client: NineDeployClient): Promise<void> {
  header('Global deploy queue');
  const data = await spinner('Fetching', () => client.deploys.queue());
  const counts = data.byStatus ?? { queued: 0, building: 0, deploying: 0 };
  const inFlight = data.items ?? [];
  if (inFlight.length === 0) {
    info('No in-flight deploys.');
    kv('queued', counts.queued ?? 0);
    kv('building', counts.building ?? 0);
    kv('deploying', counts.deploying ?? 0);
    return;
  }
  // The server returns items ordered claimed-first (building, then
  // deploying, then queued). Per-service queue position is the 1-based
  // index of this row among the `queued` siblings for the same
  // service. In-flight rows (building / deploying) get a dash — the
  // position number is only meaningful for rows waiting to start.
  const queuedByService = new Map<number, number>();
  table(
    inFlight.map((row) => {
      let pos: number;
      if (row.status === 'queued') {
        pos = (queuedByService.get(row.serviceId) ?? 0) + 1;
        queuedByService.set(row.serviceId, pos);
      } else {
        pos = 0;
      }
      return {
        service: row.serviceName || `service:${row.serviceId}`,
        serviceId: row.serviceId,
        deploy: row.id,
        status: row.status,
        pos: pos > 0 ? `${pos}` : '—',
        time: fmtTime(row.createdAt),
      };
    }),
    ['service', 'serviceId', 'deploy', 'status', 'pos', 'time'],
  );
  kv('queued', counts.queued ?? 0);
  kv('building', counts.building ?? 0);
  kv('deploying', counts.deploying ?? 0);
}

/** `ninedeploy deploys rollback <serviceId> <deployId>` */
export async function deploysRollback(client: NineDeployClient, svcIdStr: string, depIdStr: string): Promise<void> {
  const svcId = Number(svcIdStr);
  const depId = Number(depIdStr);
  if (!svcId || !depId) return error('Usage: ninedeploy deploys rollback <serviceId> <deployId>');
  try {
    const res = await spinner('Rolling back', () => client.deploys.rollback(svcId, depId));
    success(`Rollback to #${depId} queued (new deploy: #${res.deploymentId}).`);
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/**
 * `ninedeploy deploys cancel <serviceId> <deployId>`
 *
 * The route, the SDK method and the panel button all existed; the CLI was the
 * one surface without it, so a deploy started from CI could only be stopped
 * from a browser.
 */
export async function deploysCancel(client: NineDeployClient, svcIdStr: string, depIdStr: string): Promise<void> {
  const svcId = Number(svcIdStr);
  const depId = Number(depIdStr);
  if (!svcId || !depId) return error('Usage: ninedeploy deploys cancel <serviceId> <deployId>');
  try {
    await spinner('Cancelling', () => client.deploys.cancel(svcId, depId));
    // A queued deploy stops here; an in-flight one stops at the pipeline's next
    // step boundary, with the previous version still serving.
    success(`Deployment #${depId} cancelled.`);
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/**
 * `ninedeploy deploys rm <serviceId> <deployId>`
 *
 * Removes a finished deployment from history, with its build log. Refused for
 * an in-flight deployment (cancel it first) and for the one currently serving
 * traffic — that row carries the digest a rollback re-deploys.
 */
export async function deploysRemove(client: NineDeployClient, svcIdStr: string, depIdStr: string, yes = false): Promise<void> {
  const svcId = Number(svcIdStr);
  const depId = Number(depIdStr);
  if (!svcId || !depId) return error('Usage: ninedeploy deploys rm <serviceId> <deployId>');
  if (!yes) {
    const confirm = await prompt(`Permanently remove deployment #${depId} and its build log? (yes/no)`, 'no');
    if (confirm.toLowerCase() !== 'yes') return info('Aborted.');
  }
  try {
    await spinner('Removing', () => client.deploys.remove(svcId, depId));
    success(`Deployment #${depId} removed.`);
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy token create` */
export async function tokenCreate(client: NineDeployClient): Promise<void> {
  const name = await prompt('Token name', 'ci');
  // read = safe methods only · write = mutate as a non-operator ·
  // operator = no extra restriction. Blank = read-only (server default).
  // G-08 fine-grained: also accept
  // 'nd://scope/(read|write|admin)/<resource>' for per-resource
  // restriction; the server's scopeCovers() expands the legacy
  // shorthand against the URI form so a `write` token still
  // covers every `nd://scope/write/<r>`.
  const scopes = parseScopes(
    await prompt('Scopes (read,write,operator or nd://scope/(read|write|admin)/<resource> — blank = read)', 'write'),
  );
  try {
    const tok = await spinner('Creating token', () => client.auth.tokens.create(scopes.length ? { name, scopes } : { name }));
    success(`Token created: ${c.cyan(tok.token)}`);
    info(`Scopes: ${tok.scopes.length ? tok.scopes.join(', ') : 'unrestricted (legacy)'}`);
    info('Store this securely — it won\'t be shown again.');
  } catch (err) { error(err instanceof Error ? err.message : String(err)); }
}

/** `ninedeploy token list` */
export async function tokenList(client: NineDeployClient): Promise<void> {
  header('API Tokens');
  await spinner('Fetching', async () => {
    const tokens = await client.auth.tokens.list();
    if (tokens.length === 0) { info('No tokens.'); return; }
    table(tokens.map((t) => ({ id: t.id, name: t.name, last_used: fmtTime(t.lastUsedAt), created: fmtTime(t.createdAt) })), ['id', 'name', 'last_used', 'created']);
  });
}

/** `ninedeploy system info` */
export async function systemInfo(client: NineDeployClient): Promise<void> {
  header('System');
  await spinner('Fetching', async () => {
    const about = await client.about.get();
    banner();
    kv('Version', c.bold(`v${about.version}`));
    kv('License', about.license);
    kv('Services', about.stats?.services ?? '—');
    kv('Databases', about.stats?.databases ?? '—');
    kv('Deploys', about.stats?.deployments ?? '—');
    kv('Users', about.stats?.users ?? '—');
    kv('Repo', about.repo);
    console.log();
    header('Tech Stack');
    for (const group of about.techStack) {
      kv(group.category, group.items.join(', '));
    }
  });
}

/** `ninedeploy system update-check` */
export async function systemUpdateCheck(client: NineDeployClient, force: boolean): Promise<void> {
  header('Update check');
  const res = await spinner('Checking for updates', () => client.system.updateCheck(force));
  kv('Current', c.bold(`v${res.current}`));
  if (res.updateAvailable == null) {
    info('Latest release unknown (feed unreachable or checks disabled).');
  } else if (res.updateAvailable) {
    kv('Latest', c.bold(`v${res.latest}`));
    success(`A new release is available → ${c.cyan(res.notesUrl ?? `https://github.com/ninedeploy/ninedeploy/releases/tag/${res.latest}`)}`);
    info('Upgrade: curl -fsSL https://raw.githubusercontent.com/ninedeploy/ninedeploy/main/install.sh | bash');
  } else {
    kv('Latest', `v${res.latest}`);
    success('You are on the latest release.');
  }
}

/** `ninedeploy system dashboard` */
export async function systemDashboard(client: NineDeployClient): Promise<void> {
  header('Dashboard');
  await spinner('Probing health', async () => {
    const dash = await client.dashboard.get();
    const s = dash.stats;
    const allHealthy = dash.health.every((h) => h.healthy || h.status !== 'running');
    console.log(`  ${allHealthy ? '✅ All systems operational' : '⚠️  Some services need attention'}`);
    console.log();
    kv('Services', `${s.running} running / ${s.services} total`);
    kv('Databases', `${s.dbRunning} running / ${s.databases} total`);
    kv('Containers', s.containers);
    kv('Domains', s.domains);
    kv('Webhooks', s.webhooks);
    kv('Deployments', s.deployments);
    console.log();
    header('Service Health');
    if (dash.health.length === 0) { info('No services.'); return; }
    table(dash.health.map((h) => ({ id: h.serviceId, name: h.name, status: h.healthy ? 'healthy' : h.status, ms: h.responseMs ? `${h.responseMs}ms` : '—', type: h.type })), ['id', 'name', 'status', 'ms', 'type']);
    console.log();
    header('Recent Deploys');
    if (dash.recentDeploys.length === 0) { info('No deployments.'); return; }
    table(dash.recentDeploys.map((d) => ({ id: d.id, service: d.serviceName, status: d.status, time: fmtTime(d.createdAt) })), ['id', 'service', 'status', 'time']);
  });
}

/**
 * `ninedeploy system rotate-keys`
 *
 * The command `.env.example` has told operators to run since the key-ring
 * landed. It did not exist: `lib/keyRotation.rotateSecrets` was implemented and
 * tested but had no caller anywhere in the product, so anyone who followed the
 * documented rotation procedure and then dropped the retired key version was
 * left holding ciphertext they could no longer decrypt.
 */
export async function systemRotateKeys(client: NineDeployClient): Promise<void> {
  header('Rotate master key');
  const status = await spinner('Reading key ring', () => client.settings.masterKey.get());
  kv('Active version', c.bold(`v${status.activeVersion}`));
  kv('Ring', status.knownVersions.map((v) => `v${v}`).join(', '));
  if (!status.rotatable) {
    return error(
      'Only one key version is loaded — there is nothing to rotate onto. Add a new 32-byte key under a higher version in NINEDEPLOY_MASTER_KEYS, restart, then run this again.',
    );
  }
  const confirm = await prompt(`Re-encrypt every stored secret onto v${status.activeVersion}? (yes/no)`, 'no');
  if (confirm.toLowerCase() !== 'yes') return info('Aborted.');

  const res = await spinner('Re-encrypting', () => client.settings.masterKey.rotate());
  success(`${res.rotated} secret value(s) re-encrypted under v${res.activeVersion}.`);
  if (res.warning) {
    info(res.warning);
  } else {
    info('No stored backups reference an older key version — the retired key can be removed from NINEDEPLOY_MASTER_KEYS.');
  }
}
