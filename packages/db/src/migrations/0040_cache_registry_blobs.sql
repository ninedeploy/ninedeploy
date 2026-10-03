-- Sprint 4 G-01 PR-C: durable layer-blob cache backed by an OCI registry.
--
-- The `cache_registry_blobs` table records one row per (key, backend, repo)
-- triple. The actual blob bytes live in the registry itself (a single
-- tag pointing at a tiny manifest); the row carries the digest + size
-- + last-hit timestamp so the operator UI can render hit rate and
-- retention can drop cold rows.
--
-- IF NOT EXISTS throughout: an instance whose schema was created by
-- `drizzle-kit push` may already have the table; applying this must be
-- a no-op there rather than aborting startup. Mirrors the rationale
-- in `0039_log_drains.sql`.
CREATE TABLE IF NOT EXISTS `cache_registry_blobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`backend` text NOT NULL,
	`repo` text NOT NULL,
	`digest` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`stored_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_hit_at` integer DEFAULT (unixepoch()) NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `cache_registry_blobs_key_idx` ON `cache_registry_blobs` (`key`, `backend`, `repo`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cache_registry_blobs_last_hit_idx` ON `cache_registry_blobs` (`last_hit_at`);
