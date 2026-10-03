-- Human-friendly names for volume snapshots. `volumeBackups.ts` has always
-- embedded a label in the tar.gz FILENAME ('manual', 'schedule-YYYY-MM-DD'),
-- but the backups row itself carried no copy, so the panel could only show a
-- bare timestamp for volume-scope rows while database rows displayed their
-- database name. This nullable column persists the label so the Backups page
-- and the per-volume panel can name each snapshot.
ALTER TABLE `backups` ADD `label` text;