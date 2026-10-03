-- FK indexes the application forgot (SQLite does not auto-index FK columns).
--
-- Every multi-server page filters `services` by the remote server, every
-- webhook delivery joins its service, and project listings join their
-- databases — all three were full-table scans. Safe, idempotent-by-name
-- adds; no data is touched.
CREATE INDEX `services_server_idx` ON `services` (`server_id`);
--> statement-breakpoint
CREATE INDEX `webhooks_service_idx` ON `webhooks` (`service_id`);
--> statement-breakpoint
CREATE INDEX `databases_project_idx` ON `databases` (`project_id`);
