-- Additive only: one nullable column. Every existing service keeps the
-- healthcheck it had (health_check null or 'running').
ALTER TABLE `services` ADD `health_command` text;