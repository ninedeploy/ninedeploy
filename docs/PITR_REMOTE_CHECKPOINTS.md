# Remote PostgreSQL recovery archives

N04's first slice adds **opt-in, self-contained recovery checkpoints** for PostgreSQL PITR on the panel host. Each remote object contains one completed base backup, its PostgreSQL backup manifest/history, every contiguous WAL segment from that backup through the snapshot, and a manifest of file sizes and SHA-256 hashes. A checkpoint does not depend on older remote objects or the lost host's master key.

The next N04 slice adds explicit **continuous** mode: a minute worker ships newly closed WAL individually and hands off between overlapping base-backup generations. Its remote retention policy preserves complete recovery sets. Existing configurations retain full-checkpoint mode; upgrading alone enables neither shipping nor deletion. The next slice extends both modes to PostgreSQL databases on nodes through a capability-gated, sealed agent adapter. The operator configuration and status screen is described below.

## Operator screen

Open a PostgreSQL database's **Backups** tab and use **Remote PostgreSQL archive**. The screen is available to instance operators for both panel-host and node databases; the API continues to enforce database-admin access. Other users do not load remote status or destination details.

1. Enable local WAL archiving in the existing PITR card. Remote configuration requires local archiving; manual shipment waits for a completed base backup.
2. Select an HTTPS S3 destination created in **Settings → Backup destinations**. Choose **Continuous WAL (every minute)** with 1–35 days of remote retention, or **Self-contained checkpoints** with a 15–1440 minute interval. Existing configurations without a mode continue to use checkpoints.
3. Turn on **Remote archiving**, enter and confirm a 16–1024 character recovery passphrase, keep it off-host, then save. Leave both passphrase fields blank on later edits to retain the stored passphrase. The passphrase is not returned by the API, placed in query data or mutation variables, or saved in browser storage/URLs. A successful save clears both inputs; leaving the database or losing the operator role discards its form.
4. Use **Ship archive now** after saving. Admission means the pass started; it is not a verified backup. The screen polls running passes and shows the last verified time, archive age, recoverable ranges, exact recovery key, missing segment, failure reason and pending continuous cleanup count. Unsaved edits survive polling; discard them explicitly to reload saved values. Only a verified result exposes a recovery key.

Changing the destination, mode or passphrase requires reviewing the old recovery details before saving. Existing objects remain retained under their earlier keys and passphrases; a changed continuous destination/passphrase starts a separate archive. The screen does not expose arbitrary namespace resets or automatic restore/adoption. Store the displayed recovery key and its original destination credentials/passphrase off-host. Checkpoint details name the destination used by that checkpoint, which can differ from the current selection.

Pausing **Remote archiving** saves the disabled configuration and keeps remote data. Pausing remains available with a missing destination or unavailable source; it does not need a new passphrase. Disabling local WAL archiving also pauses remote production, while the existing local-disable action removes the local archive. The API remains authoritative for capabilities, source state, S3 conditions and retention. This screen does not certify a cloud provider or production RPO/RTO.

## Configure and observe

Create an S3-compatible destination in Settings → Backup destinations, using HTTPS. Keep its credentials and a separate recovery passphrase outside the source host. A destination on the same physical host does not provide host-loss protection.

Operator-only endpoints:

| Request | Behavior |
|---|---|
| `GET /v1/databases/:id/pitr/remote` | Configuration, passphrase-presence flag, checkpoint `state` or continuous `stream` status, verified recovery ranges, archive age and failure diagnostics. No credentials or passphrase are returned. |
| `PUT /v1/databases/:id/pitr/remote` | Save the complete configuration below. Omit `passphrase` on later updates to retain it. |
| `POST /v1/databases/:id/pitr/remote/checkpoint` | Admit one pass in the configured mode, answer 202 after its running record is stored, then poll GET. Admission is not a successful backup. |

```json
{
  "enabled": true,
  "destinationId": 3,
  "intervalMinutes": 15,
  "mode": "continuous",
  "remoteRetentionDays": 7,
  "collectOrphans": false,
  "passphrase": "replace-with-a-strong-off-host-recovery-passphrase"
}
```

PITR archiving must already be enabled for a non-preview PostgreSQL database on its owning host (panel or supported node). This slice refuses backups with additional tablespaces: PostgreSQL puts each in a separate archive, which this format does not carry. The PostgreSQL file manifest is checked on export and import (including encoded paths); it is bounded to 32 MiB. See the [PostgreSQL tar-backup layout](https://www.postgresql.org/docs/18/app-pgbasebackup.html) and [backup manifest format](https://www.postgresql.org/docs/18/backup-manifest-format.html). The worker checks once a minute and runs due passes serially. Continuous mode attempts shipping every minute, independent of `intervalMinutes`; full-checkpoint mode uses the 15–1440 minute interval measured from the last attempt. Failed attempts retry on a later due pass. Continuous mode also requires a PostgreSQL backup manifest containing `System-Identifier`; manifests without it are refused. Native acceptance uses PostgreSQL 18. Only running managed PostgreSQL databases with archiving enabled are scheduled, including supported nodes. Turning off local PITR pauses remote production, without deleting existing remote objects. The SDK exposes these operations at `client.databases.pitr.remote`.

A private local scratch copy pins local retention and PITR disable/base-backup operations while copying; it uses the database operation lock. Only completed files are selected. Missing segments, corrupt gzip streams or changed file sizes refuse publication. After copying, local retention can resume: the checkpoint includes every segment its base needs. Uploads are encrypted with the existing streaming NDPB1 envelope (scrypt and AES-256-GCM) under the recovery passphrase. An upload counts as successful only after a full GET read-back matches the uploaded ciphertext's SHA-256 hash.

Objects use `<destination prefix>/pitr-checkpoints/<database slug>/<UTC time>-<UUID>.ndpc`. Save the full key and destination information off-host. A lost panel database is not needed to read that object. The passphrase stored for scheduling is encrypted under the panel master key and participates in master-key rotation; recovery uses the separately held plaintext passphrase. Changing it affects new objects only: keep earlier passphrases for earlier checkpoints.

In full-checkpoint mode, `state.lastSuccess` identifies the last verified object and its destination ID, verification time, ciphertext hash/size, and `from`/`through` bounds. `through` is a WAL archive timestamp, an upper bound rather than a promise of an exact transaction commit. PostgreSQL still decides whether a requested target is reachable. `archiveLagSeconds` is the age of that bound, not a guaranteed RPO. A failed upload preserves the previous verified object and records failure; an interrupted `running` record is shown as failed after restart. Old status does not prove an object still exists: recovery authenticates it again. Each checkpoint starts at its selected base backup; separate objects can leave gaps during base-backup rollover. The local retention setting does not guarantee continuous remote coverage. Select an object whose own bounds cover the requested time, and let PostgreSQL verify that target.

## PostgreSQL databases on nodes

Use the same configuration/status/checkpoint endpoints and SDK for a node database. Archive enable/disable/base-backup controls keep their database-admin rule and ordinary archive status remains readable by database viewers; remote configuration/status/production still require an instance operator with database-admin access. First enable archiving with `PUT /v1/databases/:id/pitr` and `{ "enabled": true, "retentionDays": 7 }`; this restarts that database on its node and starts the first base backup. Wait for its base backup to complete, then enable the remote configuration above. Upgrading a panel or agent does not enable archiving or uploads. `containerName` and `volumeName` remain null in the panel's node database row; the adapter uses the existing node markers and never runs the panel's Docker against that database.

The node must be reachable over sealed transport and advertise **`db.pitr.archive`**, together with the normal database and stream capabilities. Published v0.18.28 agents do not advertise this extension; use an agent built from the matching candidate (or a later release containing it). Live capability checks decide support. An older/unsealed agent is refused before archive operations are sent. The node owner can set `NINEDEPLOY_AGENT_PITR=off` to stop archive control/export, or `NINEDEPLOY_AGENT_DATABASES=off` to stop all managed database operations. These switches remove the advertised capability and are checked again by the actual operation/export handler. They do not delete existing WAL or remote objects, or remove PostgreSQL's existing archiving flags.

The agent validates the database id/slug against the data and archive volume labels, actual PostgreSQL image, data mount, archive mount and command flags. Fixed operations perform preflight, archive preparation, base backups, inventory, statistics, pruning and disable cleanup. Snapshot export uses the authenticated binary agent stream: either a complete checkpoint or only the selected closed-WAL batch. Both sides use private scratch; the panel verifies framing, selected names, sizes, hashes and exact cluster identity before encryption and S3 publication. S3 credentials and the recovery passphrase stay on the panel. Base/WAL data therefore crosses the sealed node-to-panel connection, then goes to S3; direct node-to-S3 uploads are outside this slice.

Node export requests use the panel's `NINEDEPLOY_STREAM_MAX_BYTES` limit (default 50 GiB, maximum 1 TiB) and the existing six-hour stream cap; an exceeded or interrupted transfer cannot be published. Archive bounds/lag use source-node archive timestamps, so synchronize host clocks; `verifiedAt` is the panel confirmation time. Archive copies hold the panel database operation/lifecycle locks. The agent separately serializes archive mutations and snapshots; read-only status remains available while a base backup runs. Node outages, an owner switch, unconfirmed replies, truncated transfers or identity mismatches refuse new publication and retain the last verified remote recovery set. Continuous local-pruning protection and remote generation retention are the same as on the panel host. Monitor disk on **both** machines: an outage can hold WAL on the node, and export/import use temporary disk on the node and panel. Ordinary completion/failure removes scratch; hard process/host kills can leave private scratch requiring inspection.

Node status includes `recoveryUnavailableReason`: archive controls remain usable, but managed replay from that local node archive is a separate adapter and `POST /v1/databases/:id/pitr/recover` refuses it explicitly. The existing database panel disables that replay button and explains the offline path. Recover a published remote node archive with the same offline tool below on a clean supported host; the lost node, panel database and old master key are not required. Automatic enrollment/adoption onto another node is outside this slice.

## Continuous publication and recovery bounds

Full-checkpoint paths and `state.lastSuccess` above apply to legacy mode. Continuous mode uses a server-allocated UUID at `<destination prefix>/pitr-streams/<archiveId>/`. Save its complete **`head.ndpi` key**, destination credentials and recovery passphrase off-host. Each generation contains one encrypted `.ndpc` base anchor and uniquely named encrypted `.ndwal` segments. Immutable encrypted `.ndcat` catalogs describe the graph; the encrypted head points to the current catalog. Every upload is fully read back and SHA-256 checked before publication. Ordinary passes recheck anchors and the latest WAL boundary; recovery authenticates every required byte again.

Head publication uses signed `If-None-Match: *` initially and `If-Match` with the observed ETag afterward. A stale writer is refused. Each producer pass checks both conditions on its own private nonce key and removes that probe; an endpoint that ignores them holds publication and cleanup. The destination must support HTTPS, ETags and [conditional S3 writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html). Read-only recovery needs GET/HEAD; production also needs PUT/DELETE. The protocol fixture does not certify a particular cloud provider.

Routine configuration saves retain `archiveId`. A different destination, changed passphrase or explicit `resetStream: true` starts a new namespace and leaves the old one intact. Clients cannot choose `archiveId`. Keep old credentials, keys and passphrases for old archives. Editing a destination's prefix underneath a known archive can make its head unavailable; restore the configuration or explicitly reset after reviewing the old archive.

`stream.protection` reports head/catalog keys, sequence, last protected segment and per-generation ranges. `archiveLagSeconds` ages the newest WAL archive timestamp. These are verified archive bounds, not transaction RPO guarantees. A pass ships at most 128 new segments; a backlog defers rollover until caught up. Continuous mode validates PostgreSQL's exact cluster identifier and the decompressed prior WAL boundary before extending a generation. Missing segments, a changed boundary/cluster, an index rollback or a missing known head stops publication. Latest-point restore never silently falls back to an older recovery point.

## Safe retention and resources

**Full-checkpoint mode never automatically deletes its objects.** Continuous retention manages only recorded objects in its archive UUID namespace; it never scans/deletes unrelated prefixes or legacy checkpoints. Disabling remote or local PITR pauses production and cleanup, preserving remote data. Deleting the managed database also stops its cleanup; retained remote archives require operator management.

`remoteRetentionDays` is 1–35 days (default 7). Retention keeps the base at or before the cutoff and every newer generation, always preserving the newest complete generation. It conservatively keeps the predecessor when the cutoff falls inside a base-history timestamp second. New bases publish only after the old tail overlaps their recovery window. Retention can therefore keep data older than the configured days; it is not a strict storage quota. Increasing the period cannot resurrect generations already retired.

Expired generations leave a newly published catalog first. Their exact object keys become deletion intents with a **one-hour grace period**. A later pass deletes at most 200 due objects and retries interrupted cleanup. Before retiring a generation or deleting its data, every retained base/WAL reference must pass size/ETag checks. Missing retained data or unsafe deletion metadata holds cleanup. Failed publication leaves the last committed head intact; failed cleanup can still record newly verified protection.

Only intents from an already committed catalog are eligible for deletion. Older catalog objects expire after grace too. An immutable catalog key is useful during recovery or diagnosis, but is not permanent protection against retention. Finish recovery before its data's grace expires, or pause the producer during a long restore. There is no distributed restore lease. Abandoned uploads remain retained unless the operator explicitly enables the bounded discovery policy below.

Local pruning is held until the newest local base is protected remotely. An outage during rollover can grow the local archive: monitor lag, errors and disk space. A missing local bridge requires intervention and is never silently skipped. External bucket lifecycle rules must not expire retained anchors, catalogs or WAL independently. Restore refuses missing objects. Bucket versioning, object locks and provider durability remain operator-controlled; a DELETE refusal from an object lock is visible in status.

Each generation/checkpoint is bounded to 20,000 WAL segments and an 8 MiB checkpoint header, plus the 32 MiB PostgreSQL manifest limit. Catalogs are bounded to 32 MiB, 512 generations and 200,000 deletion intents. A new local base reduces the active WAL span. Full-checkpoint mode transfers its base every run; continuous mode transfers a new base only on bootstrap/rollover. Budget network, temporary disk and storage accordingly. Export needs selected source files, framing, ciphertext and read-back copies. Recovery needs encrypted/plaintext scratch, unpacked files, a staging archive volume and a new data volume. Private scratch is removed on ordinary completion/failure. A hard kill can leave scratch/helpers/volumes requiring inspection; these are not certified recovery points. Existing target data volumes are refused.

## Abandoned upload collection

Continuous mode can opt into **Collect abandoned uploads** in the operator card, or set `collectOrphans: true` in the existing remote configuration API/SDK. It defaults to off and is refused for checkpoint mode. It runs on the panel as part of a normal continuous shipment for both panel-host and node databases. Legacy checkpoints, old archive UUIDs, unrelated prefixes, probes and keys outside the managed immutable layout are never scanned for deletion. Keep unrelated files outside the managed `pitr-streams/<archiveId>/` namespace.

Each enabled pass with an existing authenticated head reads one [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html) page from that exact archive prefix: at most **200 objects**, **1 MiB** of XML, with URL-encoded keys and validated bucket/prefix/count/cursor metadata. The destination needs `s3:ListBucket` permission restricted to that prefix. Invalid, oversized, denied or inconsistent listings hold index publication and deletion before any new source copy/data upload. The last verified archive remains intact; status explains the listing permission/support requirement. Turning collection off resumes ordinary shipment without listing.

Object ages use the provider’s `LastModified` and the panel clock; keep the panel clock synchronized. Only managed anchor/WAL/catalog keys at least **24 hours old**, absent from every current generation and existing retirement intent, become candidates. The active head/current catalog, retained generations and newly uploaded objects are excluded. Candidates are appended to the existing encrypted catalog's deletion intents with a further **one-hour grace**. They can be consumed only by later passes after the catalog was committed through the conditional head write. Data deletion retains the existing verification of all retained base/WAL references and the **200-delete-per-pass** budget. Failed deletion retries; missing keys are idempotent. Keys consumed by the current cleanup pass are not rediscovered from its earlier listing.

The head publication is also the fence against a stalled writer: a producer that uploaded a candidate using an older head ETag cannot later publish it after the collector commits. If the other producer wins publication first, the collector's [conditional write](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) fails, new orphan intents do not commit and the candidate remains available. A subsequent pass treats the winner's published references as live. This assumes producers follow the managed immutable-key/conditional-head protocol; manual rewrites/reuse of managed keys are outside it.

`stream.orphanSweep` reports the last committed page's `scannedAt`, newly staged `found` count and opaque continuation `cursor` (`null` means the scan reached the end and the next pass starts a new sweep). Cursor progress advances only after verified head publication. It is panel-local: restart retains it, losing panel progress restarts the bounded scan, and existing remote intents remain authoritative. When a provider invalidates an old cursor, disable collection, complete one ordinary shipment, then re-enable it to restart listing. Do not edit the stored cursor directly.

Turning collection off stops discovery and clears its progress on the next pass; already committed deletion intents can still complete. Pausing remote archiving stops both shipment and cleanup. Changing destination/passphrase uses the existing new-archive policy and leaves the previous namespace intact. A long restore must still pause its producer or finish before retired data expires; there is no distributed restore lease. This policy manages current object keys, not provider bucket versions, lifecycle settings or Object Lock policies, and is not a storage quota or external-provider certification.

## Recover after losing the source host

Use a clean supported Linux host with Docker, the matching NineDeploy checkout/build and enough disk. Run recovery commands serially and use a distinct target name for each attempt; the offline tool does not coordinate concurrent restores across processes. Preserve the original PostgreSQL image/version and extension requirements. Build with `pnpm install --frozen-lockfile && pnpm build`. The offline tool uses compiled server modules and does not need the old panel DB or old master key. It may create a new local master key for the new database's password; that key does not decrypt the checkpoint.

Create a private JSON file (`chmod 600 /secure/recovery.json` on Linux):

```json
{
  "cfg": {
    "endpoint": "https://s3.example.com",
    "region": "us-east-1",
    "bucket": "recovery",
    "accessKeyId": "replace-me",
    "secretAccessKey": "replace-me"
  },
  "key": "ninedeploy/pitr-checkpoints/main/REPLACE-WITH-THE-EXACT-OBJECT-KEY.ndpc",
  "passphrase": "the-operator-held-checkpoint-passphrase",
  "targetTime": "2026-11-17T09:02:30Z",
  "volumeName": "nd-db-recovered-data",
  "newPassword": "replace-with-a-new-strong-database-password"
}
```

Use `targetTime: null` for the latest archived point. Keep secrets in this file, not command-line arguments or shell history.

For continuous recovery replace `key` with the exact saved `.../pitr-streams/<archiveId>/head.ndpi` key (or a retained `catalog/<revision>.ndcat` key). The same tool selects a retained generation covering the target, downloads its anchor and required incremental WAL, authenticates everything before creating a target volume, then uses the same replay engine. Latest recovery requires the complete newest tail.

```sh
node scripts/recover-pitr-checkpoint.mjs /secure/recovery.json
```

Recovery downloads the object, authenticates/decrypts it completely, validates the file list/contiguous WAL and every file hash, then imports to a fresh staging archive. The existing PostgreSQL replay engine restores to a new data volume. Missing/damaged segments and an unreachable time are refusals, including the engine's check that a latest-point replay really reaches the newest segment. The staging archive is removed afterward. A failed replay can leave its new data volume for inspection; use a different name for a retry, and never start a failed/unverified restore as a recovered database.

A successful answer names the recovered volume, source version/role/database, replay point and engine replay duration. It does not enroll a database row into a new panel. You can validate it in an isolated container before adopting the retained volume through the panel's existing database creation flow:

```sh
# Use the exact version reported by the recovery tool.
docker run -d --name inspect-recovered --network none \
  -v nd-db-recovered-data:/var/lib/postgresql postgres:18
# Connect with the reported username/database and the new password; verify application values.
docker stop inspect-recovered
docker rm inspect-recovered
```

Volume adoption, panel/application restore, node re-enrollment and DNS cutover belong to the combined N05 drill. Fence the old writer before a production cutover. Never run two PostgreSQL containers against the same data volume.

## Acceptance evidence and limits

`node scripts/smoke-pitr-remote.mjs --image=<local candidate> --proof=<scratch directory>` creates labelled disposable Docker daemons. Its HTTPS S3 protocol fixture is separate from the source daemon; it checks the signed-request shape and payload hash but is not an AWS/MinIO certification. It removes the source daemon and all its data/archive volumes, then runs the real offline recovery tool against a fresh daemon with a different master key. Selected transaction values and the new password are checked, as is latest-point recovery containing all four rows captured by the verified checkpoint. Removing required source WAL and taking a new base backup with a real additional tablespace must refuse new publication while keeping the earlier verified object. Wrong passphrase, missing object and damaged ciphertext must refuse recovery before a target data volume is created.

The dated implementation record captures exact candidates, results and fixture timings. Zero protected rows lost applies to data in the last verified remote archive. Managed node replay, adoption and production disaster recovery remain separate work. Unknown layouts and abandoned previous namespaces remain outside automatic collection. [Implementation record](plans/PROJECT_REVIEW_2026-11-16.md)

Add `--continuous` to the native smoke command to exercise incremental shipping, three overlapping base generations, retirement/grace/deletion, stale-writer rejection, source-host loss, and selected/latest recovery. Missing index/WAL and damaged index/WAL must refuse recovery before creating a target data volume. Retention time advances through an injected producer clock; PostgreSQL replay and object deletion are real.

Add `--node` to the native smoke command for the node slice. It starts a separate real agent with sealed RPC and binary streams, enables node archiving through the panel controller and tests both remote modes while the panel's Docker endpoint is deliberately unavailable. It also checks a live node-owner switch, then removes the source node, agent, database/archive volumes and panel state before selected/latest offline recovery. The closed SQL fixture endpoint is test-only and is never added to the production agent protocol.

## RustFS provider acceptance

Use `--rustfs` to run the continuous archive drill against RustFS 1.0.4. The drill starts the [RustFS container](https://docs.rustfs.com/en/installation/container) with a dedicated Docker volume, a private bridge, a disposable bucket and [TLS](https://docs.rustfs.com/en/integration/tls-configured). It leaves the provider online while removing the source daemon and its database and archive volumes. Use a fresh proof directory for each run.

```sh
docker pull rustfs/rustfs:1.0.4
node scripts/smoke-pitr-remote.mjs --rustfs --image=<candidate> --proof=.temp_files/pitr-rustfs-panel
node scripts/smoke-pitr-remote.mjs --rustfs --node --image=<candidate> --proof=.temp_files/pitr-rustfs-node
```

The drill requires Docker and a local NineDeploy candidate image. It checks HTTPS request authentication, URL-encoded keys across two listing pages, conditional publication, incremental WAL, retention and orphan deletion. The recovery step runs the offline tool on a new daemon and verifies selected-time and latest transaction values. The receipt records the candidate and provider image IDs and the cleanup outcome.

The November 17, 2026 acceptance run passed for both panel and node sources. The tested target was a self-hosted RustFS instance on Docker Desktop with a dedicated volume. Results apply to that version and configuration. [Provider acceptance record](plans/PROJECT_REVIEW_2026-11-16.md#eighth-package-implementation-record--november-17-2026)
