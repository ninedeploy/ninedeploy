import { and, eq } from 'drizzle-orm';
import {
  alertRules,
  databases,
  databaseAttachments,
  domains,
  scheduledJobs,
  serviceNotificationChannels,
  services,
  webhooks,
  type DB,
} from '@ninedeploy/db';
import type { NinedeployManifest, Notifications, Previews, Route, Watch } from '@ninedeploy/schemas';
import { Cron } from 'croner';
import { ensureAlertState } from './alerting.js';
import { databaseRole, isOperator, roleAtLeast } from './resourceAccess.js';
import {
  companionOutsideProof,
  hostsCollide,
  newChallengeToken,
  ownZoneClaimRefusal,
  requiresOwnershipProof,
  wwwCompanionHost,
} from './domainVerification.js';
import { domainCapRefusal, getDomainPolicy } from './domainPolicy.js';
import { getSettingString } from './settings.js';
import { previewPatternError } from './previewDomain.js';

/**
 * Apply a `.ninedeploy` manifest's operational sections onto an existing
 * service. Called once per deploy (after a successful build) so the
 * side-effects stay in sync with the repo: re-running the deploy refreshes
 * routes, alerts and the managed-DB attachment to whatever the manifest
 * declares today.
 *
 * Everything here is **idempotent** — re-running an unchanged manifest
 * produces the same DB state. Domains are matched by (hostname, path),
 * alert rules by their generated `name`, and database attachments by the
 * unique (serviceId, databaseId) index. No new rows are created on a
 * no-op run.
 *
 * Six sections are fully wired here (routes, database, alerts, previews,
 * notifications, volume backups); the build-shaping ones are applied by
 * `engine/pipeline.ts` instead. Three are *recognised but not wired* —
 * `static`, `watch` and `network` — because the underlying platform feature is
 * either a panel/operator setting or does not exist yet. Every one of them
 * pushes a warning so the operator sees in the deploy log that the section was
 * read and had no effect; a section that is accepted by the schema and then
 * silently dropped is the failure mode this list exists to prevent.
 */

export interface ApplyManifestResult {
  routesUpserted: number;
  routesRemoved: number;
  databaseAttached: boolean;
  databaseNotFound: string | null;
  /** Set when a `database.ref` was found but the deploying service's owner
   * may not attach it (r650: `admin` on the database, as in the panel). */
  databaseAccessDenied: string | null;
  alertsUpserted: number;
  /** True when a `previews` section was applied onto the service row. */
  previewsApplied: boolean;
  /** Per-scope notification subscriptions written by the `notifications` section. */
  notificationsSynced: number;
  /** Cron of the manifest-owned volume-backup job, when a `volume.backups` section was applied. */
  volumeBackupSchedule: string | null;
  /** Number of webhooks whose watch paths were updated by the `watch` section. */
  watchPathsSynced: number;
  warnings: string[];
}

export async function applyManifestToService(
  db: DB,
  serviceId: number,
  manifest: NinedeployManifest,
  ownerUserId?: number | null,
): Promise<ApplyManifestResult> {
  const result: ApplyManifestResult = {
    routesUpserted: 0,
    routesRemoved: 0,
    databaseAttached: false,
    databaseNotFound: null,
    databaseAccessDenied: null,
    alertsUpserted: 0,
    previewsApplied: false,
    notificationsSynced: 0,
    volumeBackupSchedule: null,
    watchPathsSynced: 0,
    warnings: [],
  };

  // Read here rather than taken from the caller so no call site can forget
  // it: a PR preview runs code from a branch anyone with push access wrote.
  const target = await db.query.services.findFirst({
    where: eq(services.id, serviceId),
    columns: { isEphemeralPreview: true, memLimitMb: true },
  });
  const ownerIsOperator = ownerUserId ? await isOperator(db, { id: ownerUserId }) : false;

  await syncRoutes(db, serviceId, manifest.routes, result);
  if (manifest.database && target?.isEphemeralPreview) {
    // r651: the manifest a PR preview deploys comes from the PR's branch, and
    // its `database:` section names production's database — re-attaching it
    // handed every preview the production connection string and password.
    // Previews never get a manifest-driven attachment.
    result.warnings.push(
      `database.ref="${manifest.database.ref}": not applied to a PR preview — a preview never receives a manifest-attached database, because that is production's. Attach a separate (non-production) database to the preview under Service → Databases if it needs one.`,
    );
  } else {
    await attachManagedDatabase(db, serviceId, ownerUserId ?? null, ownerIsOperator, manifest.database, result);
  }
  // F128: the memory limit the container actually runs with — the panel's
  // value, else the manifest's `resources.memMb` (engine/pipeline.ts applies
  // the same panel > manifest precedence). 0 = unlimited.
  const memLimitMb = target?.memLimitMb || manifest.resources?.memMb || 0;
  await syncAlertRules(db, serviceId, manifest.alerts, memLimitMb, result);
  await applyPreviewConfig(db, serviceId, manifest.previews, result);
  if (manifest.notifications) {
    await syncNotificationSubscriptions(db, serviceId, ownerIsOperator, manifest.notifications, result);
  }
  if (manifest.watch) {
    await syncWatchPaths(db, serviceId, manifest.watch, result);
  }

  // Recognised-but-not-wired sections: surface so the build log records the
  // operator's intent without silently dropping the configuration.
  if (manifest.volume?.backups) {
    await wireVolumeBackupSchedule(db, serviceId, manifest.volume.backups, result);
  }
  // `static`, `watch` and `network` are accepted by the schema (a `.strict()`
  // object would otherwise reject a manifest that uses them) and consumed by
  // nothing. They were the only unwired sections that stayed completely silent,
  // so a repo declaring `static.spa: true` or a `watch` path filter got no hint
  // that the setting had no effect at all.
  // `static` and `watch` are now wired (see applyPreviewConfig / syncWatchPaths);
  // only `network` and `static` remain panel-side (Networks / Service → Settings).
  if (manifest.static) {
    result.warnings.push(
      'static: declared but static-site serving is configured in the panel (Service → Settings), not from the manifest; section ignored.',
    );
  }
  if (manifest.network) {
    result.warnings.push(
      'network: declared but container network attachment is a panel/operator setting (Networks); section ignored.',
    );
  }

  return result;
}

// ── Watch paths ───────────────────────────────────────────────────────────

/**
 * Apply the manifest's `watch` section: set the watch-path filter on every
 * active webhook for this service. The paths are joined with newlines to
 * match the webhook's storage format. Only webhooks owned by this service
 * are updated — webhooks on other services are untouched.
 */
async function syncWatchPaths(
  db: DB,
  serviceId: number,
  watch: Watch,
  result: ApplyManifestResult,
): Promise<void> {
  // An empty or absent paths list is a no-op — the manifest didn't declare
  // any watch paths, so don't clear the webhook's existing filter.
  if (watch.paths.length === 0) return;
  const joined = watch.paths.join('\n');
  const hooks = await db.query.webhooks.findMany({
    where: and(eq(webhooks.serviceId, serviceId), eq(webhooks.active, true)),
  });
  for (const hook of hooks) {
    if (hook.watchPaths === joined) continue;
    await db
      .update(webhooks)
      .set({ watchPaths: joined })
      .where(eq(webhooks.id, hook.id));
    result.watchPathsSynced++;
  }
}

// ── Previews ──────────────────────────────────────────────────────────────

/**
 * Apply the manifest's `previews` section onto the service row — the same
 * columns the panel's preview-settings UI writes. Declaring the section at
 * all (even `enabled: false`) is the operator's intent, so every present
 * field is applied; a section the panel later edits stays until the next
 * deploy of a repo still carrying the section.
 *
 * r602: a CHANGED `pattern` is held to the same rule as the services
 * create/PATCH routes (r511, `previewPatternError`) — it was stored
 * unvalidated and only the webhook caught it, one PR later. An invalid
 * pattern does not fail the deploy: that one field is skipped (the stored
 * pattern stays), the rest of the section applies, and the reason lands in
 * the deploy log. Re-applying an already-stored invalid pattern is a silent
 * no-op (like re-sending it through PATCH), so a legacy pattern does not warn
 * on every deploy; the webhook still refuses to provision from it.
 *
 * The manifest schema documents (and, when enabled, requires) `{n}` as the
 * PR-number placeholder, while the renderer only knows `{{pr}}` — so a
 * manifest pattern was stored in a dialect nothing substituted. `{n}` is
 * normalised to `{{pr}}` here, which makes `pr-{n}-{{slug}}.{{domain}}` a
 * pattern that satisfies both the schema and the r511 rule.
 */
async function applyPreviewConfig(
  db: DB,
  serviceId: number,
  previews: Previews | undefined,
  result: ApplyManifestResult,
): Promise<void> {
  if (!previews) return;
  const pattern = previews.pattern ? previews.pattern.replace(/\{n\}/g, '{{pr}}') : null;
  const patch: Partial<typeof services.$inferInsert> = {
    previewDeploymentsEnabled: previews.enabled,
    previewDomainPattern: pattern,
    previewMaxActive: previews.maxActive,
    previewAutoDestroyOnClose: previews.autoDestroyOnClose,
  };
  if (pattern) {
    const svc = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
    const error = svc ? previewPatternError(pattern, svc.slug) : null;
    // Already stored (either dialect): left as it is, without a warning.
    const unchanged = svc?.previewDomainPattern === pattern || svc?.previewDomainPattern === previews.pattern;
    if (error) delete patch.previewDomainPattern;
    if (error && !unchanged) {
      result.warnings.push(
        `previews.pattern ${JSON.stringify(previews.pattern)} not applied: ${error} (in .ninedeploy the PR number is ` +
          `written {n}, e.g. pr-{n}-{{slug}}.{{domain}}). The stored pattern is unchanged.`,
      );
    }
  }
  await db.update(services).set(patch).where(eq(services.id, serviceId));
  result.previewsApplied = true;
}

// ── Notifications ─────────────────────────────────────────────────────────

const SCOPE_OF = { onDeploy: 'deploy', onFailure: 'failure', onAlert: 'alert' } as const;

/**
 * Apply the manifest's `notifications` section: resolve channel NAMES into
 * per-service subscriptions that add this service's events to those
 * channels. Semantics per scope key present in the manifest:
 *  - the scope's rule set is REPLACED by the declared names (a deploy of a
 *    repo still carrying the section is the source of truth);
 *  - a scope key that is absent is left untouched (same conservatism as
 *    routes — the manifest must not be able to silently unsubscribe things
 *    the operator set up in the panel by omitting a line);
 *  - a name that matches no channel pushes a warning; the other names in
 *    the same list still apply.
 *
 * Delivery stays ADDITIVE to the channel's own global eventFilter — rules
 * only ever ADD this service's events to a channel, never remove anything.
 *
 * r652: honoured only when the service's owner is an instance operator.
 * Channels are operator-only configuration (modules/notifications.ts), and a
 * rule bypasses the channel's own eventFilter — so a member's repository could
 * route its service's events into the operator's pager, and the "not found"
 * warning let it probe which channel names exist. For any other owner the
 * section is ignored WITHOUT resolving a single name, and subscriptions an
 * earlier manifest run wrote for the service are removed (nothing but the
 * manifest ever writes them). `notifyEvent` applies the same rule at delivery.
 */
async function syncNotificationSubscriptions(
  db: DB,
  serviceId: number,
  ownerIsOperator: boolean,
  notifications: Notifications,
  result: ApplyManifestResult,
): Promise<void> {
  if (!ownerIsOperator) {
    const removed = await db
      .delete(serviceNotificationChannels)
      .where(eq(serviceNotificationChannels.serviceId, serviceId))
      .returning({ id: serviceNotificationChannels.id });
    result.warnings.push(
      `notifications: ignored — manifest notification subscriptions apply only to services owned by an instance operator, because notification channels are operator configuration${removed.length > 0 ? ` (${removed.length} subscription(s) an earlier deploy created were removed)` : ''}. Ask an operator to include this service's events in a channel's event filter (Settings → Notifications).`,
    );
    return;
  }
  const allChannels = await db.query.notificationChannels.findMany();
  const byName = new Map(allChannels.map((c) => [c.name, c]));

  for (const key of Object.keys(SCOPE_OF) as Array<keyof typeof SCOPE_OF>) {
    const names = notifications[key];
    if (!names || names.length === 0) continue;
    const scope = SCOPE_OF[key];

    const unresolved: string[] = [];
    const wanted = new Set<number>();
    for (const name of new Set(names)) {
      const channel = byName.get(name);
      if (!channel) {
        unresolved.push(name);
        continue;
      }
      wanted.add(channel.id);
    }
    if (unresolved.length > 0) {
      result.warnings.push(
        `notifications.${key}: channel(s) [${unresolved.join(', ')}] not found — those subscriptions were skipped.`,
      );
    }

    // Replace this scope's rules with the manifest's set, diffing against
    // the existing rows so an unchanged manifest is a no-op.
    const existing = await db
      .select()
      .from(serviceNotificationChannels)
      .where(
        and(
          eq(serviceNotificationChannels.serviceId, serviceId),
          eq(serviceNotificationChannels.scope, scope),
        ),
      );
    for (const row of existing) {
      if (wanted.has(row.channelId)) {
        wanted.delete(row.channelId); // already in place
      } else {
        await db.delete(serviceNotificationChannels).where(eq(serviceNotificationChannels.id, row.id));
      }
    }
    for (const channelId of wanted) {
      await db
        .insert(serviceNotificationChannels)
        .values({ serviceId, channelId, scope })
        .onConflictDoNothing();
      result.notificationsSynced++;
    }
  }
}

// ── Volume backups ────────────────────────────────────────────────────────

/** The manifest owns exactly this job name and never the operator's own. */
export const MANIFEST_BACKUP_JOB_NAME = 'volume-backups (manifest)';

/**
 * Apply the manifest's `volume.backups` section: the declared cron becomes
 * the service's `kind: 'backup'` scheduled job under a manifest-owned name,
 * so a repo can carry its own volume-backup cadence without the operator
 * rebuilding it in the panel. The job scheduler re-arms within its regular
 * 5-minute reload, so the schedule is live without a restart.
 *
 * The declared retention is noted but not applied: pruning today is the
 * instance-wide `volumeBackupRetainCount`, and a per-service override needs
 * its own column on the prune path — surfaced as a warning instead of being
 * silently dropped.
 */
async function wireVolumeBackupSchedule(
  db: DB,
  serviceId: number,
  backups: { schedule: string; retention: number },
  result: ApplyManifestResult,
): Promise<void> {
  let cron: string | null = null;
  try {
    // Validate BEFORE writing: the job scheduler only logs invalid cron
    // expressions at arm time, which would look like a silently dead backup.
    new Cron(backups.schedule);
    cron = backups.schedule;
  } catch {
    result.warnings.push(
      `volume.backups: schedule="${backups.schedule}" is not a valid cron expression — no backup job was created or changed.`,
    );
    return;
  }

  const [existing] = await db
    .select()
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.serviceId, serviceId), eq(scheduledJobs.name, MANIFEST_BACKUP_JOB_NAME)));
  if (existing) {
    await db
      .update(scheduledJobs)
      .set({ cron, kind: 'backup', enabled: true, updatedAt: new Date() })
      .where(eq(scheduledJobs.id, existing.id));
  } else {
    await db
      .insert(scheduledJobs)
      .values({ serviceId, name: MANIFEST_BACKUP_JOB_NAME, cron, kind: 'backup', enabled: true });
  }
  result.volumeBackupSchedule = cron;
  result.warnings.push(
    `volume.backups: scheduled (${cron}); retention stays the instance-wide keep-count — the declared retention=${backups.retention} is not applied per-service yet.`,
  );
}

// ── Routes (domains) ─────────────────────────────────────────────────────

/**
 * Why a manifest may not claim `hostname` for `serviceId`, or null when it
 * may. A manifest push carries no user identity to check against, so any
 * colliding route owned by ANOTHER service refuses it.
 */
async function manifestRouteRefusal(db: DB, serviceId: number, hostname: string): Promise<string | null> {
  let panelDomain: string | null = process.env['NINEDEPLOY_DOMAIN'] ?? null;
  try {
    panelDomain = (await getSettingString(db, 'panel_domain', null)) ?? panelDomain;
  } catch {
    /* settings table unavailable — fall back to the env */
  }
  if (panelDomain && hostsCollide(hostname, panelDomain)) return 'is reserved for the NineDeploy panel';
  // r223: a manifest carries no user identity, so it gets the non-operator rules.
  const zoneRefusal = await ownZoneClaimRefusal(db, serviceId, hostname);
  if (zoneRefusal) return zoneRefusal;
  const rows = await db.select({ hostname: domains.hostname, serviceId: domains.serviceId }).from(domains);
  const holder = rows.find((r) => r.serviceId !== serviceId && hostsCollide(r.hostname, hostname));
  return holder ? `is already routed by service #${holder.serviceId}` : null;
}

/**
 * r633: why a manifest route may not turn its www redirect ON, or null. The
 * redirect routes the companion host too, so the companion needs the same
 * claim rules as the route's own host — and an apex outside the route's DNS
 * proof can only be proved from the panel (verify / PATCH), never by a push.
 */
async function manifestCompanionRefusal(db: DB, serviceId: number, hostname: string): Promise<string | null> {
  const companion = wwwCompanionHost(hostname);
  if (!companion) return null;
  const refusal = await manifestRouteRefusal(db, serviceId, companion);
  if (refusal) return `its companion ${companion} ${refusal}`;
  const outside = companionOutsideProof(hostname);
  if (outside && requiresOwnershipProof(outside, false)) {
    return `its companion ${outside} needs DNS proof — turn the redirect on from the panel, which verifies it`;
  }
  return null;
}

async function syncRoutes(
  db: DB,
  serviceId: number,
  routes: readonly Route[] | undefined,
  result: ApplyManifestResult,
): Promise<void> {
  const existing = await db
    .select()
    .from(domains)
    .where(eq(domains.serviceId, serviceId));

  if (!routes || routes.length === 0) {
    // No routes declared → leave existing domains alone. Removing routes
    // through the manifest would be too aggressive (the operator might be
    // editing a working draft) — they can use the panel for explicit deletes.
    return;
  }

  // Rows this run created, keyed by (hostname, path). `existing` is a snapshot
  // taken before the loop, so it cannot see them — and `domains` enforces
  // (hostname, path) uniqueness GLOBALLY (`domains_host_path_idx`), not per
  // service. Without this, a manifest listing the same route twice
  // blind-INSERTs into that index and the deploy dies on a raw UNIQUE error.
  const created = new Map<string, { id: number }>();
  const policy = await getDomainPolicy(db);

  for (const route of routes) {
    const hostname = route.host.toLowerCase();
    const path = route.path;
    const headers = route.headers ? JSON.stringify(toHeaderRows(route.headers)) : null;
    const ipAllowlist = route.ipAllowlist ? route.ipAllowlist.join(', ') : null;
    const rateAverage = route.rateLimit?.average ?? null;
    const rateBurst = route.rateLimit?.burst ?? null;

    const key = `${hostname}|${path}`;
    const match = existing.find((d) => d.hostname === hostname && d.path === path) ?? created.get(key);
    // r633: only the off→on transition is checked, so a redirect that already
    // routes keeps working on every later push.
    let redirectWww = route.redirectWww ?? false;
    const wasRedirecting = match ? existing.find((d) => d.id === match.id)?.redirectWww === true : false;
    if (redirectWww && !wasRedirecting) {
      const companionRefusal = await manifestCompanionRefusal(db, serviceId, hostname);
      if (companionRefusal) {
        result.warnings.push(`routes: ${hostname}${path} redirectWww ignored — ${companionRefusal}.`);
        redirectWww = false;
      }
    }
    if (match) {
      await db
        .update(domains)
        .set({
          ssl: route.ssl,
          redirectWww,
          headers,
          ipAllowlist,
          rateLimitAverage: rateAverage,
          rateLimitBurst: rateBurst,
          // We do NOT change verificationToken / verifiedAt / status here —
          // DNS verification is the panel's job, not the manifest's.
          updatedAt: new Date(),
        })
        .where(eq(domains.id, match.id));
    } else {
      // The uniqueness is global: a (hostname, path) another service already
      // registered is claimed. Skip it with a warning — the same graceful
      // refusal `assertHostnameClaimable` gives the panel flow — instead of
      // crashing the deploy on the raw UNIQUE constraint.
      // r190: the same claim rules as POST /domains. Only the exact
      // (hostname, path) pair used to be checked, so a manifest could stack a
      // longer-rule router on another service's host (Traefik ranks by rule
      // length) or sit on the panel's own hostname.
      const refusal = await manifestRouteRefusal(db, serviceId, hostname);
      if (refusal) {
        result.warnings.push(`routes: ${hostname}${path} ${refusal}; manifest route skipped.`);
        continue;
      }
      // r634: the same per-service own-zone cap as POST /domains — a manifest
      // listing dozens of proof-free names is the same ACME drain.
      const cap = await domainCapRefusal(db, policy, serviceId, hostname, null);
      if (cap) {
        result.warnings.push(`routes: ${hostname}${path} skipped — ${cap.message}`);
        continue;
      }
      // Newly declared route. Inside the instance's own zone it goes live at
      // once; anything else needs the DNS ownership proof, so it is `pending`
      // WITH a challenge token the owner can complete from the panel. r190:
      // the token used to be null — POST /verify refused ("no pending
      // challenge"), so such a route could never go live, yet the row still
      // blocked the hostname for its real owner.
      const needsProof = requiresOwnershipProof(hostname, false);
      const [createdRow] = await db
        .insert(domains)
        .values({
          serviceId,
          hostname,
          path,
          ssl: route.ssl,
          redirectWww,
          headers,
          ipAllowlist,
          rateLimitAverage: rateAverage,
          rateLimitBurst: rateBurst,
          basicAuth: null,
          status: needsProof ? 'pending' : 'active',
          verificationToken: needsProof ? newChallengeToken() : null,
          verifiedAt: needsProof ? null : new Date(),
          dnsRecordId: null,
        })
        .returning({ id: domains.id });
      if (createdRow) created.set(key, createdRow);
    }
    result.routesUpserted += 1;
  }
}

function toHeaderRows(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

// ── Managed database attachment ──────────────────────────────────────────

async function attachManagedDatabase(
  db: DB,
  serviceId: number,
  ownerUserId: number | null,
  ownerIsOperator: boolean,
  ref: NinedeployManifest['database'],
  result: ApplyManifestResult,
): Promise<void> {
  if (!ref) return;
  const dbRows = await db
    .select()
    .from(databases)
    .where(eq(databases.slug, ref.ref))
    .limit(1);
  const dbRow = dbRows[0];
  if (!dbRow) {
    result.databaseNotFound = ref.ref;
    result.warnings.push(
      `database.ref="${ref.ref}" does not match any managed database; attach skipped.`,
    );
    return;
  }
  // Authorization: the manifest comes from the repository, so anyone with
  // push access could name ANY managed database by its deterministic slug and
  // have its connection string (password included) injected into this
  // service's env. Only attach databases visible to the deploying service's
  // owner — mirroring loadDatabaseForUser, minus any session-based bypass.
  if (!ownerUserId) {
    result.databaseAccessDenied = ref.ref;
    result.warnings.push(
      `database.ref="${ref.ref}": the deploying service has no recorded owner, so manifest-driven attachments are refused.`,
    );
    return;
  }
  // r650: visibility is not enough. An attachment decrypts the database's
  // password into the container env, so the API attach route demands `admin`
  // on the database (modules/databases.ts) — the manifest held the owner only
  // to "can see it", which a viewer seat satisfies.
  const role = await databaseRole(db, dbRow, { id: ownerUserId, isOperator: ownerIsOperator });
  const existing = await db
    .select()
    .from(databaseAttachments)
    .where(
      and(
        eq(databaseAttachments.serviceId, serviceId),
        eq(databaseAttachments.databaseId, dbRow.id),
      ),
    );
  if (role === null || !roleAtLeast(role, 'admin')) {
    result.databaseAccessDenied = ref.ref;
    // An existing row is left alone: it carries no marker of who made it, and
    // a database admin may have attached it in the panel on purpose. The
    // manifest only stops (re)creating attachments its owner may not make.
    const kept = existing.length > 0
      ? ' An attachment that already exists is left in place (it may have been made in the panel by a database admin) — detach it under Service → Databases if it should not be there.'
      : '';
    result.warnings.push(
      role === null
        ? `database.ref="${ref.ref}" points at a managed database outside this service's access; attach skipped.${kept}`
        : `database.ref="${ref.ref}": the service owner holds the "${role}" role on this database, and attaching hands its password to the container, which needs "admin" (the same rule as attaching in the panel); attach skipped.${kept}`,
    );
    return;
  }
  // INSERT OR IGNORE — the unique (serviceId, databaseId) index already
  // covers dedup; we only need to set envAlias on first insert.
  if (existing.length === 0) {
    await db.insert(databaseAttachments).values({
      serviceId,
      databaseId: dbRow.id,
      envAlias: ref.env,
    });
  }
  result.databaseAttached = true;
}

// ── Alert rules ──────────────────────────────────────────────────────────

/**
 * F130: an `alerts` section that is present is the source of truth for the
 * manifest-owned rules (`svc-<id>-<when>-<channel>`): one it no longer
 * declares — removed, re-pointed to another channel, or skipped below — is
 * deleted, like the `notifications` section replaces its set. An absent
 * section leaves every rule alone; rules with any other name (the panel's)
 * are never touched.
 */
async function syncAlertRules(
  db: DB,
  serviceId: number,
  alerts: NinedeployManifest['alerts'],
  memLimitMb: number,
  result: ApplyManifestResult,
): Promise<void> {
  if (!alerts) return;
  const declared = new Set<string>();

  for (const alert of alerts) {
    // Map the manifest's "when" to a (metric, operator, threshold) triple.
    // The schema has a separate "channel" string from the alert rule's own
    // "name" — we encode the channel into the rule name so multiple alerts
    // with the same `when` but different channels coexist.
    const rule = alertToRule(alert, memLimitMb);
    if (typeof rule === 'string') {
      // No rule the alert engine can evaluate. Writing SOMETHING here used to
      // produce a rule that can never fire (or fires on the wrong unit) and
      // that shows up in Monitoring looking like a configured alert. Say it
      // was skipped instead.
      result.warnings.push(`alerts: when="${alert.when}" ${rule}; rule skipped.`);
      continue;
    }
    const { metric, operator, threshold, durationWindows } = rule;
    const name = `svc-${serviceId}-${alert.when}-${alert.channel}`;
    declared.add(name);

    const existing = await db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.serviceId, serviceId), eq(alertRules.name, name)));

    if (existing.length > 0) {
      await db
        .update(alertRules)
        .set({ metric, operator, threshold, durationWindows, updatedAt: new Date() })
        .where(eq(alertRules.id, existing[0]!.id));
      // Re-applies must heal a missing state row but never wipe live breach
      // state — ensure only INSERTs when the row is absent.
      await ensureAlertState(db, existing[0]!.id);
    } else {
      const [created] = await db
        .insert(alertRules)
        .values({
          serviceId,
          name,
          metric,
          operator,
          threshold,
          durationWindows,
          enabled: true,
        })
        .returning({ id: alertRules.id });
      // evaluateAlerts only UPDATEs alert_state by ruleId — a rule without a
      // state row can never leave 'ok' (breachSince restarts every tick), so
      // creation must seed one.
      if (created) await ensureAlertState(db, created.id);
    }
    result.alertsUpserted += 1;
  }

  const owned = new RegExp(`^svc-${serviceId}-(?:${MANIFEST_ALERT_WHENS.join('|')})-`);
  const stale = (
    await db
      .select({ id: alertRules.id, name: alertRules.name })
      .from(alertRules)
      .where(eq(alertRules.serviceId, serviceId))
  ).filter((r) => owned.test(r.name) && !declared.has(r.name));
  for (const row of stale) {
    await db.delete(alertRules).where(eq(alertRules.id, row.id));
  }
}

/** Every manifest `alerts[].when` — the middle segment of a manifest-owned rule name. */
const MANIFEST_ALERT_WHENS = ['deployFailed', 'restartLoop', 'highMemory', 'highCpu', 'certExpiry'] as const;

/**
 * Translate one manifest alert into an `alert_rules` row, or the reason the
 * metric-based alert engine has nothing it can evaluate for it. The caller
 * turns the reason into a warning rather than inventing a rule.
 */
function alertToRule(
  alert: NonNullable<NinedeployManifest['alerts']>[number],
  memLimitMb: number,
):
  | {
      metric: 'cpu' | 'memory' | 'cert-expiry';
      operator: '>' | '<';
      threshold: number;
      durationWindows: number;
    }
  | string {
  switch (alert.when) {
    case 'highMemory':
      // F128: `memory` rules are evaluated in MiB (plugins/collector.ts), and
      // thresholdPct is a percent — of the memory limit, the only 100% a
      // container has. Without a limit there is nothing to take a percent of.
      if (memLimitMb <= 0) {
        return 'is a percent of the memory limit, and this service has none (set resources.memMb or a limit in Service → Settings)';
      }
      return {
        metric: 'memory',
        operator: '>',
        threshold: Math.max(1, Math.round((memLimitMb * (alert.thresholdPct ?? 90)) / 100)),
        durationWindows: 3,
      };
    case 'highCpu':
      return {
        metric: 'cpu',
        operator: '>',
        threshold: alert.thresholdPct ?? 90,
        durationWindows: 3,
      };
    case 'certExpiry':
      // F129: certificate expiry is sampled host-wide (serviceId null) by the
      // collector, so a service-scoped rule never evaluates — the panel API
      // refuses that shape for the same reason (alertRuleCreate).
      return 'is tracked host-wide, not per service, so a service rule could never fire (an operator can add a host-wide cert-expiry rule under Monitoring)';
    case 'deployFailed':
    case 'restartLoop':
      // Event-shaped: the alert engine evaluates metric samples, and there is
      // no metric that means "the last deploy failed". `deploy.failed` reaches
      // notification channels directly from the deploy pipeline; a per-service
      // routing of it belongs with the `notifications` section.
      return 'is an event, not a metric threshold, and per-service event alerts are not yet implemented';
  }
}
