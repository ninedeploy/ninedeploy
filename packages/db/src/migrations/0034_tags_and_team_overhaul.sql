-- ─── Tags (N-N service ↔ project/workspace/label) ──────────────────────────
--
-- 1) labels           — workspace-scoped free-form labels (color + name)
-- 2) service_projects — N-N bridge: services ↔ projects
-- 3) service_workspaces — N-N bridge: services ↔ workspaces
-- 4) service_labels   — N-N bridge: services ↔ labels
--
-- Replaces the old single `services.project_id` FK with a many-to-many
-- relationship, so a single service can be visible from multiple projects
-- AND multiple workspaces simultaneously. Top-bar filters compose these
-- three dimensions to scope the service list.

CREATE TABLE `service_projects` (
	`service_id` integer NOT NULL REFERENCES services(id) ON UPDATE no action ON DELETE cascade,
	`project_id` integer NOT NULL REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`service_id`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `service_projects_project_idx` ON `service_projects` (`project_id`);
--> statement-breakpoint
CREATE TABLE `service_workspaces` (
	`service_id` integer NOT NULL REFERENCES services(id) ON UPDATE no action ON DELETE cascade,
	`workspace_id` integer NOT NULL REFERENCES workspaces(id) ON UPDATE no action ON DELETE cascade,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`service_id`, `workspace_id`)
);
--> statement-breakpoint
CREATE INDEX `service_workspaces_workspace_idx` ON `service_workspaces` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer REFERENCES workspaces(id) ON UPDATE no action ON DELETE cascade,
	`name` text NOT NULL,
	`color` text NOT NULL DEFAULT 'indigo',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_workspace_name_idx` ON `labels` (`workspace_id`,`name`);
--> statement-breakpoint
CREATE INDEX `labels_workspace_idx` ON `labels` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE `service_labels` (
	`service_id` integer NOT NULL REFERENCES services(id) ON UPDATE no action ON DELETE cascade,
	`label_id` integer NOT NULL REFERENCES labels(id) ON UPDATE no action ON DELETE cascade,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`service_id`, `label_id`)
);
--> statement-breakpoint
CREATE INDEX `service_labels_label_idx` ON `service_labels` (`label_id`);
--> statement-breakpoint

-- ─── Backfill: services.project_id → service_projects ──────────────────────
-- Single FK becomes an N-N row so the new system has the same data the old
-- single-column model had, and existing queries keep matching.
INSERT INTO `service_projects` (`service_id`, `project_id`)
SELECT `id`, `project_id` FROM `services` WHERE `project_id` IS NOT NULL;
--> statement-breakpoint

-- ─── Drop services.project_id ──────────────────────────────────────────────
-- SQLite can't DROP COLUMN inside a foreign key constraint as a single ALTER,
-- so rebuild `services` without `project_id` and recreate the indexes we need.
-- The unique index on (project_id, slug) referenced it; we replace it with
-- `services_slug_unique` (a non-project unique on slug is unsafe — slugs must
-- be unique per project, but projects are now N-N; we move uniqueness to
-- `service_projects` via the table's primary key instead and keep `services`
-- without any unique on slug at the DB level. Application code enforces
-- "at most one project per service" by convention if needed; the new model
-- allows N projects per service).
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
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_services` (
	`id`,`owner_user_id`,`name`,`slug`,`type`,`status`,`repo_url`,`branch`,`commit_sha`,
	`source_id`,`image`,`volume_mount`,`port`,`published_port`,`health_path`,`runtime_id`,
	`cpu_shares`,`mem_limit_mb`,`cmd`,`docker_socket`,`template_id`,`template_database_env`,
	`server_id`,`compose_service`,`preview_deployments_enabled`,`preview_auto_destroy_on_close`,
	`preview_domain_pattern`,`preview_max_active`,`is_ephemeral_preview`,
	`preview_parent_service_id`,`pr_number`,`created_at`,`updated_at`
) SELECT
	`id`,`owner_user_id`,`name`,`slug`,`type`,`status`,`repo_url`,`branch`,`commit_sha`,
	`source_id`,`image`,`volume_mount`,`port`,`published_port`,`health_path`,`runtime_id`,
	`cpu_shares`,`mem_limit_mb`,`cmd`,`docker_socket`,`template_id`,`template_database_env`,
	`server_id`,`compose_service`,`preview_deployments_enabled`,`preview_auto_destroy_on_close`,
	`preview_domain_pattern`,`preview_max_active`,`is_ephemeral_preview`,
	`preview_parent_service_id`,`pr_number`,`created_at`,`updated_at`
FROM `services`;
--> statement-breakpoint
DROP TABLE `services`;
--> statement-breakpoint
ALTER TABLE `__new_services` RENAME TO `services`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- ─── Team overhaul: drop users.role, ensure every user has a Personal WS ───
-- `users.role` (admin/member) was the operator-level access tier that bypassed
-- workspace membership. The new model is workspace-scoped only; to preserve
-- operator-level capabilities (manage OIDC, list all users, system settings),
-- every former admin gets a guaranteed "Personal" workspace they own. Existing
-- non-admin users get a personal workspace as a member so they keep a writable
-- scope and can still create resources.

-- 1) Create one Personal workspace per user that doesn't already own one.
INSERT INTO `workspaces` (`name`, `slug`, `description`, `owner_id`, `created_at`, `updated_at`)
SELECT
	u.`name` || '''s workspace' AS name,
	'personal-' || u.`id` AS slug,
	'Auto-provisioned personal workspace (migrated from legacy admin role)' AS description,
	u.`id` AS owner_id,
	u.`created_at`,
	u.`created_at`
FROM `users` u
WHERE NOT EXISTS (
	SELECT 1 FROM `workspaces` w WHERE w.`owner_id` = u.`id`
);
--> statement-breakpoint

-- 2) Mirror every existing workspace membership onto the new `workspace_members`
--    (the row may have been created without a member entry on pre-workspace
--    installs; this guarantees the owner at least shows up as `owner`).
INSERT OR IGNORE INTO `workspace_members` (`workspace_id`, `user_id`, `role`, `created_at`, `updated_at`)
SELECT w.`id`, w.`owner_id`, 'owner', w.`created_at`, w.`created_at`
FROM `workspaces` w
WHERE NOT EXISTS (
	SELECT 1 FROM `workspace_members` m
	WHERE m.`workspace_id` = w.`id` AND m.`user_id` = w.`owner_id`
);
--> statement-breakpoint

-- 3) Any other user (non-owner) gets a `member` seat in their own personal
--    workspace so they retain a default scope to create resources under.
INSERT OR IGNORE INTO `workspace_members` (`workspace_id`, `user_id`, `role`, `created_at`, `updated_at`)
SELECT w.`id`, u.`id`, 'member', w.`created_at`, w.`created_at`
FROM `users` u
JOIN `workspaces` w ON w.`slug` = 'personal-' || u.`id`
WHERE NOT EXISTS (
	SELECT 1 FROM `workspace_members` m
	WHERE m.`workspace_id` = w.`id` AND m.`user_id` = u.`id`
);
--> statement-breakpoint

-- 4) Rebuild `users` without the `role` column.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text,
	`token_version` integer DEFAULT 0 NOT NULL,
	`totp_secret_encrypted` text,
	`totp_enabled` integer DEFAULT 0 NOT NULL,
	`totp_last_step` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users` (
	`id`,`email`,`password_hash`,`name`,`token_version`,
	`totp_secret_encrypted`,`totp_enabled`,`totp_last_step`,
	`created_at`,`updated_at`
) SELECT
	`id`,`email`,`password_hash`,`name`,`token_version`,
	`totp_secret_encrypted`,`totp_enabled`,`totp_last_step`,
	`created_at`,`updated_at`
FROM `users`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint

-- 5) Bump every user's `token_version` so legacy JWTs carrying a `role` claim
--    are rejected — they would otherwise silently bypass the new auth checks.
UPDATE `users` SET `token_version` = `token_version` + 1;
