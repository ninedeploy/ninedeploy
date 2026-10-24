CREATE TABLE `primary_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`server_id` integer,
	`deployment_id` integer NOT NULL,
	`previous` text,
	`candidate` text NOT NULL,
	`phase` text DEFAULT 'ready' NOT NULL,
	`desired_runtime_id` text,
	`routing_touched` integer DEFAULT false NOT NULL,
	`interrupted` integer DEFAULT false NOT NULL,
	`finalize_snapshot` text,
	`image_digest` text,
	`reason` text,
	`owner_token` text,
	`lease_until` integer,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `primary_transition_service_idx` ON `primary_transitions` (`service_id`);--> statement-breakpoint
CREATE INDEX `primary_transition_retry_idx` ON `primary_transitions` (`next_attempt_at`,`lease_until`);