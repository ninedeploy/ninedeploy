CREATE TABLE `error_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`event_id` text,
	`release` text,
	`environment` text,
	`deployment_id` integer,
	`payload` text NOT NULL,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `error_issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `error_events_issue_received_idx` ON `error_events` (`issue_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `error_events_received_idx` ON `error_events` (`received_at`);--> statement-breakpoint
CREATE TABLE `error_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`culprit` text,
	`level` text DEFAULT 'error' NOT NULL,
	`status` text DEFAULT 'unresolved' NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`first_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`first_release` text,
	`first_deployment_id` integer,
	`last_deployment_id` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `error_issues_service_fingerprint_idx` ON `error_issues` (`service_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `error_issues_service_last_seen_idx` ON `error_issues` (`service_id`,`last_seen`);