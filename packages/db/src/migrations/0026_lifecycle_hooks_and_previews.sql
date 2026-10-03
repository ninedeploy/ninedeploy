ALTER TABLE `services` ADD `preview_deployments_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `preview_auto_destroy_on_close` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `preview_domain_pattern` text;--> statement-breakpoint
ALTER TABLE `services` ADD `preview_max_active` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `is_ephemeral_preview` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `preview_parent_service_id` integer REFERENCES services(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `services` ADD `pr_number` integer;--> statement-breakpoint
ALTER TABLE `build_configs` ADD `pre_deploy_cmd` text;--> statement-breakpoint
ALTER TABLE `build_configs` ADD `post_deploy_cmd` text;--> statement-breakpoint
ALTER TABLE `build_configs` ADD `pre_stop_cmd` text;
