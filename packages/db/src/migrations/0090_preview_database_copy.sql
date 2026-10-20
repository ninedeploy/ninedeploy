-- 0.16.12 a database copy per PR preview. Additive only: two nullable columns
-- on databases (NULL on every existing one) and an off-by-default switch on
-- services, so no preview gets a copy after the upgrade. drizzle-kit writes
-- ADD ... REFERENCES without the ON DELETE rule; it is spelled out here as
-- schema.ts declares it (SQLite allows the clause on ADD COLUMN because the
-- columns default to NULL).
ALTER TABLE `databases` ADD `preview_copy_of` integer REFERENCES databases(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `databases` ADD `preview_service_id` integer REFERENCES services(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `services` ADD `preview_database_copy` integer DEFAULT false NOT NULL;
