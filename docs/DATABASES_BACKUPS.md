# Managed Databases & Backups

NineDeploy provides provisioning and lifecycle management for databases, encrypted database dumps, and attached-volume snapshots with offsite cloud storage.

---

## 🗄️ 1. Supported Managed Databases

| Engine | Version / Flavor | Features |
| :--- | :--- | :--- |
| **PostgreSQL** | 16 / 17 + `pgvector` | Full ACID, vector embeddings, relational indexing |
| **MySQL** | 8.0 / 8.4 LTS | High throughput, InnoDB storage |
| **MariaDB** | 11.4 LTS | Community SQL server with columnar support |
| **Redis / Valkey** | 7.x | Low-latency in-memory caching and message pub/sub |
| **MongoDB** | 7.0 Community | Document-oriented NoSQL database |
| **ClickHouse** | Latest | High-performance columnar analytics |
| **Meilisearch** | Latest | Lightning-fast full-text search engine |
| **RabbitMQ** | 3.13 Management | Enterprise message broker with AMQP |

---

## 🔗 2. Connection String Auto-Injection

- When a database is provisioned, NineDeploy generates cryptographically strong random credentials.
- In-memory linkers automatically inject environment variables into linked application services:
  - `DATABASE_URL` (e.g. `postgresql://user:pass@srv-postgres:5432/main`)
  - `REDIS_URL` (e.g. `redis://:pass@srv-redis:6379`)

---

## ☁️ 3. Offsite Backup Destinations

Automated backup jobs upload backups to S3-compatible cloud storage. Database dumps use streaming AES-256-GCM encryption:
- **Amazon S3 / AWS GovCloud**
- **Cloudflare R2** (Zero egress fees)
- **MinIO / Self-Hosted S3**
- **Wasabi / DigitalOcean Spaces**

The same destination stores attached-volume snapshots as `tar.gz` archives encrypted with the same streaming AES-256-GCM envelope as database dumps; downloads and restores decrypt transparently, and legacy plaintext archives written before encryption keep restoring unchanged. Snapshots taken before the encryption change remain plaintext on disk until they age out of retention — restrict access to the backup directory and bucket accordingly. Each uploaded backup records which destination holds its object, so switching the active destination does not orphan earlier recovery points — restores and remote deletions resolve the bucket that actually holds the object (rows whose destination was deleted fall back to the active one).

Retention counts completed recovery points separately from failed attempts and leaves running backups untouched. Failed attempts cannot evict the last successful backups.

Without a backup policy (below), the scheduler backs each running database up once a day and keeps the seven newest completed scheduled dumps. A dump that falls out of that window is removed together with its remote copy: the remote object is deleted first, through the destination its record names, and the record only once that delete succeeded. A record whose destination is unknown or unreachable is kept and retried on a later run, at most 100 remote deletes per run (or two per database, if that is more).

---

## 🗓️ 3a. Per-database backup policy

Each database can have its own **Backup schedule** (Database → Backups tab, `ninedeploy databases backup-policy`, or `GET`/`PUT /v1/databases/:id/backup-policy`):

| Field | Meaning |
| :--- | :--- |
| `enabled` | `false` turns scheduled backups off for this database. Manual snapshots still work. |
| `cron` | A 5-field cron expression (`minute hour day month weekday`) in the server's local time, checked with the same rule as scheduled jobs. A 6-field (seconds) pattern is refused. The UI offers daily (`0 3 * * *`), every 6 hours (`0 */6 * * *`) and weekly (`0 3 * * 0`). |
| `retainCount` | Completed scheduled dumps kept on the panel host, 1–365. |
| `retainRemoteCount` | Optional, 1–365. Off-site copies kept, counted over the dumps that actually have one. If you leave it out, a dump's remote copy is removed with the dump (the built-in rule). If it is higher than `retainCount`, older dumps stay restorable from the bucket after their local file is pruned. If it is lower, newer dumps keep their local file and lose only the remote copy. |
| `destinationId` | Optional. A specific backup destination for this database's scheduled dumps. Leave it out to use the active destination. Only an instance operator can choose a specific destination, because destinations are managed by operators. If that destination is deleted, the policy falls back to the active one. |
| `localOnly` | `true` keeps this database's scheduled dumps on the panel host only. It cannot be combined with `destinationId` or `retainRemoteCount`. |

- **Upgrades change nothing.** Policies live in their own table (`database_backup_policies`, migration 0067). A database with no policy row keeps the built-in schedule exactly: daily, seven kept, the active destination. `GET` reports such a database as `configured: false`.
- **Authorization:** reading a policy follows the database (the same as listing its backups). Saving one needs `admin` on the database, the same as taking a backup. Every save is audited as `backup.policy.update`.
- **Applied at once:** saving a policy re-arms that database's schedule immediately. The scheduler also resyncs every 15 minutes. A policy database is skipped by the built-in daily run.
- **Retention safety:** the newest completed dump, and the newest remote copy, are never pruned (both counts are at least 1). Failed attempts are bounded separately (seven kept) and can never evict a completed dump. Manual snapshots and running operations are never touched. A dump file still referenced by a kept record is never unlinked.
- **Missed-backup alert:** a database with a policy is judged against its own cadence (twice its interval, and never less than two days). A disabled policy is exempt.
- **Scope:** the policy governs **scheduled** dumps. "Backup now" still uploads to the active destination, and manual snapshots are only removed by hand.

---

## 💾 4. Volume Snapshots & Labels

Each managed Docker volume can be snapshotted (`tar.gz`), restored or downloaded from the Volumes tab:

- **Labels**: manual snapshots accept an optional operator label (up to 40 chars, defaulting to `manual`); scheduled runs are labeled `schedule-YYYY-MM-DD`. Labels surface on the Backups page so a mixed database/volume list stays readable.
- **Scheduling**: a recurring job can sweep multiple volumes in one pass, reusing the backup destination for off-site copies.
- **Safe restore**: restores refuse to run while a service is still live on that volume.

---

## 🛡️ 5. Restore Safety

- Restores can be initiated via Web UI or CLI (`ninedeploy backups restore <databaseId> <backupId>`).
- Volume restores first check that the archive can be listed, then extract the whole archive into a hidden staging directory inside the volume and swap it into place with same-filesystem renames. Corrupt archives and extraction failures (including a full disk) abort before any existing data is touched; the transient staging copy means the volume needs space for both the old and the restored contents during a restore.
- Database operations use separate staging files. Failed decryption removes partial plaintext instead of retaining an unauthenticated dump on disk.
- Backup and restore operations hold a cross-process lock file (under `op-locks/` in the data directory), so an overlapping panel process — a systemd restart overlap or a second instance on the same data directory — cannot interleave a backup with a restore on the same database or volume; a busy lock answers 409, and a lock abandoned by a crashed process is reclaimed after its heartbeat goes stale.
