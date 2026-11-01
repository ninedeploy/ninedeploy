CREATE TABLE `node_serving_traffic_receipts` (
	`node_id` integer NOT NULL,
	`service_id` integer NOT NULL,
	`deployment_id` integer NOT NULL,
	`request_id` text NOT NULL,
	`window_id` text NOT NULL,
	`source_id` text NOT NULL,
	`proxy_id` text NOT NULL,
	`epoch` text NOT NULL,
	`target_hash` text NOT NULL,
	`routing_generation` text NOT NULL,
	`start_counter` text NOT NULL,
	`end_counter` text NOT NULL,
	`requests` integer NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`replicas` integer NOT NULL,
	`observed_at_ms` integer NOT NULL,
	`consumed_at_ms` integer NOT NULL,
	PRIMARY KEY(`node_id`, `window_id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_serving_traffic_request_idx` ON `node_serving_traffic_receipts` (`node_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `node_serving_traffic_source_idx` ON `node_serving_traffic_receipts` (`service_id`,`node_id`,`source_id`,`end_counter`);
