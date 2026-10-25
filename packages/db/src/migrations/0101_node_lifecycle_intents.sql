CREATE TABLE `node_lifecycle_intents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`server_id` integer NOT NULL,
	`runtime_id` text NOT NULL,
	`deployment_id` integer NOT NULL,
	`action` text NOT NULL,
	`request_id` text NOT NULL,
	`phase` text NOT NULL,
	`snapshot` text NOT NULL,
	`targets` text,
	`owner_token` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_lifecycle_request_idx` ON `node_lifecycle_intents` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `node_lifecycle_service_pending_idx` ON `node_lifecycle_intents` (`service_id`) WHERE "node_lifecycle_intents"."phase" NOT IN ('completed', 'superseded');--> statement-breakpoint
CREATE INDEX `node_lifecycle_retry_idx` ON `node_lifecycle_intents` (`next_attempt_at`,`lease_until`);