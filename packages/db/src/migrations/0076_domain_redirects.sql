-- 0.16.1, additive only: a nullable JSON column; no domain has redirect rules
-- until someone adds them, so every router renders exactly as before.
ALTER TABLE `domains` ADD `redirects` text;