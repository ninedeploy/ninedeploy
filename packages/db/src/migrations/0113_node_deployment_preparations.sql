CREATE TABLE `node_deployment_preparations` (
	`deployment_id` integer PRIMARY KEY NOT NULL,
	`service_id` integer NOT NULL,
	`server_id` integer NOT NULL,
	`epoch` integer NOT NULL,
	`request_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`image_id` text NOT NULL,
	`serving` integer NOT NULL,
	`capacity` integer NOT NULL,
	`phase` text DEFAULT 'preparing' NOT NULL,
	`targets` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
