-- ─── service volume attachments ───────────────────────────────────────────
-- A service can attach multiple named Docker volumes in addition to (or
-- instead of) its single `volumeMount` primary. Persistence is handled by
-- Docker named volumes; this row only records the (service, volume, path,
-- readonly) tuple. Detaching a service leaves the volume behind.
--
-- One service cannot:
--   • mount two volumes at the same container path (pathIdx)
--   • attach the same volume twice to itself (volumeIdx)
-- The same volume MAY be attached to multiple services (no cross-service
-- uniqueness on volumeName).
CREATE TABLE `service_volume_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer NOT NULL REFERENCES services(id) ON UPDATE no action ON DELETE cascade,
	`volume_name` text NOT NULL,
	`container_path` text NOT NULL,
	`read_only` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `svc_vol_attach_svc_path_idx` ON `service_volume_attachments` (`service_id`,`container_path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `svc_vol_attach_svc_volume_idx` ON `service_volume_attachments` (`service_id`,`volume_name`);
--> statement-breakpoint
CREATE INDEX `svc_vol_attach_volume_idx` ON `service_volume_attachments` (`volume_name`);
