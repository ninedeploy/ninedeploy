CREATE TABLE `database_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`database_id` integer NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`format` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`received_bytes` integer DEFAULT 0 NOT NULL,
	`chunk_size` integer DEFAULT 0 NOT NULL,
	`sha256` text,
	`filename` text,
	`staging_path` text,
	`destination_id` integer,
	`object_key` text,
	`options` text DEFAULT '{}' NOT NULL,
	`safety_backup_id` integer,
	`error` text,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `backup_destinations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`safety_backup_id`) REFERENCES `backups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `database_imports_db_created_idx` ON `database_imports` (`database_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `database_imports_status_idx` ON `database_imports` (`status`);--> statement-breakpoint
CREATE TABLE `database_public_access` (
	`database_id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`public_port` integer NOT NULL,
	`tls_mode` text DEFAULT 'none' NOT NULL,
	`tls_hostname` text,
	`ip_allowlist` text DEFAULT '[]' NOT NULL,
	`container_name` text,
	`applied_at` integer,
	`last_error` text,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`database_id`) REFERENCES `databases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `database_public_access_port_idx` ON `database_public_access` (`public_port`);--> statement-breakpoint
CREATE TABLE `secret_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`credential_encrypted` text NOT NULL,
	`last_tested_at` integer,
	`last_test_error` text,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_providers_kind_idx` ON `secret_providers` (`kind`);--> statement-breakpoint
CREATE TABLE `tls_certificates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cert_pem` text NOT NULL,
	`key_encrypted` text NOT NULL,
	`hostnames` text DEFAULT '[]' NOT NULL,
	`fingerprint_sha256` text NOT NULL,
	`subject` text,
	`issuer` text,
	`not_before` integer NOT NULL,
	`not_after` integer NOT NULL,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tls_certificates_fingerprint_idx` ON `tls_certificates` (`fingerprint_sha256`);