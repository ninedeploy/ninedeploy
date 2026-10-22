ALTER TABLE `deployments` ADD `ci_gate` text;--> statement-breakpoint
ALTER TABLE `service_github_links` ADD `required_workflows` text DEFAULT '[]' NOT NULL;