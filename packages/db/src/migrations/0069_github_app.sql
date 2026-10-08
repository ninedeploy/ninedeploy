CREATE TABLE `github_app_installations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_app_id` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text,
	`account_type` text,
	`account_id` integer,
	`repository_selection` text DEFAULT 'selected' NOT NULL,
	`permissions` text,
	`source_id` integer,
	`suspended_at` integer,
	`removed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`github_app_id`) REFERENCES `github_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_installations_app_inst_idx` ON `github_app_installations` (`github_app_id`,`installation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_installations_source_idx` ON `github_app_installations` (`source_id`);--> statement-breakpoint
CREATE TABLE `github_apps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`app_id` integer NOT NULL,
	`slug` text,
	`client_id` text,
	`client_secret_encrypted` text,
	`private_key_encrypted` text NOT NULL,
	`webhook_secret_encrypted` text NOT NULL,
	`hook_key` text NOT NULL,
	`owner_login` text,
	`owner_type` text,
	`web_base_url` text DEFAULT 'https://github.com' NOT NULL,
	`api_base_url` text DEFAULT 'https://api.github.com' NOT NULL,
	`html_url` text,
	`permissions` text,
	`events` text,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_apps_hook_key_idx` ON `github_apps` (`hook_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_apps_api_app_idx` ON `github_apps` (`api_base_url`,`app_id`);--> statement-breakpoint
CREATE TABLE `github_pr_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`pr_number` integer NOT NULL,
	`comment_id` integer NOT NULL,
	`head_sha` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_pr_comments_service_pr_idx` ON `github_pr_comments` (`service_id`,`pr_number`);--> statement-breakpoint
CREATE TABLE `service_github_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`installation_row_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`repo_full_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`token_scope` text DEFAULT 'repository' NOT NULL,
	`watch_paths` text,
	`report_status` integer DEFAULT false NOT NULL,
	`pr_comment` integer DEFAULT false NOT NULL,
	`previous_source_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_row_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`previous_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_github_links_service_idx` ON `service_github_links` (`service_id`);--> statement-breakpoint
CREATE INDEX `service_github_links_inst_repo_idx` ON `service_github_links` (`installation_row_id`,`repo_id`);--> statement-breakpoint
ALTER TABLE `sources` ADD `base_url` text;