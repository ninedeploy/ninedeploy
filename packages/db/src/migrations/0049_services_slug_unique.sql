-- Global uniqueness for `services.slug` — restored.
--
-- The slug mints LIVE container, volume and Traefik router names
-- (`nd-svc-<slug>`), so two rows sharing a slug is a collision at the Docker
-- layer (failed deploys, or one service adopting the other's volume), not a
-- cosmetic issue. Migration 0034 dropped the old (project_id, slug) unique
-- because projects went N-N and per-project uniqueness lost its anchor;
-- GLOBAL uniqueness is the actual invariant and moves back here. The
-- application layer keeps its friendlier duplicate checks (services.ts
-- answers with a 409-shaped slug_taken long before the index is consulted)
-- — this index is the backstop for the check-then-insert race.
--
-- The pre-index dedup repairs rows created through that racy check: all but
-- the OLDEST row per slug get `-dup<id>` appended. Renaming the intruder
-- (never the original) is deliberate — the oldest row owns the volume and
-- container names the duplicates were fighting over. `<id>` keeps renamed
-- rows distinct from each other; the correlated subquery also sees earlier
-- renames, so a chain of dups and renamed-to names resolves consistently. A
-- residual collision with a pre-existing literal `…-dup<id>` slug is
-- vanishingly unlikely and fails LOUDLY (the index creation errors and the
-- migrator halts) instead of silently minting ambiguous names.
UPDATE `services`
   SET `slug` = `slug` || '-dup' || `id`
 WHERE EXISTS (
   SELECT 1 FROM `services` AS s2
    WHERE s2.`slug` = `services`.`slug` AND s2.`id` < `services`.`id`
 );
--> statement-breakpoint
CREATE UNIQUE INDEX `services_slug_unique` ON `services` (`slug`);
