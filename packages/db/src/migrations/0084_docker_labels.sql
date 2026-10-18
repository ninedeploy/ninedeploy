-- Additive only: one nullable column. Every container keeps exactly the
-- labels it had (the panel's own).
ALTER TABLE `services` ADD `docker_labels` text;