CREATE TABLE `alert_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer,
	`name` text NOT NULL,
	`metric` text NOT NULL,
	`operator` text DEFAULT '>' NOT NULL,
	`threshold` integer NOT NULL,
	`duration_windows` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rules_name_idx` ON `alert_rules` (`name`);--> statement-breakpoint
CREATE TABLE `alert_state` (
	`rule_id` integer NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`breach_since` integer,
	`fired_at` integer,
	`last_notified_at` integer,
	`last_value` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_state_rule_id_unique` ON `alert_state` (`rule_id`);