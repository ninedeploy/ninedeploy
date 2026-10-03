-- Sprint 10 G-30: per-workspace email template overrides.
--
-- The system ships a small set of built-in transactional
-- email templates (password reset, workspace invitation,
-- domain transfer, backup drill failed). A workspace can
-- override the subject + text of any one template without
-- forking the codebase; the (workspace_id, name) pair is
-- the unique key. A DELETE clears the override for the
-- whole workspace; if a future PR narrows to per-name
-- clears the helper gains a name predicate.
--
-- IF NOT EXISTS / UNIQUE IF NOT EXISTS so an instance
-- whose schema was created by drizzle-kit push is a no-op
-- rather than a startup error. Same pattern as 0039-0046.
CREATE TABLE IF NOT EXISTS `email_template_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `email_template_overrides_workspace_name_idx`
  ON `email_template_overrides` (`workspace_id`, `name`);
