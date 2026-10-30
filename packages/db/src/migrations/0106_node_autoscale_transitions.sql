CREATE TABLE `node_autoscale_transitions` (
	`service_id` integer PRIMARY KEY NOT NULL,
	`owner_epoch` integer NOT NULL,
	`request_id` text NOT NULL,
	`server_id` integer NOT NULL,
	`runtime_id` text NOT NULL,
	`from_replicas` integer NOT NULL,
	`to_replicas` integer NOT NULL,
	`watermark` integer NOT NULL,
	`targets` text NOT NULL,
	`phase` text DEFAULT 'accepted' NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
