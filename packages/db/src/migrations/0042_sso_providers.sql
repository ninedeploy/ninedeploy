-- Sprint 5 G-22: SSO providers table.
--
-- One row per configured OIDC or SAML provider. The `config_json`
-- blob carries the issuer URL, client id / secret, SAML metadata
-- URL, and any provider-specific knobs. The driver never logs
-- the secret fields.
--
-- IF NOT EXISTS throughout: an instance whose schema was created by
-- `drizzle-kit push` may already have the table; applying this must be
-- a no-op there rather than aborting startup. Mirrors the rationale
-- in `0039_log_drains.sql`, `0040_cache_registry_blobs.sql`, and
-- `0041_swarm_stacks.sql`.
CREATE TABLE IF NOT EXISTS `sso_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sso_providers_name_idx` ON `sso_providers` (`name`);
