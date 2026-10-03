-- Inline compose stacks: persist the compose YAML on the service row.
--
-- Until now the only copy of a compose stack's definition was the file written
-- into `<reposDir>/<serviceId>/docker-compose.yml` at install time
-- (composeStacks.ts). Nothing ever wrote it back, so a wiped workspace, a
-- restored host or an exported/imported service left a `type: 'compose'` row
-- whose stack could never be brought up again. The column makes the database
-- the source of truth; the pipeline re-materialises the file before every
-- deploy. NULL for git-repo compose services, whose YAML lives in the repo.
ALTER TABLE `services` ADD `compose_content` text;
