-- r300: give `services.environment_id` and `backups.destination_id` the
-- ON DELETE SET NULL rule `schema.ts` has always declared for them.
--
-- 0052 and 0062 added both columns with `ALTER TABLE … ADD … REFERENCES x(id)`
-- and no delete rule, i.e. NO ACTION. With `PRAGMA foreign_keys=ON` (every
-- connection sets it) that made DELETE /v1/environments/:id fail with a
-- FOREIGN KEY constraint error for any lane that still held a service — the
-- route promises the services survive, detached — and DELETE
-- /v1/backup-destinations/:id fail once any backup recorded the destination.
--
-- SQLite cannot alter a foreign key in place, so both tables are rebuilt
-- (the 0034 pattern). Foreign keys MUST be off while the old table is
-- dropped: with them on, DROP TABLE runs an implicit DELETE that fires every
-- child's ON DELETE CASCADE (deployments, domains, env vars, … for
-- `services`). libsql's migrator already turns them off around the batch
-- (the PRAGMAs below are then no-ops inside its transaction); they matter on
-- the statement-by-statement recovery path in `migrate.ts`, which runs in
-- autocommit.
--
-- `sqlite_sequence` is carried across: DROP TABLE deletes the old table's
-- AUTOINCREMENT high-water mark, and the copy only knows MAX(id), so without
-- this a deleted service's id (it names `nd-svc-*` resources, audit rows,
-- repo checkouts) could be handed out again.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_user_id` integer REFERENCES users(id) ON UPDATE no action ON DELETE set null,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`type` text DEFAULT 'docker' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`repo_url` text,
	`branch` text DEFAULT 'main' NOT NULL,
	`commit_sha` text,
	`source_id` integer REFERENCES sources(id) ON UPDATE no action ON DELETE set null,
	`image` text,
	`volume_mount` text,
	`port` integer,
	`published_port` integer,
	`health_path` text DEFAULT '/' NOT NULL,
	`runtime_id` text,
	`cpu_shares` integer DEFAULT 0 NOT NULL,
	`mem_limit_mb` integer DEFAULT 0 NOT NULL,
	`cmd` text,
	`docker_socket` integer DEFAULT 0 NOT NULL,
	`template_id` text,
	`template_database_env` text,
	`server_id` integer REFERENCES servers(id) ON UPDATE no action ON DELETE set null,
	`compose_service` text,
	`preview_deployments_enabled` integer DEFAULT 0 NOT NULL,
	`preview_auto_destroy_on_close` integer DEFAULT 1 NOT NULL,
	`preview_domain_pattern` text,
	`preview_max_active` integer DEFAULT 5 NOT NULL,
	`is_ephemeral_preview` integer DEFAULT 0 NOT NULL,
	`preview_parent_service_id` integer REFERENCES services(id) ON UPDATE no action ON DELETE cascade,
	`pr_number` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`compose_content` text,
	`environment_id` integer REFERENCES environments(id) ON UPDATE no action ON DELETE set null,
	`auto_update` integer DEFAULT false NOT NULL,
	`auto_update_digest` text,
	`cpu_limit_milli` integer DEFAULT 0 NOT NULL,
	`replicas` integer DEFAULT 1 NOT NULL,
	`runtime_replicas` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_services` (
	`id`,`owner_user_id`,`name`,`slug`,`type`,`status`,`repo_url`,`branch`,`commit_sha`,
	`source_id`,`image`,`volume_mount`,`port`,`published_port`,`health_path`,`runtime_id`,
	`cpu_shares`,`mem_limit_mb`,`cmd`,`docker_socket`,`template_id`,`template_database_env`,
	`server_id`,`compose_service`,`preview_deployments_enabled`,`preview_auto_destroy_on_close`,
	`preview_domain_pattern`,`preview_max_active`,`is_ephemeral_preview`,
	`preview_parent_service_id`,`pr_number`,`created_at`,`updated_at`,
	`compose_content`,`environment_id`,`auto_update`,`auto_update_digest`,
	`cpu_limit_milli`,`replicas`,`runtime_replicas`
) SELECT
	`id`,`owner_user_id`,`name`,`slug`,`type`,`status`,`repo_url`,`branch`,`commit_sha`,
	`source_id`,`image`,`volume_mount`,`port`,`published_port`,`health_path`,`runtime_id`,
	`cpu_shares`,`mem_limit_mb`,`cmd`,`docker_socket`,`template_id`,`template_database_env`,
	`server_id`,`compose_service`,`preview_deployments_enabled`,`preview_auto_destroy_on_close`,
	`preview_domain_pattern`,`preview_max_active`,`is_ephemeral_preview`,
	`preview_parent_service_id`,`pr_number`,`created_at`,`updated_at`,
	`compose_content`,`environment_id`,`auto_update`,`auto_update_digest`,
	`cpu_limit_milli`,`replicas`,`runtime_replicas`
FROM `services`;
--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`)
SELECT '__new_services', `seq` FROM `sqlite_sequence` WHERE `name` = 'services'
AND NOT EXISTS (SELECT 1 FROM `sqlite_sequence` WHERE `name` = '__new_services');
--> statement-breakpoint
UPDATE `sqlite_sequence`
SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'services'), 0))
WHERE `name` = '__new_services';
--> statement-breakpoint
DROP TABLE `services`;
--> statement-breakpoint
ALTER TABLE `__new_services` RENAME TO `services`;
--> statement-breakpoint
CREATE UNIQUE INDEX `services_slug_unique` ON `services` (`slug`);
--> statement-breakpoint
CREATE INDEX `services_server_idx` ON `services` (`server_id`);
--> statement-breakpoint
CREATE TABLE `__new_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`database_id` integer REFERENCES databases(id) ON UPDATE no action ON DELETE cascade,
	`volume_name` text,
	`scope` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`path` text NOT NULL,
	`remote_key` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`label` text,
	`destination_id` integer REFERENCES backup_destinations(id) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_backups` (
	`id`,`database_id`,`volume_name`,`scope`,`status`,`path`,`remote_key`,`size_bytes`,
	`created_at`,`label`,`destination_id`
) SELECT
	`id`,`database_id`,`volume_name`,`scope`,`status`,`path`,`remote_key`,`size_bytes`,
	`created_at`,`label`,`destination_id`
FROM `backups`;
--> statement-breakpoint
INSERT INTO `sqlite_sequence` (`name`, `seq`)
SELECT '__new_backups', `seq` FROM `sqlite_sequence` WHERE `name` = 'backups'
AND NOT EXISTS (SELECT 1 FROM `sqlite_sequence` WHERE `name` = '__new_backups');
--> statement-breakpoint
UPDATE `sqlite_sequence`
SET `seq` = MAX(`seq`, COALESCE((SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'backups'), 0))
WHERE `name` = '__new_backups';
--> statement-breakpoint
DROP TABLE `backups`;
--> statement-breakpoint
ALTER TABLE `__new_backups` RENAME TO `backups`;
--> statement-breakpoint
CREATE INDEX `backups_db_status_idx` ON `backups` (`database_id`,`status`);
--> statement-breakpoint
CREATE INDEX `backups_volume_created_idx` ON `backups` (`volume_name`,`created_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
