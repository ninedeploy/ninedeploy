CREATE TABLE `database_upgrades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`database_id` integer NOT NULL,
	`engine` text NOT NULL,
	`from_major` integer NOT NULL,
	`to_major` integer NOT NULL,
	`previous_version` text,
	`target_version` text NOT NULL,
	`from_image` text NOT NULL,
	`to_image` text NOT NULL,
	`previous_volume` text NOT NULL,
	`target_volume` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text,
	`switched` integer DEFAULT false NOT NULL,
	`safety_backup_id` integer,
	`verification` text,
	`error` text,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	`rolled_back_at` integer,
	`finalized_at` integer,
	FOREIGN KEY (`database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`safety_backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `database_upgrades_database_created_idx` ON `database_upgrades` (`database_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `database_upgrades_status_idx` ON `database_upgrades` (`status`);