CREATE TABLE `deployment_release_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deployment_id` integer NOT NULL,
	`payload_encrypted` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_release_records_deployment_idx` ON `deployment_release_records` (`deployment_id`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `restored_from_deployment_id` integer;