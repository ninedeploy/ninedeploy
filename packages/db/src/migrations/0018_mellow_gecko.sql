DROP INDEX `deployments_service_created_idx`;--> statement-breakpoint
CREATE INDEX `deployments_service_created_idx` ON `deployments` (`service_id`,`created_at`);
