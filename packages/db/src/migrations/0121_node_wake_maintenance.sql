CREATE TABLE `node_wake_maintenance` (
	`server_id` integer PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`request_id` text NOT NULL,
	`binding` text NOT NULL,
	`phase` text NOT NULL,
	`snapshot` text NOT NULL,
	`catcher_id` text,
	`catcher_image` text,
	`worker_token` text,
	`lease_until` integer,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_wake_maintenance_request_id_unique` ON `node_wake_maintenance` (`request_id`);