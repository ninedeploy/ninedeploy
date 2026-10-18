-- Additive only: a new, empty table. No service mounts a file until a member
-- adds one, so every container starts exactly as before.
CREATE TABLE `service_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`container_path` text NOT NULL,
	`content_encrypted` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_files_svc_path_idx` ON `service_files` (`service_id`,`container_path`);