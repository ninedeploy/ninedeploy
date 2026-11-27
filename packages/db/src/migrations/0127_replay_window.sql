CREATE TABLE `replay_window` (
	`key` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `replay_window_expires_at_idx` ON `replay_window` (`expires_at`);