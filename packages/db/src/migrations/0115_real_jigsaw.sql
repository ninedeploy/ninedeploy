CREATE TABLE `node_autoscale_capacity` (
	`deployment_id` integer PRIMARY KEY NOT NULL,
	`service_id` integer NOT NULL,
	`server_id` integer NOT NULL,
	`runtime_id` text NOT NULL,
	`image_id` text NOT NULL,
	`targets` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
