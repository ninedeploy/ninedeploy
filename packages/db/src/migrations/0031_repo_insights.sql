-- IF NOT EXISTS guards: this migration's journal timestamp was reordered
-- (it originally sorted before 0030), so a database journaled mid-fix could
-- theoretically replay it. Replaying must stay a no-op.
CREATE TABLE IF NOT EXISTS `repo_insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL,
	`framework_id` text NOT NULL,
	`data` text NOT NULL,
	`commit_sha` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `repo_insights_service_idx` ON `repo_insights` (`service_id`);
