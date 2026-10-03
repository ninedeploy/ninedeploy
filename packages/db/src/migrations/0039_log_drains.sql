-- `log_drains` was declared in `schema.ts` and recorded in drizzle-kit's
-- `0031_snapshot.json`, but no migration ever created it.
--
-- Because the snapshot already claims the table exists, `drizzle-kit generate`
-- could never produce this file on its own — the drift was invisible to the
-- tool that would normally catch it. On any database built by replaying the
-- migrations (i.e. every fresh install), the table is simply absent and the Log
-- Drains feature fails at runtime with "no such table: log_drains".
--
-- IF NOT EXISTS throughout: an instance whose schema was created by
-- `drizzle-kit push`, or hand-patched, may already have the table, and applying
-- this must be a no-op there rather than an error that aborts startup.
CREATE TABLE IF NOT EXISTS `log_drains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'http' NOT NULL,
	`url` text NOT NULL,
	`api_key_encrypted` text,
	`service_id` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`format` text DEFAULT 'json' NOT NULL,
	`headers_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `log_drains_service_idx` ON `log_drains` (`service_id`);
