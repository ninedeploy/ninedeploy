-- 0.16.1, additive only: a nullable column (no service has a badge until a
-- member turns one on) and its unique index (NULLs never collide).
ALTER TABLE `services` ADD `badge_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `services_badge_token_unique` ON `services` (`badge_token`);