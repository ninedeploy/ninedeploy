-- ─── volume backups ──────────────────────────────────────────────────────
-- The existing `backups` table was designed for database dumps (scope='db').
-- This migration extends it to cover Docker volume snapshots (scope='volumes'):
--
--   • `database_id` becomes nullable so a row can target a volume that has
--     no corresponding managed-database row.
--   • `volume_name` carries the Docker volume name (managed: nd-svc-* /
--     nd-db-*). Required for scope='volumes' rows, NULL for scope='db'.
--   • A new composite index on (volume_name, created_at) supports the
--     per-volume listing and the retention sweep.
--
-- SQLite cannot ALTER a column to become nullable in-place, so the column is
-- rebuilt through a temp table. The existing rows are scope='db' so they
-- carry a non-null `database_id`; their `volume_name` is set to NULL on
-- copy. The constraint `exactly one of (databaseId, volumeName)` is
-- enforced at the application layer (the route only inserts the matching
-- pair); a CHECK constraint would also work but SQLite ALTER does not
-- support ADD CONSTRAINT until 3.37 — the rewrite is portable instead.
CREATE TABLE `backups_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`database_id` integer REFERENCES databases(id) ON UPDATE no action ON DELETE cascade,
	`volume_name` text,
	`scope` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`path` text NOT NULL,
	`remote_key` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `backups_new` (id, database_id, scope, status, path, remote_key, size_bytes, created_at)
SELECT id, database_id, scope, status, path, remote_key, size_bytes, created_at FROM `backups`;
--> statement-breakpoint
DROP TABLE `backups`;
--> statement-breakpoint
ALTER TABLE `backups_new` RENAME TO `backups`;
--> statement-breakpoint
CREATE INDEX `backups_db_status_idx` ON `backups` (`database_id`,`status`);
--> statement-breakpoint
CREATE INDEX `backups_volume_created_idx` ON `backups` (`volume_name`,`created_at`);
