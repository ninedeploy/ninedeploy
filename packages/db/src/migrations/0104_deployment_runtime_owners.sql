CREATE TABLE `deployment_runtime_owners` (
	`deployment_id` integer PRIMARY KEY NOT NULL,
	`service_id` integer NOT NULL,
	`server_id` integer NOT NULL,
	`epoch` integer NOT NULL,
	`request_id` text NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_runtime_owner_epoch_idx` ON `deployment_runtime_owners` (`service_id`,`epoch`);