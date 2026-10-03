ALTER TABLE `users` ADD `totp_last_step` integer;--> statement-breakpoint
ALTER TABLE `domains` ADD `verification_token` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `verified_at` integer;
