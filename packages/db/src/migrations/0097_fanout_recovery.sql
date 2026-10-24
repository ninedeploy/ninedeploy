CREATE TABLE `fanout_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`server_id` integer NOT NULL,
	`target_id` integer NOT NULL,
	`deployment_id` integer NOT NULL,
	`primary_runtime_id` text NOT NULL,
	`previous_runtime_id` text,
	`candidate_runtime_id` text NOT NULL,
	`previous_container_id` text,
	`candidate_container_id` text,
	`desired_runtime_id` text,
	`port` integer NOT NULL,
	`health_path` text DEFAULT '/' NOT NULL,
	`health_check` text,
	`phase` text DEFAULT 'preparing' NOT NULL,
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
CREATE UNIQUE INDEX `fanout_transition_target_idx` ON `fanout_transitions` (`service_id`,`server_id`);--> statement-breakpoint
CREATE INDEX `fanout_transition_retry_idx` ON `fanout_transitions` (`next_attempt_at`,`lease_until`);