CREATE TABLE `environments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_workspace_name_idx` ON `environments` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `environments_workspace_idx` ON `environments` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `services` ADD `environment_id` integer REFERENCES environments(id);