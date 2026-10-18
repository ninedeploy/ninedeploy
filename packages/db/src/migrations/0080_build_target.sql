-- Additive only: one nullable column. Null builds the Dockerfile's last stage,
-- exactly as every build did before.
ALTER TABLE `build_configs` ADD `build_target` text;