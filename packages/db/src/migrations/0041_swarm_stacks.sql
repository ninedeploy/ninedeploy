-- Sprint 5 G-10 PR #21: durable record of every stack the Swarm driver
-- has applied, so a kernel restart can resume without re-issuing the
-- docker service / network / secret / config commands.
--
-- The driver keeps a working file under
-- `/var/lib/ninedeploy/stacks/<name>/stack.json` for fast lookup, but
-- the row is the source of truth across a process restart because the
-- swarm itself is a separate process we do not own.
--
-- IF NOT EXISTS throughout: an instance whose schema was created by
-- `drizzle-kit push` may already have the table; applying this must be
-- a no-op there rather than aborting startup. Mirrors the rationale
-- in `0039_log_drains.sql` and `0040_cache_registry_blobs.sql`.
CREATE TABLE IF NOT EXISTS `swarm_stacks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`state_json` text NOT NULL,
	`last_applied_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `swarm_stacks_name_idx` ON `swarm_stacks` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `swarm_stacks_last_applied_idx` ON `swarm_stacks` (`last_applied_at`);
