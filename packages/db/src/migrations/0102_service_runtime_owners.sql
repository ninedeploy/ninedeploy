CREATE TABLE `service_runtime_owners` (
	`service_id` integer PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL,
	`request_id` text,
	`kind` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `service_runtime_owners` (`service_id`, `epoch`, `request_id`, `kind`)
SELECT s.id,
  COALESCE((SELECT seq FROM sqlite_sequence WHERE name='node_lifecycle_intents'), 0),
  (SELECT i.request_id FROM node_lifecycle_intents i WHERE i.service_id=s.id AND i.phase NOT IN ('completed','superseded') ORDER BY i.id DESC LIMIT 1),
  COALESCE((SELECT i.action FROM node_lifecycle_intents i WHERE i.service_id=s.id AND i.phase NOT IN ('completed','superseded') ORDER BY i.id DESC LIMIT 1), 'legacy')
FROM services s;
--> statement-breakpoint
UPDATE `node_lifecycle_intents`
SET snapshot=json_set(snapshot, '$.mutationEpoch', (SELECT epoch FROM service_runtime_owners o WHERE o.service_id=node_lifecycle_intents.service_id))
WHERE phase NOT IN ('completed','superseded') AND CASE WHEN json_valid(snapshot) THEN json_type(snapshot)='object' ELSE 0 END;
