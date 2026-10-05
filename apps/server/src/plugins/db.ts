import { createDb, runMigrations, sql, type DB } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { reconcileDeploymentHistory } from '../engine/pipeline.js';
import { ensureOwnershipBackfilled } from '../lib/ownershipBackfill.js';
import { ensureRegistryBindingsInitialised } from '../lib/registryBinding.js';
import { ensureVaultAllowlistInitialised } from '../lib/vault.js';

// Augment the Fastify instance so `fastify.db` is typed everywhere.
declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
  }
}

/* v8 ignore start */
/**
 * Self-healing runtime schema validation: ensures critical newly added columns
 * exist even if an existing SQLite file had skipped a partial migration step.
 */
async function ensureEssentialColumns(db: DB) {
  const statements = [
    'ALTER TABLE `databases` ADD COLUMN `web_gui_enabled` integer DEFAULT 0 NOT NULL;',
    'ALTER TABLE `databases` ADD COLUMN `web_gui_port` integer;',
    'ALTER TABLE `databases` ADD COLUMN `extensions` text DEFAULT \'[]\' NOT NULL;',
    'ALTER TABLE `domains` ADD COLUMN `basic_auth` text;',
    'ALTER TABLE `domains` ADD COLUMN `ip_allowlist` text;',
    'ALTER TABLE `domains` ADD COLUMN `rate_limit_average` integer;',
    'ALTER TABLE `domains` ADD COLUMN `rate_limit_burst` integer;',
    'ALTER TABLE `services` ADD COLUMN `preview_deployments_enabled` integer DEFAULT 0 NOT NULL;',
    'ALTER TABLE `services` ADD COLUMN `preview_auto_destroy_on_close` integer DEFAULT 1 NOT NULL;',
    'ALTER TABLE `services` ADD COLUMN `preview_domain_pattern` text;',
    'ALTER TABLE `services` ADD COLUMN `preview_max_active` integer DEFAULT 5 NOT NULL;',
    'ALTER TABLE `services` ADD COLUMN `is_ephemeral_preview` integer DEFAULT 0 NOT NULL;',
    'ALTER TABLE `services` ADD COLUMN `pr_number` integer;',
    'ALTER TABLE `build_configs` ADD COLUMN `pre_deploy_cmd` text;',
    'ALTER TABLE `build_configs` ADD COLUMN `post_deploy_cmd` text;',
    'ALTER TABLE `build_configs` ADD COLUMN `pre_stop_cmd` text;',
    // Ownership for managed databases — mirrors services.owner_user_id so the
    // access rules in lib/resourceAccess.ts can scope database routes per user.
    'ALTER TABLE `databases` ADD COLUMN `owner_user_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL;',
    // Single-use TOTP: the highest step already spent for the account, so a
    // code cannot be replayed inside its 90-second drift window (L-10).
    'ALTER TABLE `users` ADD COLUMN `totp_last_step` integer;',
  ];

  for (const stmt of statements) {
    try {
      await db.run(sql.raw(stmt));
    } catch {
      // Column already exists or table not created yet — safe to ignore
    }
  }
}

/* v8 ignore stop */

/** Attaches a Drizzle-backed database connection and applies pending migrations. */
export default fp(
  async (fastify) => {
    if (!fastify.db) {
      const { db, ready } = createDb({ url: config.dbUrl });
      await ready;
      // Self-migrating startup: applies pending migrations via the RUNTIME
      // migrator (drizzle-kit is a devDependency, absent in production builds
      // and containers). Idempotent — a no-op when the schema is current.
      const folder = await runMigrations(db);
      fastify.log.info({ folder }, 'database migrations applied');

      // Run runtime self-healing column check
      await ensureEssentialColumns(db);

      // Heal stale deployment history once per boot: at most one `running`
      // row per live service, everything else reads `superseded`. Must never
      // block startup on a hiccup.
      try {
        const demoted = await reconcileDeploymentHistory(db);
        if (demoted > 0) fastify.log.info({ demoted }, 'stale running deployments marked superseded');
      } catch (err) {
        fastify.log.warn({ err }, 'deployment history reconciliation skipped');
      }

      // r510/r512 upgrade path: seed the vault allowlist and the registry
      // credential host bindings from current usage on the first boot of a
      // release that enforces them, so working deploys keep working. Both are
      // also initialised lazily at their use sites; a failure here only
      // defers the seed, it never blocks startup.
      try {
        await ensureVaultAllowlistInitialised(db, (msg, detail) => fastify.log.warn(detail, msg));
      } catch (err) {
        fastify.log.warn({ err }, 'vault allowlist initialisation deferred');
      }
      try {
        await ensureRegistryBindingsInitialised(db, (msg, detail) => fastify.log.warn(detail, msg));
      } catch (err) {
        fastify.log.warn({ err }, 'registry credential binding initialisation deferred');
      }
      // r710: hand resources of creators who lost their seat before r695
      // (SCIM removals up to 0.10.42) to the workspace owner, once.
      try {
        await ensureOwnershipBackfilled(db, (msg, detail) => fastify.log.warn(detail, msg));
      } catch (err) {
        fastify.log.warn({ err }, 'ownership backfill deferred');
      }

      fastify.decorate('db', db);
    }
  },
  { name: 'ninedeploy-db' },
);
