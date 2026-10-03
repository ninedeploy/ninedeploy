-- Instance-operator flag: separate "runs this box" from "admin of some team".
--
-- Before this migration, `isOperator` was computed as "holds owner/admin in at
-- least one workspace" (lib/resourceAccess.ts). Because POST /v1/workspaces has
-- no role gate and inserts the caller as `owner` — and GET /v1/workspaces even
-- auto-creates an owned workspace for a user with no memberships — ANY
-- authenticated user could promote themselves to full instance operator with a
-- single request. That flag gates the host-privilege boundary
-- (lib/hostPrivilege.ts): PM2 services, compose deploys, deploy lifecycle hooks
-- and docker-socket templates all execute code on the HOST, so the escalation
-- was a path from "member" to host code execution.
--
-- The flag now lives on the user row and is granted only at bootstrap or by an
-- existing operator. Workspace roles stay workspace-scoped.
ALTER TABLE `users` ADD `is_instance_operator` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill for existing installs. Two deliberately narrow sources:
--
--   1. The bootstrap user (lowest id) — whoever ran the first-run setup. This
--      guarantees the instance is never left with zero operators.
--   2. Owners/admins of the OLDEST workspace — the original team, created at
--      bootstrap.
--
-- Anyone who became "operator" by creating their own workspace (a higher
-- workspace id) is deliberately NOT backfilled: that is the escalation this
-- migration closes. An operator can re-grant the flag from Settings → Users.
UPDATE `users`
   SET `is_instance_operator` = true
 WHERE `id` = (SELECT MIN(`id`) FROM `users`);
--> statement-breakpoint
UPDATE `users`
   SET `is_instance_operator` = true
 WHERE `id` IN (
   SELECT `user_id` FROM `workspace_members`
    WHERE `workspace_id` = (SELECT MIN(`id`) FROM `workspaces`)
      AND `role` IN ('owner', 'admin')
 );
