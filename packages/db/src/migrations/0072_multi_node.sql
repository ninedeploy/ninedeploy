-- 0.16 multi-node (released in the 0.15.x series). Additive only: one new
-- table, nullable or defaulted columns, and indexes. No table rebuild and no
-- row rewrite, so a rollback to 0.15 still boots and reads every row.
--
-- Hand edit (r300): drizzle-kit drops the ON DELETE rule from
-- `ALTER TABLE … ADD … REFERENCES`, so the SET NULL rule `schema.ts`
-- declares for backups.server_id, services.build_server_id and
-- services.push_registry_source_id is written out below. SQLite accepts a
-- REFERENCES clause on ADD COLUMN because the column defaults to NULL.
-- databases.server_id keeps NO ACTION on purpose: a server that hosts a
-- database cannot be deleted (design §5.2).
--
-- Rollback marker (design §5.8): a node database row stores container_name
-- and volume_name as NULL and its real names in node_container_name /
-- node_volume_name, so 0.15 refuses every local action on it.
CREATE TABLE `image_transfers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deployment_id` integer,
	`service_id` integer NOT NULL,
	`source_server_id` integer,
	`target_server_id` integer,
	`method` text NOT NULL,
	`image_ref` text NOT NULL,
	`image_id` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `image_transfers_service_started_idx` ON `image_transfers` (`service_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `image_transfers_deployment_idx` ON `image_transfers` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `image_transfers_started_idx` ON `image_transfers` (`started_at`);--> statement-breakpoint
ALTER TABLE `backups` ADD `server_id` integer REFERENCES servers(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `databases` ADD `server_id` integer REFERENCES servers(id);--> statement-breakpoint
ALTER TABLE `databases` ADD `node_container_name` text;--> statement-breakpoint
ALTER TABLE `databases` ADD `node_volume_name` text;--> statement-breakpoint
CREATE INDEX `databases_server_idx` ON `databases` (`server_id`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `build_host` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `image_id` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_version` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_caps` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `agent_checked_at` integer;--> statement-breakpoint
ALTER TABLE `servers` ADD `is_build_server` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `build_concurrency` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `servers` ADD `swarm_node_id` text;--> statement-breakpoint
ALTER TABLE `servers` ADD `swarm_role` text;--> statement-breakpoint
ALTER TABLE `services` ADD `build_on` text;--> statement-breakpoint
ALTER TABLE `services` ADD `build_server_id` integer REFERENCES servers(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `services` ADD `push_registry_source_id` integer REFERENCES sources(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `services` ADD `push_repository` text;--> statement-breakpoint
ALTER TABLE `services` ADD `orchestrator` text;--> statement-breakpoint
CREATE INDEX `services_build_server_idx` ON `services` (`build_server_id`);--> statement-breakpoint
ALTER TABLE `sources` ADD `allow_on_nodes` integer DEFAULT false NOT NULL;