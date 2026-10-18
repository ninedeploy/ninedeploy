-- Additive only: one column defaulting to off, so every service checks out
-- and builds exactly as before.
ALTER TABLE `services` ADD `git_lfs` integer DEFAULT false NOT NULL;