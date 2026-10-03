-- Sprint 10 G-32: PgBouncer sidecar columns.
--
-- Postgres databases can opt into a co-located PgBouncer
-- container that fronts the real DB on a separate port.
-- Three columns on `databases` track the sidecar's state;
-- the container itself is named by convention
-- `nd-pgb-<slug>` so it can be discovered by `docker ps`
-- without a separate registry.
--
-- Nullable / defaulted so existing rows are unaffected.
-- The columns are engine-restricted to 'postgres' at the
-- application layer (the route refuses to enable a
-- sidecar for MySQL / Redis / etc.).
--
-- IF NOT EXISTS via a fresh ALTER so a drizzle-kit-push
-- instance that already has the columns is a no-op.
ALTER TABLE `databases` ADD COLUMN `pgbouncer_enabled` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `databases` ADD COLUMN `pgbouncer_container_name` text;
--> statement-breakpoint
ALTER TABLE `databases` ADD COLUMN `pgbouncer_port` integer DEFAULT 6432 NOT NULL;
