ALTER TABLE `services` ADD `cmd` text;--> statement-breakpoint
ALTER TABLE `services` ADD `docker_socket` integer DEFAULT false NOT NULL;