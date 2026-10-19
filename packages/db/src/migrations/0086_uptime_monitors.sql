-- 0.16.8 uptime monitors and status pages. Additive only: four new tables,
-- empty until an operator creates a monitor, so nothing is probed after the
-- upgrade. uptime_checks and uptime_daily are swept by housekeeping.
CREATE TABLE `status_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`notice` text,
	`published` integer DEFAULT false NOT NULL,
	`show_response_times` integer DEFAULT true NOT NULL,
	`monitor_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_pages_slug_idx` ON `status_pages` (`slug`);--> statement-breakpoint
CREATE TABLE `uptime_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`monitor_id` integer NOT NULL,
	`ok` integer NOT NULL,
	`response_ms` integer,
	`status_code` integer,
	`error` text,
	`ts` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `uptime_monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `uptime_checks_monitor_ts_idx` ON `uptime_checks` (`monitor_id`,`ts`);--> statement-breakpoint
CREATE INDEX `uptime_checks_ts_idx` ON `uptime_checks` (`ts`);--> statement-breakpoint
CREATE TABLE `uptime_daily` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`monitor_id` integer NOT NULL,
	`day` text NOT NULL,
	`checks` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`response_ms_sum` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `uptime_monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uptime_daily_monitor_day_idx` ON `uptime_daily` (`monitor_id`,`day`);--> statement-breakpoint
CREATE INDEX `uptime_daily_day_idx` ON `uptime_daily` (`day`);--> statement-breakpoint
CREATE TABLE `uptime_monitors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`service_id` integer,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`expected_status` text DEFAULT '200-399' NOT NULL,
	`keyword` text,
	`interval_seconds` integer DEFAULT 60 NOT NULL,
	`timeout_seconds` integer DEFAULT 10 NOT NULL,
	`failures_before_down` integer DEFAULT 2 NOT NULL,
	`follow_redirects` integer DEFAULT true NOT NULL,
	`verify_tls` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_since` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer,
	`last_response_ms` integer,
	`last_status_code` integer,
	`last_error` text,
	`cert_expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `uptime_monitors_service_idx` ON `uptime_monitors` (`service_id`);