CREATE TABLE `node_proxy_write_heads` (
	`server_id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`request_id` text NOT NULL,
	`content_hash` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
