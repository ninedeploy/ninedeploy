CREATE TABLE `access_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`project_id` integer,
	`environment_id` integer,
	`target_key` text NOT NULL,
	`role` text NOT NULL,
	`suspended_at` integer,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_grants_user_target_idx` ON `access_grants` (`user_id`,`target_key`);--> statement-breakpoint
CREATE INDEX `access_grants_workspace_idx` ON `access_grants` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `access_grants_project_idx` ON `access_grants` (`project_id`);--> statement-breakpoint
CREATE INDEX `access_grants_environment_idx` ON `access_grants` (`environment_id`);--> statement-breakpoint
CREATE TABLE `terminal_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`target_kind` text NOT NULL,
	`service_id` integer,
	`database_id` integer,
	`server_id` integer,
	`container_name` text,
	`target_label` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ticket_hash` text,
	`ticket_expires_at` integer,
	`auth_kind` text,
	`client_ip` text,
	`user_agent` text,
	`cols` integer,
	`rows` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`bytes_in` integer DEFAULT 0 NOT NULL,
	`bytes_out` integer DEFAULT 0 NOT NULL,
	`end_reason` text,
	`exit_code` integer,
	`error` text,
	`terminated_by_user_id` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`terminated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminal_sessions_ticket_hash_idx` ON `terminal_sessions` (`ticket_hash`);--> statement-breakpoint
CREATE INDEX `terminal_sessions_created_idx` ON `terminal_sessions` (`created_at`);--> statement-breakpoint
CREATE INDEX `terminal_sessions_status_idx` ON `terminal_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `terminal_sessions_user_created_idx` ON `terminal_sessions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `traffic_rollups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`granularity` integer NOT NULL,
	`bucket_start` integer NOT NULL,
	`scope_key` text NOT NULL,
	`domain_id` integer,
	`service_id` integer,
	`host` text,
	`requests` integer DEFAULT 0 NOT NULL,
	`status_1xx` integer DEFAULT 0 NOT NULL,
	`status_2xx` integer DEFAULT 0 NOT NULL,
	`status_3xx` integer DEFAULT 0 NOT NULL,
	`status_4xx` integer DEFAULT 0 NOT NULL,
	`status_5xx` integer DEFAULT 0 NOT NULL,
	`status_other` integer DEFAULT 0 NOT NULL,
	`bytes_out` integer DEFAULT 0 NOT NULL,
	`duration_sum_ms` integer DEFAULT 0 NOT NULL,
	`duration_max_ms` integer DEFAULT 0 NOT NULL,
	`latency_hist` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traffic_rollups_bucket_scope_idx` ON `traffic_rollups` (`granularity`,`bucket_start`,`scope_key`);--> statement-breakpoint
CREATE INDEX `traffic_rollups_service_idx` ON `traffic_rollups` (`service_id`,`granularity`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `traffic_rollups_bucket_idx` ON `traffic_rollups` (`granularity`,`bucket_start`);