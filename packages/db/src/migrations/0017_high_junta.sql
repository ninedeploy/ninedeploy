CREATE TABLE `backup_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`endpoint` text NOT NULL,
	`region` text DEFAULT 'us-east-1' NOT NULL,
	`bucket` text NOT NULL,
	`prefix` text DEFAULT 'ninedeploy' NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_key_encrypted` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`exit_code` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `scheduled_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_idx` ON `job_runs` (`job_id`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`name` text NOT NULL,
	`cron` text NOT NULL,
	`kind` text DEFAULT 'deploy' NOT NULL,
	`command` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_service_idx` ON `scheduled_jobs` (`service_id`);--> statement-breakpoint
CREATE TABLE `servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 4600 NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`token_encrypted` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `backups` ADD `remote_key` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `headers` text;--> statement-breakpoint
ALTER TABLE `services` ADD `server_id` integer REFERENCES servers(id);--> statement-breakpoint
ALTER TABLE `services` ADD `compose_service` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `registry_username` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret_encrypted` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `watch_paths` text;