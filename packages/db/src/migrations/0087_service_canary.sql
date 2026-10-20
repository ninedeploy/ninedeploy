-- 0.16.9 canary releases. Additive only: one nullable column, null on every
-- existing service, so every deploy switches all traffic at once as before.
ALTER TABLE `services` ADD `canary` text;
