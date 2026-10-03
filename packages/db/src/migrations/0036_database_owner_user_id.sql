-- Add the `owner_user_id` column to `databases` that the Drizzle schema
-- (and 0031_snapshot.json) already declare, but that no prior migration
-- actually added to the SQL. Any `db.insert(databases)` / `db.query.databases.*`
-- path that was generated from the schema would fail at runtime with
-- `table databases has no column named owner_user_id`. This migration brings
-- the live schema in sync with the snapshot.
--
-- The shape mirrors the equivalent `services.owner_user_id` migration (0021):
-- nullable, references `users(id)`, indexed for the workspace-scoped lookups
-- the panel runs when listing a user's databases.
ALTER TABLE `databases` ADD `owner_user_id` integer REFERENCES users(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `databases_owner_user_idx` ON `databases` (`owner_user_id`);
