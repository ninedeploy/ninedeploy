CREATE TABLE `ci_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`runner_id` integer,
	`number` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`lease_hash` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`log_bytes` integer DEFAULT 0 NOT NULL,
	`log_seq` integer DEFAULT 0 NOT NULL,
	`exit_code` integer,
	`error` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `ci_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_id`) REFERENCES `ci_runners`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_attempts_job_number_idx` ON `ci_attempts` (`job_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `ci_attempts_lease_idx` ON `ci_attempts` (`lease_hash`);--> statement-breakpoint
CREATE INDEX `ci_attempts_status_idx` ON `ci_attempts` (`status`);--> statement-breakpoint
CREATE TABLE `ci_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`commit_sha` text,
	`ref` text,
	`image` text NOT NULL,
	`script` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`secret_names` text DEFAULT '[]' NOT NULL,
	`timeout_seconds` integer DEFAULT 1800 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`current_attempt_id` integer,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`created_by` integer,
	`approved_by` integer,
	`cancelled_by` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ci_jobs_service_idx` ON `ci_jobs` (`service_id`,`id`);--> statement-breakpoint
CREATE INDEX `ci_jobs_status_idx` ON `ci_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `ci_runners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`capacity` integer DEFAULT 1 NOT NULL,
	`version` text,
	`last_seen_at` integer,
	`revoked_at` integer,
	`created_by` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_runners_token_idx` ON `ci_runners` (`token_hash`);