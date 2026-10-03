ALTER TABLE `domains` ADD `basic_auth` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `ip_allowlist` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `rate_limit_average` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `rate_limit_burst` integer;
