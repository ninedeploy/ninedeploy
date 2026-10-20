-- 0.16.11 scale to zero. Additive only: two nullable columns, null on every
-- existing service, so none sleeps after the upgrade.
ALTER TABLE `services` ADD `sleep_after_minutes` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `asleep_at` integer;
