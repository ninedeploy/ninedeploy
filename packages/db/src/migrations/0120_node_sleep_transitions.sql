CREATE TABLE `node_sleep_transitions` (
	`service_id` integer PRIMARY KEY NOT NULL,
	`server_id` integer NOT NULL,
	`deployment_id` integer NOT NULL,
	`runtime_id` text NOT NULL,
	`owner_epoch` integer NOT NULL,
	`request_id` text NOT NULL,
	`action` text NOT NULL,
	`phase` text NOT NULL,
	`configuration` text NOT NULL,
	`binding` text NOT NULL,
	`watermark` integer NOT NULL,
	`wake_token` text NOT NULL,
	`fallback_routing` integer DEFAULT false NOT NULL,
	`targets` text NOT NULL,
	`idle_evidence` text NOT NULL,
	`catcher_id` text,
	`catcher_image` text,
	`worker_token` text,
	`lease_until` integer,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_sleep_request_idx` ON `node_sleep_transitions` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `node_sleep_wake_token_idx` ON `node_sleep_transitions` (`wake_token`);
