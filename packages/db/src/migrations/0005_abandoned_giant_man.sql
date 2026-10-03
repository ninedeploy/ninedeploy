DROP INDEX "api_tokens_hash_unique";--> statement-breakpoint
DROP INDEX "api_tokens_user_idx";--> statement-breakpoint
DROP INDEX "db_attach_svc_db_idx";--> statement-breakpoint
DROP INDEX "databases_slug_idx";--> statement-breakpoint
DROP INDEX "deployments_service_created_idx";--> statement-breakpoint
DROP INDEX "domains_host_path_idx";--> statement-breakpoint
DROP INDEX "env_vars_service_key_idx";--> statement-breakpoint
DROP INDEX "projects_slug_unique";--> statement-breakpoint
DROP INDEX "services_project_slug_idx";--> statement-breakpoint
DROP INDEX "users_email_unique";--> statement-breakpoint
ALTER TABLE `services` ALTER COLUMN "repo_url" TO "repo_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_unique` ON `api_tokens` (`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `db_attach_svc_db_idx` ON `database_attachments` (`service_id`,`database_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `databases_slug_idx` ON `databases` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `deployments_service_created_idx` ON `deployments` (`service_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `domains_host_path_idx` ON `domains` (`hostname`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `env_vars_service_key_idx` ON `env_vars` (`service_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `services_project_slug_idx` ON `services` (`project_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `services` ADD `image` text;--> statement-breakpoint
ALTER TABLE `services` ADD `volume_mount` text;