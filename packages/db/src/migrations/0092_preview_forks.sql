-- 0.16.14 previews of pull requests from forks. Additive only: an
-- off-by-default switch on services (no fork PR gets a preview after the
-- upgrade, as before) and a flag on a preview row, false on every existing
-- preview (they all come from the repository itself).
ALTER TABLE `services` ADD `preview_forks` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `services` ADD `preview_from_fork` integer DEFAULT false NOT NULL;