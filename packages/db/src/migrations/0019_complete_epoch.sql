CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`jti` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_jti_unique` ON `sessions` (`jti`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `webauthn_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_credentials_credential_id_unique` ON `webauthn_credentials` (`credential_id`);--> statement-breakpoint
CREATE INDEX `webauthn_credentials_user_idx` ON `webauthn_credentials` (`user_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_env_vars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`service_id` integer,
	`scope` text DEFAULT 'service' NOT NULL,
	`scope_key` integer DEFAULT 0 NOT NULL,
	`key` text NOT NULL,
	`value_encrypted` text NOT NULL,
	`is_secret` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_env_vars`("id", "service_id", "scope", "scope_key", "key", "value_encrypted", "is_secret", "created_at", "updated_at") SELECT "id", "service_id", 'service', "service_id", "key", "value_encrypted", "is_secret", "created_at", "updated_at" FROM `env_vars`;--> statement-breakpoint
DROP TABLE `env_vars`;--> statement-breakpoint
ALTER TABLE `__new_env_vars` RENAME TO `env_vars`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `env_vars_service_key_idx` ON `env_vars` (`service_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `env_vars_scope_key_idx` ON `env_vars` (`scope`,`scope_key`,`key`);--> statement-breakpoint
ALTER TABLE `build_configs` ADD `restart_policy` text DEFAULT 'unless-stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE `build_configs` ADD `stop_grace_seconds` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `deployments` ADD `config_snapshot` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `dns_record_id` text;