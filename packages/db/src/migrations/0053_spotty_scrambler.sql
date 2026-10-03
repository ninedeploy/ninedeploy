ALTER TABLE `services` ADD `auto_update` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `auto_update_digest` text;