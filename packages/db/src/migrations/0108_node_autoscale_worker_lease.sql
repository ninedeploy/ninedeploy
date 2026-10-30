ALTER TABLE `node_autoscale_transitions` ADD `worker_token` text;--> statement-breakpoint
ALTER TABLE `node_autoscale_transitions` ADD `lease_until` integer;