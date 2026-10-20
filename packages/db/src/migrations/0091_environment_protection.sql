-- 0.16.13 protected lanes and deploy approvals. Additive only: two
-- off-by-default switches on environments (no lane is protected or gated
-- after the upgrade) and two nullable columns on deployments (NULL on every
-- existing row). drizzle-kit writes ADD ... REFERENCES without the ON DELETE
-- rule; it is spelled out here as schema.ts declares it.
ALTER TABLE `deployments` ADD `reviewed_by` integer REFERENCES users(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `deployments` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `environments` ADD `protected` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `environments` ADD `require_approval` integer DEFAULT false NOT NULL;