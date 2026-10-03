CREATE INDEX `audit_log_entity_ts_idx` ON `audit_log` (`entity`,`ts`);--> statement-breakpoint
CREATE INDEX `backups_db_status_idx` ON `backups` (`database_id`,`status`);--> statement-breakpoint
CREATE INDEX `deployments_status_idx` ON `deployments` (`status`);--> statement-breakpoint
CREATE INDEX `domains_service_idx` ON `domains` (`service_id`);--> statement-breakpoint
CREATE INDEX `metrics_service_kind_ts_idx` ON `metrics` (`service_id`,`kind`,`ts`);--> statement-breakpoint
CREATE INDEX `notification_log_channel_ts_idx` ON `notification_log` (`channel_id`,`ts`);