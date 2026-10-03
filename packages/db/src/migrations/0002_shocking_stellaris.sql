ALTER TABLE `databases` ADD `cpu_shares` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `databases` ADD `mem_limit_mb` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `cpu_shares` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `mem_limit_mb` integer DEFAULT 0 NOT NULL;