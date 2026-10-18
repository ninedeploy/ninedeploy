-- 0.16.1, additive only: two nullable columns. No service publishes extra host
-- ports and every healthcheck keeps its HTTP/TCP probe until someone sets one,
-- so every deploy runs as before.
ALTER TABLE `services` ADD `health_check` text;--> statement-breakpoint
ALTER TABLE `services` ADD `port_mappings` text;