-- Additive only: three columns, every row without a deploy hook (token null,
-- operator false), and a unique index over the null-only token. The user
-- reference is SET NULL on delete, like services.owner_user_id: deleting the
-- member who made a hook disables it instead of blocking the delete.
ALTER TABLE `services` ADD `deploy_hook_token` text;--> statement-breakpoint
ALTER TABLE `services` ADD `deploy_hook_user_id` integer REFERENCES users(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `services` ADD `deploy_hook_operator` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `services_deploy_hook_token_unique` ON `services` (`deploy_hook_token`);