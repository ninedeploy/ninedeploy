-- Per-service owner (RBAC). The owning user — or any admin — may manage a
-- service; everyone else is denied at the route layer. See
-- apps/server/src/lib/serviceAccess.ts for the gate.
--
-- The column is nullable: legacy rows (created before this migration) are
-- backfilled below with the first admin's id, so the migration is idempotent
-- and the runtime gate can treat NULL as "fall back to admin-only".
ALTER TABLE `services` ADD `owner_user_id` integer REFERENCES users(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `services_owner_user_idx` ON `services` (`owner_user_id`);--> statement-breakpoint
-- Backfill: any row with NULL owner gets the lowest-id admin. Multi-admin
-- installs keep each service assigned to the first admin — strict, but a
-- safe default. Admins can reassign via the API (PATCH /v1/services/:id,
-- `ownerUserId`) once the web exposes the picker.
UPDATE `services`
SET `owner_user_id` = (SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1)
WHERE `owner_user_id` IS NULL;
