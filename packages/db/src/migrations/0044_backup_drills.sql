-- Sprint 10 G-17: backup drills table.
--
-- "Is this backup actually restorable?" is the question every
-- operator eventually asks. Until now the answer required
-- spinning up a throwaway container, restoring by hand, and
-- eyeballing the logs — a routine that gets skipped on busy
-- weeks and then fails the first time the restore is actually
-- needed (corrupted dump, schema drift, missing extension).
--
-- `backup_drills` is the audit trail for the smoke drill: a
-- row per drill attempt, with the engine-specific check
-- (pg_restore --list, redis-check-rdb, mysqldump header
-- parse, ...) in `details_json` so a future operator can see
-- *what* the drill actually verified, not just that it
-- passed.
--
-- IF NOT EXISTS throughout so an instance whose schema was
-- created by `drizzle-kit push` is a no-op rather than a
-- startup error. Mirrors the rationale in 0039 / 0040 /
-- 0041 / 0042.
CREATE TABLE IF NOT EXISTS `backup_drills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`database_id` integer NOT NULL REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE cascade,
	`backup_id` integer NOT NULL REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE cascade,
	`status` text NOT NULL DEFAULT 'pending',
	`engine` text NOT NULL,
	`duration_ms` integer NOT NULL DEFAULT 0,
	`error` text,
	`details_json` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `backup_drills_db_started_idx` ON `backup_drills` (`database_id`, `started_at`);
