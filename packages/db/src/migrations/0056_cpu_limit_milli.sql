ALTER TABLE `databases` ADD `cpu_limit_milli` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `cpu_limit_milli` integer DEFAULT 0 NOT NULL;