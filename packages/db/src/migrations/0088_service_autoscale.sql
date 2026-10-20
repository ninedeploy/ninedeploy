-- 0.16.10 autoscaling. Additive only: one nullable column, null on every
-- existing service, so each keeps running `replicas` containers as before.
ALTER TABLE `services` ADD `autoscale` text;
