CREATE TABLE `workspace_invitations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL REFERENCES workspaces(id) ON UPDATE no action ON DELETE cascade,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token` text NOT NULL,
	`invited_by_user_id` integer NOT NULL REFERENCES users(id) ON UPDATE no action ON DELETE cascade,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_by_user_id` integer REFERENCES users(id) ON UPDATE no action ON DELETE set null,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_workspace_email_idx` ON `workspace_invitations` (`workspace_id`,`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invitations_token_unique` ON `workspace_invitations` (`token`);
--> statement-breakpoint
CREATE INDEX `workspace_invitations_workspace_idx` ON `workspace_invitations` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `workspace_invitations_email_idx` ON `workspace_invitations` (`email`);
