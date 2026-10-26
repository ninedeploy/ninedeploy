-- Preserve the global command ID high-water mark, including pruned history.
CREATE TABLE `__nd_lifecycle_seq_0103` (`seq` integer NOT NULL);
--> statement-breakpoint
INSERT INTO `__nd_lifecycle_seq_0103` SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='node_lifecycle_intents'),0);
--> statement-breakpoint
CREATE TABLE `__new_node_lifecycle_intents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`server_id` integer NOT NULL,
	`runtime_id` text,
	`deployment_id` integer,
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
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "node_lifecycle_anchor_check" CHECK(("__new_node_lifecycle_intents"."runtime_id" IS NOT NULL AND "__new_node_lifecycle_intents"."deployment_id" IS NOT NULL) OR ("__new_node_lifecycle_intents"."action" = 'stop' AND "__new_node_lifecycle_intents"."runtime_id" IS NULL AND "__new_node_lifecycle_intents"."deployment_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_node_lifecycle_intents`("id", "service_id", "server_id", "runtime_id", "deployment_id", "action", "request_id", "phase", "snapshot", "targets", "owner_token", "lease_until", "attempts", "reason", "next_attempt_at", "created_at", "updated_at", "completed_at") SELECT "id", "service_id", "server_id", "runtime_id", "deployment_id", "action", "request_id", "phase", "snapshot", "targets", "owner_token", "lease_until", "attempts", "reason", "next_attempt_at", "created_at", "updated_at", "completed_at" FROM `node_lifecycle_intents`;--> statement-breakpoint
DROP TABLE `node_lifecycle_intents`;--> statement-breakpoint
ALTER TABLE `__new_node_lifecycle_intents` RENAME TO `node_lifecycle_intents`;--> statement-breakpoint
CREATE UNIQUE INDEX `node_lifecycle_request_idx` ON `node_lifecycle_intents` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `node_lifecycle_service_pending_idx` ON `node_lifecycle_intents` (`service_id`) WHERE "node_lifecycle_intents"."phase" NOT IN ('completed', 'superseded');--> statement-breakpoint
CREATE INDEX `node_lifecycle_retry_idx` ON `node_lifecycle_intents` (`next_attempt_at`,`lease_until`);
--> statement-breakpoint
INSERT INTO sqlite_sequence(name,seq) SELECT 'node_lifecycle_intents',seq FROM `__nd_lifecycle_seq_0103` WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='node_lifecycle_intents');
--> statement-breakpoint
UPDATE sqlite_sequence SET seq=MAX(seq,(SELECT seq FROM `__nd_lifecycle_seq_0103`)) WHERE name='node_lifecycle_intents';
--> statement-breakpoint
DROP TABLE `__nd_lifecycle_seq_0103`;
