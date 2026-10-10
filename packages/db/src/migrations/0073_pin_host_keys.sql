-- 0.15.8: opt-in SSH host key pinning for deploy-key sources. Additive only:
-- a defaulted flag (off for every existing row) and a nullable text column.
ALTER TABLE `sources` ADD `pin_host_keys` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `host_keys` text;