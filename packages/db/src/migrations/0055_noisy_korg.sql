ALTER TABLE `build_configs` ADD `output_dir` text;--> statement-breakpoint
ALTER TABLE `build_configs` ADD `static_spa` integer DEFAULT true NOT NULL;