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

The same destination stores attached-volume snapshots as `tar.gz` archives encrypted with the same streaming AES-256-GCM envelope as database dumps; downloads and restores decrypt transparently, and legacy plaintext archives written before encryption keep restoring unchanged. Snapshots taken before the encryption change remain plaintext on disk until they age out of retention — restrict access to the backup directory and bucket accordingly.

Retention counts completed recovery points separately from failed attempts and leaves running backups untouched. Failed attempts cannot evict the last successful backups.

The daily database scheduler retains seven completed local dumps. Older remote copies keep their database records so they remain discoverable after local files are pruned; configure bucket lifecycle rules for remote retention. Backup records currently use the active destination for remote retrieval, so migrate existing objects before changing that destination.

---

## 💾 4. Volume Snapshots & Labels

Each managed Docker volume can be snapshotted (`tar.gz`), restored or downloaded from the Volumes tab:

- **Labels**: manual snapshots accept an optional operator label (up to 40 chars, defaulting to `manual`); scheduled runs are labeled `schedule-YYYY-MM-DD`. Labels surface on the Backups page so a mixed database/volume list stays readable.
- **Scheduling**: a recurring job can sweep multiple volumes in one pass, reusing the backup destination for off-site copies.
- **Safe restore**: restores refuse to run while a service is still live on that volume.

---

## 🛡️ 5. Restore Safety

- Restores can be initiated via Web UI, CLI (`ninedeploy backups restore`), or MCP tool.
- Volume restores first check that the archive can be listed, then extract the whole archive into a hidden staging directory inside the volume and swap it into place with same-filesystem renames. Corrupt archives and extraction failures (including a full disk) abort before any existing data is touched; the transient staging copy means the volume needs space for both the old and the restored contents during a restore.
- Database operations use separate staging files. Failed decryption removes partial plaintext instead of retaining an unauthenticated dump on disk.
- Backup and restore operations hold a cross-process lock file (under `op-locks/` in the data directory), so an overlapping panel process — a systemd restart overlap or a second instance on the same data directory — cannot interleave a backup with a restore on the same database or volume; a busy lock answers 409, and a lock abandoned by a crashed process is reclaimed after its heartbeat goes stale.
