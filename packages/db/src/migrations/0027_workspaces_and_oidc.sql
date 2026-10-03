CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`owner_id` integer NOT NULL REFERENCES users(id) ON DELETE cascade,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL REFERENCES workspaces(id) ON DELETE cascade,
	`user_id` integer NOT NULL REFERENCES users(id) ON DELETE cascade,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_workspace_user_idx` ON `workspace_members` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `oidc_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`issuer_url` text,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text NOT NULL,
	`scopes` text DEFAULT 'openid profile email' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`auto_enroll` integer DEFAULT true NOT NULL,
	`default_role` text DEFAULT 'member' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_slug_unique` ON `oidc_providers` (`slug`);--> statement-breakpoint
ALTER TABLE `projects` ADD `workspace_id` integer REFERENCES workspaces(id) ON DELETE cascade;
