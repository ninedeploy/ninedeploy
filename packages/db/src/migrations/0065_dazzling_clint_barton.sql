-- r399: one row per agent endpoint + a ts-leading index for the metrics
-- retention sweep.
--
-- Re-running SSH bootstrap for an existing node used to INSERT a second row
-- for the same (host, port): the fresh row's agent token silently
-- invalidated the old row's, and the old row kept saying `online` while
-- every agentOp targeting it failed auth. Before the unique index can be
-- created, existing duplicates are repaired: every service and fan-out
-- target is re-pointed at the NEWEST row for its endpoint (the one whose
-- token the running agent actually holds), and the stale older rows are
-- deleted.
UPDATE `services`
SET `server_id` = (
  SELECT MAX(s2.id) FROM `servers` s2
  WHERE s2.host = (SELECT s3.host FROM `servers` s3 WHERE s3.id = `services`.`server_id`)
    AND s2.port = (SELECT s3.port FROM `servers` s3 WHERE s3.id = `services`.`server_id`)
)
WHERE `server_id` IS NOT NULL
  AND `server_id` NOT IN (SELECT MAX(id) FROM `servers` GROUP BY `host`, `port`);
--> statement-breakpoint
UPDATE `service_targets`
SET `server_id` = (
  SELECT MAX(s2.id) FROM `servers` s2
  WHERE s2.host = (SELECT s3.host FROM `servers` s3 WHERE s3.id = `service_targets`.`server_id`)
    AND s2.port = (SELECT s3.port FROM `servers` s3 WHERE s3.id = `service_targets`.`server_id`)
)
WHERE `server_id` NOT IN (SELECT MAX(id) FROM `servers` GROUP BY `host`, `port`);
--> statement-breakpoint
DELETE FROM `servers`
WHERE `id` NOT IN (SELECT MAX(id) FROM `servers` GROUP BY `host`, `port`);
--> statement-breakpoint
CREATE INDEX `metrics_ts_idx` ON `metrics` (`ts`);--> statement-breakpoint
CREATE UNIQUE INDEX `servers_host_port_unique` ON `servers` (`host`,`port`);
