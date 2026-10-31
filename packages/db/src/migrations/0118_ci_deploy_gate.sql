ALTER TABLE `ci_jobs` ADD `deployment_id` integer;--> statement-breakpoint
CREATE INDEX `ci_jobs_deployment_idx` ON `ci_jobs` (`deployment_id`);