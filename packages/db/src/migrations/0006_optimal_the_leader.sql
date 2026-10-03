CREATE TABLE `tunnels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`token_encrypted` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`container_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tunnels_slug_unique` ON `tunnels` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `tunnels_slug_idx` ON `tunnels` (`slug`);