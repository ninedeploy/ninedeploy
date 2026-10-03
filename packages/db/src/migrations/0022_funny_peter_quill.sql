CREATE TABLE `config_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`plugin_id` text,
	`value` text NOT NULL,
	`is_secret` integer DEFAULT false NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`description` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_by` integer,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `config_entries_plugin_idx` ON `config_entries` (`plugin_id`);--> statement-breakpoint
CREATE INDEX `config_entries_category_idx` ON `config_entries` (`category`);--> statement-breakpoint
CREATE TABLE `installed_plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text,
	`author` text,
	`icon` text,
	`enabled` integer DEFAULT true NOT NULL,
	`is_official` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`error` text,
	`manifest` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `installed_plugins_status_idx` ON `installed_plugins` (`status`);
