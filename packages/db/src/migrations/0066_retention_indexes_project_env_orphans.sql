-- r541: delete the shared env vars (secrets included) of projects that no
-- longer exist. scope='project' rows name their project only through
-- `scope_key` — there is no foreign key — so deleting a project (directly, or
-- through its workspace's cascade) left every one of them behind, encrypted
-- values and all, in the database and in every backup of it. The routes now
-- delete them with the project; this removes the ones already orphaned.
-- `scope_key` and `projects.id` are both INTEGER, so NOT IN compares like
-- with like; `projects.id` is a NOT NULL primary key, so the subquery never
-- yields the NULL that would make NOT IN match nothing.
DELETE FROM `env_vars`
WHERE `scope` = 'project'
  AND `scope_key` NOT IN (SELECT `id` FROM `projects`);
--> statement-breakpoint
-- r545: indexes for the hourly housekeeping deletes, which filter on a
-- timestamp alone and so full-scanned each table every hour (the existing
-- indexes lead with entity / channel / job / service). IF NOT EXISTS keeps a
-- re-run harmless.
CREATE INDEX IF NOT EXISTS `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deployments_created_idx` ON `deployments` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `job_runs_created_idx` ON `job_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notification_log_ts_idx` ON `notification_log` (`ts`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_revoked_idx` ON `sessions` (`revoked_at`);
