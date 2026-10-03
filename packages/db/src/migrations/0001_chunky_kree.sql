CREATE TABLE `database_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`database_id` integer NOT NULL,
	`env_alias` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `db_attach_svc_db_idx` ON `database_attachments` (`service_id`,`database_id`);--> statement-breakpoint
CREATE TABLE `databases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`engine` text NOT NULL,
	`version` text,
	`status` text DEFAULT 'creating' NOT NULL,
	`container_name` text,
	`internal_host` text,
	`internal_port` integer,
	`username` text,
	`password_encrypted` text NOT NULL,
	`db_name` text,
	`volume_name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `databases_slug_idx` ON `databases` (`slug`);