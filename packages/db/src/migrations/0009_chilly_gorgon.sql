DROP INDEX `api_tokens_user_idx`;--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);