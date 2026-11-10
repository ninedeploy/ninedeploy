CREATE TABLE `volume_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`volume_name` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`chunk_size` integer DEFAULT 0 NOT NULL,
	`sha256` text NOT NULL,
	`filename` text,
	`staging_path` text,
	`safety_backup_id` integer,
	`error` text,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`safety_backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `volume_imports_service_created_idx` ON `volume_imports` (`service_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `volume_imports_status_idx` ON `volume_imports` (`status`);