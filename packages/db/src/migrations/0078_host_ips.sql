-- 0.16.1, additive only: a new table, empty until an operator labels, picks or
-- dedicates one of the panel host's addresses. Nothing reads it to change
-- an existing deploy or route.
CREATE TABLE `host_ips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ip` text NOT NULL,
	`label` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`service_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_ips_ip_unique` ON `host_ips` (`ip`);