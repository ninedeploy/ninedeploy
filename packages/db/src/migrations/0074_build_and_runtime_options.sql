-- 0.16.1, additive only: nullable columns, no row touched, so every existing
-- service builds and runs exactly as before and 0.16.0 can roll back over it.
--   build_configs.build_args       Dockerfile build arguments (JSON string[])
--   services.health_timeout_seconds healthcheck deadline (null = 300 s)
--   services.runtime_options        operator container options (JSON)
ALTER TABLE `build_configs` ADD `build_args` text;--> statement-breakpoint
ALTER TABLE `services` ADD `health_timeout_seconds` integer;--> statement-breakpoint
ALTER TABLE `services` ADD `runtime_options` text;