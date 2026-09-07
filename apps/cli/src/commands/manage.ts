import type { NineDeployClient } from '../client.js';
import { c, error, fmtTime, header, info, spinner, success, table } from '../lib/format.js';
import { prompt } from '../prompts.js';

const num = (v: string, usage: string): number => {
  const n = Number(v);
  if (Number.isNaN(n)) {
    error(usage);
    // error() sets the exit code; throw so execution never continues with
    // NaN (and tests can observe the failure).
    throw new Error(usage);
  }
  return n;
};

const fail = (err: unknown): void => {
  error(err instanceof Error ? err.message : String(err));
};

// ── env ────────────────────────────────────────────────────────────────────

/** `ninedeploy env list <serviceId>` */
export async function envList(client: NineDeployClient, idStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy env list <serviceId>');
  header('Environment Variables');
  await spinner('Fetching', async () => {
    const vars = await client.env.list(id);
    if (vars.length === 0) { info('No env vars.'); return; }
    table(vars.map((v) => ({ id: v.id, key: v.key, secret: v.isSecret ? '•••' : 'plain', value: v.isSecret ? '—' : v.value })), ['id', 'key', 'secret', 'value']);
  });
}

/** `ninedeploy env set <serviceId> <key> <value> [--public]` */
export async function envSet(client: NineDeployClient, idStr: string, key: string, value: string, opts: { public?: boolean }): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy env set <serviceId> <key> <value>');
  if (!key || value === undefined) return error('Usage: ninedeploy env set <serviceId> <key> <value>');
  const input = { key, value, isSecret: !opts.public };
  try {
    const vars = await client.env.list(id);
    const existing = vars.find((v) => v.key === key);
    if (existing) {
      await client.env.update(id, existing.id, input);
    } else {
      await client.env.create(id, input);
    }
    success(`Set ${c.cyan(key)}${input.isSecret ? ' (secret)' : ''}.`);
  } catch (err) { fail(err); }
}

/** `ninedeploy env rm <serviceId> <key>` */
export async function envRemove(client: NineDeployClient, idStr: string, key: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy env rm <serviceId> <key>');
  if (!key) return error('Usage: ninedeploy env rm <serviceId> <key>');
  try {
    const vars = await client.env.list(id);
    const existing = vars.find((v) => v.key === key);
    if (!existing) return info(`No env var named "${key}".`);
    await client.env.remove(id, existing.id);
    success(`Removed ${c.cyan(key)}.`);
  } catch (err) { fail(err); }
}

// ── domains ────────────────────────────────────────────────────────────────

/** `ninedeploy domains list` */
export async function domainsList(client: NineDeployClient): Promise<void> {
  header('Domains');
  await spinner('Fetching', async () => {
    const rows = await client.domains.all();
    if (rows.length === 0) { info('No domains yet.'); return; }
    table(rows.map((d) => ({
      id: d.id,
      host: d.hostname,
      path: d.path,
      ssl: d.ssl ? '🔒' : '',
      cert: d.certExpiresAt ? `${Math.ceil((new Date(d.certExpiresAt).getTime() - Date.now()) / 86_400_000)}d` : '—',
      service: d.serviceName ?? '—',
    })), ['id', 'host', 'path', 'ssl', 'cert', 'service']);
  });
}

/** `ninedeploy domains add <serviceId> <host> [--path p] [--no-ssl]` */
export async function domainsAdd(client: NineDeployClient, idStr: string, host: string, opts: { path?: string; ssl?: boolean }): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy domains add <serviceId> <host>');
  if (!host) return error('Usage: ninedeploy domains add <serviceId> <host>');
  try {
    const d = await client.domains.create(id, { hostname: host, path: opts.path ?? '/', ssl: opts.ssl !== false });
    success(`Domain ${c.cyan(d.hostname)} added (id: ${d.id}).`);
  } catch (err) { fail(err); }
}

/** `ninedeploy domains rm <domainId>` */
export async function domainsRemove(client: NineDeployClient, idStr: string, domainIdStr: string): Promise<void> {
  const serviceId = num(idStr, 'Usage: ninedeploy domains rm <serviceId> <domainId>');
  const domainId = num(domainIdStr, 'Usage: ninedeploy domains rm <serviceId> <domainId>');
  try {
    await client.domains.remove(serviceId, domainId);
    success('Domain removed.');
  } catch (err) { fail(err); }
}

/**
 * `ninedeploy domains transfer <domainId> --to <email>` —
 * start a transfer. Prints the accept URL so the operator
 * can forward it to the target user out-of-band (email,
 * chat, etc.). The token in the URL is the only secret;
 * the database stores only its SHA-256.
 */
export async function domainsTransfer(
  client: NineDeployClient,
  domainIdStr: string,
  opts: { to: string },
): Promise<void> {
  const domainId = num(domainIdStr, 'Usage: ninedeploy domains transfer <domainId> --to <email>');
  if (!opts.to) return error('Usage: ninedeploy domains transfer <domainId> --to <email>');
  let res: Awaited<ReturnType<NineDeployClient['domains']['transfer']>>;
  try {
    res = await spinner('Starting transfer', () => client.domains.transfer(domainId, { targetEmail: opts.to }));
  } catch (err) { fail(err); return; }
  success(`Transfer started. Forward this URL to ${opts.to}:`);
  console.log();
  console.log(`  ${c.cyan(res.acceptUrl)}`);
  console.log();
  const expiresIn = Math.max(0, res.expiresAt - Math.floor(Date.now() / 1000));
  info(`Token expires in ${Math.ceil(expiresIn / 86400)} day(s). The target user accepts with`);
  info(`  ninedeploy domains accept-transfer <token> --service-id <id>`);
  info(`(the token is the last URL segment above).`);
}

/**
 * `ninedeploy domains preview-transfer <token>` — read-only
 * preview of a transfer. No auth required (the token is
 * the secret); used by the panel's accept page.
 */
export async function domainsPreviewTransfer(
  client: NineDeployClient,
  token: string,
): Promise<void> {
  if (!token) return error('Usage: ninedeploy domains preview-transfer <token>');
  let res: Awaited<ReturnType<NineDeployClient['domains']['previewTransfer']>>;
  try {
    res = await client.domains.previewTransfer(token);
  } catch (err) { fail(err); return; }
  if (res.status === 'expired' || res.effectivelyExpired) {
    header('Transfer (expired)');
    info(`This transfer expired and can no longer be accepted.`);
    info(`Source: ${res.sourceEmail} -> Target: ${res.targetEmail} (${res.hostname})`);
    return;
  }
  header(`Transfer (${res.status})`);
  info(`Domain:    ${c.cyan(res.hostname)}`);
  info(`From:      ${res.sourceEmail}`);
  info(`To:        ${res.targetEmail}`);
  info(`Status:    ${res.status}`);
  const expiresIn = Math.max(0, res.expiresAt - Math.floor(Date.now() / 1000));
  info(`Expires:   in ${Math.ceil(expiresIn / 86400)} day(s)`);
  if (res.acceptedAt) info(`Accepted:  ${new Date(res.acceptedAt * 1000).toISOString()}`);
  if (res.cancelledAt) info(`Cancelled: ${new Date(res.cancelledAt * 1000).toISOString()}`);
}

/**
 * `ninedeploy domains accept-transfer <token> --service-id <id>` —
 * accept a transfer as the target user. The CLI refuses if
 * the caller's panel email does not match the transfer's
 * `targetEmail`; the same check is enforced server-side.
 */
export async function domainsAcceptTransfer(
  client: NineDeployClient,
  token: string,
  opts: { serviceId: string },
): Promise<void> {
  if (!token) return error('Usage: ninedeploy domains accept-transfer <token> --service-id <id>');
  if (!opts.serviceId) return error('Usage: ninedeploy domains accept-transfer <token> --service-id <id>');
  const serviceId = num(opts.serviceId, 'Usage: ninedeploy domains accept-transfer <token> --service-id <id>');
  let res: Awaited<ReturnType<NineDeployClient['domains']['acceptTransfer']>>;
  try {
    res = await spinner('Accepting transfer', () =>
      client.domains.acceptTransfer(token, { targetServiceId: serviceId }),
    );
  } catch (err) { fail(err); return; }
  success(`Domain ${c.cyan(res.hostname)} transferred to service ${res.serviceId}.`);
}

/**
 * `ninedeploy domains cancel-transfer <token>` — cancel a
 * pending transfer. Only the source user (or an instance
 * operator) can cancel; the server enforces the same gate.
 */
export async function domainsCancelTransfer(
  client: NineDeployClient,
  token: string,
): Promise<void> {
  if (!token) return error('Usage: ninedeploy domains cancel-transfer <token>');
  try {
    await client.domains.cancelTransfer(token);
    success('Transfer cancelled.');
  } catch (err) { fail(err); }
}

// ── volumes ────────────────────────────────────────────────────────────────

/** `ninedeploy volumes list` */
export async function volumesList(client: NineDeployClient): Promise<void> {
  header('Volumes');
  await spinner('Fetching', async () => {
    const rows = await client.volumes.list();
    if (rows.length === 0) { info('No volumes.'); return; }
    table(rows.map((v) => ({ name: v.name, owner: v.owner ? `${v.owner.kind}: ${v.owner.name}` : '—', size: v.sizeBytes })), ['name', 'owner', 'size']);
  });
}

/** `ninedeploy volumes rm <name>` */
export async function volumesRemove(client: NineDeployClient, name: string): Promise<void> {
  if (!name) return error('Usage: ninedeploy volumes rm <name>');
  const confirm = await prompt(`Type the volume name (${name}) to confirm deletion`);
  if (confirm !== name) return error('Cancelled.');
  try {
    await spinner('Removing volume', () => client.volumes.remove(name));
    success(`Volume ${c.cyan(name)} removed.`);
  } catch (err) { fail(err); }
}

// ── networks ───────────────────────────────────────────────────────────────

/** `ninedeploy networks list` */
export async function networksList(client: NineDeployClient): Promise<void> {
  header('Docker Networks');
  await spinner('Fetching', async () => {
    const { networks } = await client.networks.list();
    if (networks.length === 0) { info('No user-defined networks.'); return; }
    table(networks.map((n) => ({ name: n.name, driver: n.driver, members: n.members.join(', ') || '—' })), ['name', 'driver', 'members']);
  });
}

/** `ninedeploy networks create <name> [driver]` */
export async function networksCreate(client: NineDeployClient, name: string, driver: 'bridge' | 'overlay'): Promise<void> {
  try {
    await spinner('Creating network', () => client.networks.create({ name, driver }));
    success(`Network ${c.cyan(name)} created.`);
  } catch (err) { fail(err); }
}

/** `ninedeploy networks rm <name>` */
export async function networksRemove(client: NineDeployClient, name: string): Promise<void> {
  if (!name) return error('Usage: ninedeploy networks rm <name>');
  const confirm = await prompt(`Type the network name (${name}) to confirm deletion`);
  if (confirm !== name) return error('Cancelled.');
  try {
    await spinner('Removing network', () => client.networks.remove(name));
    success(`Network ${c.cyan(name)} removed.`);
  } catch (err) { fail(err); }
}

// ── sessions ───────────────────────────────────────────────────────────────

/** `ninedeploy sessions list` */
export async function sessionsList(client: NineDeployClient): Promise<void> {
  header('Active Sessions');
  await spinner('Fetching', async () => {
    const rows = await client.auth.sessions.list();
    if (rows.length === 0) { info('No active sessions.'); return; }
    table(rows.map((s) => ({
      id: s.id,
      current: s.current ? 'yes' : '',
      ip: s.ip ?? '—',
      lastUsed: s.lastUsedAt ?? s.createdAt,
      userAgent: (s.userAgent ?? '—').slice(0, 60),
    })), ['id', 'current', 'ip', 'lastUsed', 'userAgent']);
  });
}

/** `ninedeploy sessions revoke <id>` */
export async function sessionsRevoke(client: NineDeployClient, idStr: string): Promise<void> {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) return error('Usage: ninedeploy sessions revoke <id>');
  try {
    await spinner('Revoking session', () => client.auth.sessions.revoke(id));
    success(`Session #${id} revoked.`);
  } catch (err) { fail(err); }
}

// ── backups ────────────────────────────────────────────────────────────────

/** Human label for a backup row: prefer the database name, fall back to its id. */
function backupDbLabel(b: { databaseName?: string; databaseId?: number | null }): string {
  if (b.databaseName) return b.databaseName;
  if (b.databaseId != null) return String(b.databaseId);
  return '—';
}

/** `ninedeploy backups list [databaseId]` */
export async function backupsList(client: NineDeployClient, idStr?: string): Promise<void> {
  header('Backups');
  const fetchRows = () => (idStr ? client.backups.listForDb(Number(idStr)) : client.backups.list());
  await spinner('Fetching', async () => {
    const rows = await fetchRows();
    if (rows.length === 0) { info('No backups.'); return; }
    table(rows.map((b) => ({ id: b.id, db: backupDbLabel(b), status: b.status, size: b.sizeBytes, created: fmtTime(b.createdAt) })), ['id', 'db', 'status', 'size', 'created']);
  });
}

/** `ninedeploy backups create <databaseId>` */
export async function backupsCreate(client: NineDeployClient, idStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy backups create <databaseId>');
  try {
    const b = await spinner('Backing up', () => client.backups.backupNow(id));
    success(`Backup #${b.id} ${b.status}.`);
  } catch (err) { fail(err); }
}

/** `ninedeploy backups restore <databaseId> <backupId>` */
export async function backupsRestore(client: NineDeployClient, idStr: string, backupIdStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy backups restore <databaseId> <backupId>');
  const backupId = num(backupIdStr, 'Usage: ninedeploy backups restore <databaseId> <backupId>');
  const confirm = await prompt('Restore OVERWRITES the database. Type "yes" to continue');
  if (confirm.toLowerCase() !== 'yes') return error('Cancelled.');
  try {
    await spinner('Restoring', () => client.backups.restore(id, backupId));
    success(`Backup #${backupId} restored.`);
  } catch (err) { fail(err); }
}

/**
 * `ninedeploy backups drill <databaseId> <backupId>` — prove a
 * backup is at least restorable without overwriting the live
 * database. The drill is an engine-specific smoke check
 * (pg_restore --list, redis-check-rdb, mysqldump header parse,
 * ...) and is safe to run on production backups because it
 * never touches the live container.
 */
export async function backupsDrill(client: NineDeployClient, idStr: string, backupIdStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy backups drill <databaseId> <backupId>');
  const backupId = num(backupIdStr, 'Usage: ninedeploy backups drill <databaseId> <backupId>');
  let result: Awaited<ReturnType<NineDeployClient['databases']['drillBackup']>>;
  try {
    result = await spinner('Drilling', () => client.databases.drillBackup(id, { backupId }));
  } catch (err) { fail(err); return; }
  if (result.status === 'passed') {
    success(`Backup #${backupId} passed the drill in ${result.durationMs} ms.`);
  } else {
    error(`Backup #${backupId} FAILED the drill: ${result.error ?? 'unknown reason'}`);
  }
  if (result.details) {
    for (const [k, v] of Object.entries(result.details)) {
      console.log(`  ${c.dim(`${k}:`)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

/**
 * `ninedeploy backups drills <databaseId>` — list the most
 * recent drill results for a database, newest first.
 */
export async function backupsDrills(client: NineDeployClient, idStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy backups drills <databaseId>');
  const rows = await client.databases.drills(id);
  if (rows.length === 0) {
    info('No drills yet.');
    return;
  }
  table(
    rows.map((r) => ({
      id: r.id,
      backup: r.backupId,
      engine: r.engine,
      status: r.status,
      durationMs: r.durationMs,
      // The server serializes startedAt as epoch milliseconds (Date.getTime());
      // scale defensively so a seconds-precision value still renders correctly.
      started: fmtTime(new Date(r.startedAt < 1e12 ? r.startedAt * 1000 : r.startedAt).toISOString()),
      error: r.error ?? '',
    })),
    ['id', 'backup', 'engine', 'status', 'durationMs', 'started', 'error'],
  );
}

// ── alerts ─────────────────────────────────────────────────────────────────

/** `ninedeploy alerts list` */
export async function alertsList(client: NineDeployClient): Promise<void> {
  header('Alert Rules');
  await spinner('Fetching', async () => {
    const rules = await client.alerts.list();
    if (rules.length === 0) { info('No alert rules.'); return; }
    table(rules.map((r) => ({
      id: r.id,
      name: r.name,
      rule: `${r.metric} ${r.operator} ${r.threshold}`,
      status: r.status,
      current: r.lastValue ?? '—',
      enabled: r.enabled ? '✓' : '',
    })), ['id', 'name', 'rule', 'status', 'current', 'enabled']);
  });
}

/** `ninedeploy alerts create <name> <metric> <operator> <threshold> [--windows n] [--service id]` */
export async function alertsCreate(client: NineDeployClient, name: string, metric: string, operator: string, thresholdStr: string, opts: { windows?: string; service?: string }): Promise<void> {
  if (!name || !metric || !operator || !thresholdStr) {
    return error('Usage: ninedeploy alerts create <name> <cpu|memory|cert-expiry> <|<> <threshold>');
  }
  const threshold = Number(thresholdStr);
  if (!threshold) return error('Threshold must be a number.');
  try {
    const rule = await client.alerts.create({
      name,
      metric: metric as 'cpu' | 'memory' | 'cert-expiry',
      operator: operator as '>' | '<',
      threshold,
      serviceId: opts.service ? Number(opts.service) : null,
      durationWindows: opts.windows ? Number(opts.windows) : undefined,
    });
    success(`Alert "${rule.name}" created (id: ${rule.id}).`);
  } catch (err) { fail(err); }
}

/** `ninedeploy alerts rm <id>` */
export async function alertsRemove(client: NineDeployClient, idStr: string): Promise<void> {
  const id = num(idStr, 'Usage: ninedeploy alerts rm <id>');
  try {
    await client.alerts.remove(id);
    success(`Alert #${id} removed.`);
  } catch (err) { fail(err); }
}

// ── users & activity ───────────────────────────────────────────────────────

/** `ninedeploy users list` */
export async function usersList(client: NineDeployClient): Promise<void> {
  header('Users');
  await spinner('Fetching', async () => {
    const users = await client.users.list();
    if (users.length === 0) { info('No users.'); return; }
    table(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name ?? '—',
        role: u.isOperator ? 'operator' : 'member',
        workspaces: u.workspaceCount,
      })),
      ['id', 'email', 'name', 'role', 'workspaces'],
    );
  });
}

/** `ninedeploy users reset-link <id|email>` — mint a one-time reset link. */
export async function usersResetLink(client: NineDeployClient, who: string): Promise<void> {
  header('Password reset link');
  try {
    const link = await spinner('Resolving user', async () => {
      const users = await client.users.list();
      const target = users.find((u) => String(u.id) === who || u.email === who);
      if (!target) throw new Error(`No user matches "${who}"`);
      return client.users.resetLink(target.id);
    });
    success('One-time reset link (copy it now — shown once):');
    console.log(`  ${c.cyan(link.url)}`);
    info(`Expires ${new Date(link.expiresAt).toLocaleString()}`);
  } catch (err) { fail(err); }
}

/** `ninedeploy activity list` */
export async function activityList(client: NineDeployClient): Promise<void> {
  header('Activity');
  await spinner('Fetching', async () => {
    const { entries } = await client.activity.list();
    if (entries.length === 0) { info('No activity yet.'); return; }
    table(entries.slice(0, 30).map((a) => ({ id: a.id, action: a.action, entity: a.entity ?? '—', time: fmtTime(a.ts) })), ['id', 'action', 'entity', 'time']);
  });
}

// ── system export / import ─────────────────────────────────────────────────

/** `ninedeploy system export [file]` — downloads the full system bundle. */
export async function systemExport(file?: string): Promise<void> {
  const { writeFileSync } = await import('node:fs');
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig();
  const filename = file ?? `ninedeploy-export-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const data = await spinner('Exporting system', async () => {
      const res = await fetch(`${cfg.baseUrl}/v1/system/export`, {
        headers: { Authorization: `Bearer ${cfg.token ?? ''}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      return res.text();
    });
    writeFileSync(filename, data);
    success(`Exported to ${filename}`);
  } catch (err) { fail(err); }
}

/** `ninedeploy deploys watch <serviceId> <deployId>` — stream deploy logs over WebSocket. */
export async function deploysWatch(serviceIdStr: string, deployIdStr: string, timeoutMs = 30 * 60_000): Promise<void> {
  const serviceId = Number(serviceIdStr);
  const deployId = Number(deployIdStr);
  if (!serviceId || !deployId) return error('Usage: ninedeploy deploys watch <serviceId> <deployId>');
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig();
  const { WebSocket } = await import('ws');
  const url = new URL(`/v1/services/${serviceId}/deploys/${deployId}/logs`, cfg.baseUrl.replace(/^http/, 'ws'));
  // L-3: the token travels as a WebSocket subprotocol, not `?token=`. A query
  // string lands in Traefik's access log (`accessLog: {}` is on by default)
  // and in any intermediate proxy's log; a subprotocol is a header.
  const ws = new WebSocket(url, [`ninedeploy.bearer.${cfg.token ?? ''}`]);
  let closed = false;
  ws.on('message', (data) => process.stdout.write(String(data)));
  ws.on('close', () => {
    closed = true;
    info('Log stream closed.');
  });
  // `close` normally follows `error`, but `unexpected-response` (handshake
  // rejection) never reaches the close event on some ws versions — flag the
  // loop here too or it spins to the hard cap printing nothing.
  ws.on('error', (err: Error) => {
    closed = true;
    error(`Stream error: ${err.message}`);
  });
  ws.on('unexpected-response', (_req, res) => {
    closed = true;
    error(`Stream rejected (${res.statusCode}).`);
  });
  // Exit when the server closes the stream (deploy finished) or on Ctrl-C.
  process.on('SIGINT', () => {
    closed = true;
    ws.close();
    process.exitCode = 0;
  });
  // Hard cap so a stuck stream can never hang the CLI forever.
  const deadline = Date.now() + timeoutMs;
  while (!closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!closed) ws.close();
}

/** `ninedeploy system import <file>` — restores a system bundle (destructive). */
export async function systemImport(file: string): Promise<void> {
  if (!file) return error('Usage: ninedeploy system import <file>');
  const { readFileSync } = await import('node:fs');
  const { loadConfig } = await import('../config.js');
  const cfg = loadConfig();
  const confirm = await prompt('Import OVERWRITES the current system state. Type "yes" to continue');
  if (confirm.toLowerCase() !== 'yes') return error('Cancelled.');
  try {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(file)]), file);
    const res = await spinner('Importing system', () =>
      fetch(`${cfg.baseUrl}/v1/system/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token ?? ''}` },
        body: form,
      }),
    );
    if (!res.ok) throw new Error(`Import failed (${res.status})`);
    success('System imported.');
  } catch (err) { fail(err); }
}
