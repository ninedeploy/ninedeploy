CREATE TABLE `database_backup_policies` (
	`database_id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cron` text DEFAULT '0 3 * * *' NOT NULL,
	`retain_count` integer DEFAULT 7 NOT NULL,
	`retain_remote_count` integer,
	`destination_id` integer,
	`local_only` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `backup_destinations`(`id`) ON UPDATE no action ON DELETE set null
);
