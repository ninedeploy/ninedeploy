ALTER TABLE `databases` ADD `web_gui_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `databases` ADD `web_gui_port` integer;--> statement-breakpoint
ALTER TABLE `databases` ADD `extensions` text DEFAULT '[]' NOT NULL;
