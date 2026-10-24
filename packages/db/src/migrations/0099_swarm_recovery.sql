CREATE TABLE `swarm_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`deployment_id` integer NOT NULL,
	`manager_node_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`payload_encrypted` text NOT NULL,
	`phase` text DEFAULT 'prepared' NOT NULL,
	`interrupted` integer DEFAULT false NOT NULL,
	`finalize_snapshot` text,
	`reason` text,
	`owner_token` text,
	`lease_until` integer,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `swarm_transition_service_idx` ON `swarm_transitions` (`service_id`);--> statement-breakpoint
CREATE INDEX `swarm_transition_retry_idx` ON `swarm_transitions` (`next_attempt_at`,`lease_until`);