CREATE TABLE `scim_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`workspace_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_tokens_token_hash_idx` ON `scim_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `users` ADD `scim_external_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `deactivated_at` integer;