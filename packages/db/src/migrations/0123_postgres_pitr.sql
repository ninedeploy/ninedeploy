CREATE TABLE `pitr_recoveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_database_id` integer,
	`database_id` integer,
	`target_time` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`base_backup` text,
	`recovered_to` text,
	`restore_ms` integer,
	`requested_by` integer,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`source_database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pitr_recoveries_source_idx` ON `pitr_recoveries` (`source_database_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `databases` ADD `pitr_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `databases` ADD `pitr_retention_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `databases` ADD `pitr_base_backup_at` integer;--> statement-breakpoint
ALTER TABLE `databases` ADD `pitr_last_error` text;