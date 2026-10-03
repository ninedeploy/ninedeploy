-- Sprint 10 G-29: domain transfer table.
--
-- The domains table doesn't carry an `owner_user_id` — every
-- row is attached to a service, and ownership flows through
-- the service's workspace membership. A transfer moves a
-- domain row from one service to another in two phases:
--
--   1. Source user (admin on the source service) creates a
--      `domain_transfers` row with a one-time token; the
--      row is a *contract*: the source promises to hand
--      the domain over if someone shows up with the token
--      AND a target service they own.
--   2. Target user (admin on the target service) calls
--      accept with the token + target service id; the
--      server updates `domains.service_id` and marks the
--      transfer row `accepted`.
--
-- The state machine is explicit: a row is `pending` until
-- accepted / cancelled / expired. Re-using a token on a
-- non-pending row is a 409, not a 200 — the row's terminal
-- state is the source of truth.
--
-- The token is a 32-byte URL-safe random string; it lives
-- in the URL only. Stored SHA-256 only (mirroring the API
-- token pattern) so a leaked DB dump does not let an
-- attacker forge a transfer.
--
-- IF NOT EXISTS throughout so an instance whose schema was
-- created by drizzle-kit push is a no-op rather than a
-- startup error. Same pattern as 0039 / 0040 / 0041 / 0042
-- / 0044.
CREATE TABLE IF NOT EXISTS `domain_transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade,
	`source_user_id` integer NOT NULL REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	`target_email` text NOT NULL,
	`target_user_id` integer REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	`target_service_id` integer REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	`token_sha256` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `domain_transfers_token_idx` ON `domain_transfers` (`token_sha256`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `domain_transfers_status_idx` ON `domain_transfers` (`status`, `expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `domain_transfers_target_email_idx` ON `domain_transfers` (`target_email`);
