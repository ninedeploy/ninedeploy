CREATE TABLE `log_drain_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drain_id` integer NOT NULL,
	`service_id` integer NOT NULL,
	`runtime_key` text NOT NULL,
	`binding` text NOT NULL,
	`payload_encrypted` text NOT NULL,
	`entry_count` integer NOT NULL,
	`payload_bytes` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`drain_id`) REFERENCES `log_drains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `log_drain_batches_drain_time_idx` ON `log_drain_batches` (`drain_id`,`next_attempt_at`,`id`);--> statement-breakpoint
CREATE INDEX `log_drain_batches_service_idx` ON `log_drain_batches` (`service_id`);--> statement-breakpoint
CREATE TABLE `log_drain_cursors` (
	`drain_id` integer NOT NULL,
	`service_id` integer NOT NULL,
	`runtime_key` text NOT NULL,
	`binding` text NOT NULL,
	`last_timestamp` text NOT NULL,
	`boundary_count` integer DEFAULT -1 NOT NULL,
	`paused_reason` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`drain_id`, `runtime_key`, `binding`),
	FOREIGN KEY (`drain_id`) REFERENCES `log_drains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `log_drain_cursors_updated_idx` ON `log_drain_cursors` (`updated_at`);--> statement-breakpoint
CREATE TABLE `metric_rollups` (
	`service_id` integer NOT NULL,
	`kind` text NOT NULL,
	`bucket_seconds` integer NOT NULL,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	`sum` real NOT NULL,
	`samples` integer NOT NULL,
	`min` real NOT NULL,
	`max` real NOT NULL,
	PRIMARY KEY(`service_id`, `kind`, `bucket_seconds`, `ts`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metric_rollups_ts_idx` ON `metric_rollups` (`ts`);