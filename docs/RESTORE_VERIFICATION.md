# Isolated restore verification

Status, 2026-11-05: restore verification is public for PostgreSQL, and since 0.18.21 for MySQL, MariaDB, MongoDB, ClickHouse, Meilisearch, RabbitMQ, Redis, Valkey, KeyDB and Dragonfly: every managed engine. It is available through the API (asynchronous admission and polling), the SDK, the CLI and the panel; see [Databases and backups](DATABASES_BACKUPS.md) for how to use it.
- **Hosted acceptance, PostgreSQL:** passed again on cd3a2a6d.
- **Hosted acceptance, MySQL and MariaDB:** passed on 1151cc49 ([run 41901004999](https://github.com/ninedeploy/ninedeploy/actions/runs/41901004999)). The run had 11 cases: PostgreSQL 5, `mysql:9.7` 3 and `mariadb:12.3` 3. Every source was untouched, the dump bytes were unchanged, the helper inventory was unchanged, and cleanup was confirmed.
- **Hosted acceptance, every adapter:** passed on fc62112e ([run 41988812024](https://github.com/ninedeploy/ninedeploy/actions/runs/41988812024)). The run had 23 cases on the managed default images: PostgreSQL 5, plus a restore, a wrong-value refusal and an invalid-file refusal each for `mysql:9.7`, `mariadb:12.3`, `mongo:8.0`, `redis:8.8`, `valkey/valkey:9.1` and `eqalpha/keydb:x86_64_v6.3.4`. Every source was untouched, every dump's bytes were unchanged, the helper inventory was unchanged, and cleanup was confirmed.
  - **MongoDB on the hosted kernel:** the runner's kernel is 6.19 or later. MongoDB's first hosted cohort ([run 41926197835](https://github.com/ninedeploy/ninedeploy/actions/runs/41926197835)) never reached the verifier: the fixture's `mongo:8.0` source exited with "Linux kernel versions 6.19 and newer has a known incompatibility" (SERVER-121912). With `GLIBC_TUNABLES=glibc.pthread.rseq=1`, both the source and the helper started on that kernel. This is the setting managed MongoDB databases now use too.
  - **Measured restores:** about 0.1 s for MongoDB, 0.25 s for MariaDB, 0.4 s for the Redis family and 0.75 s for MySQL. These are tiny fixtures, not an RTO commitment.
- The structural `backup drill` is unchanged, and its validators still do not prove a real restore.
- **Recovery duration** is recorded and reported. Every restore verification stores the measured `restoreMs` (with `queryMs` and the total `durationMs`) on its drill row. The panel's Backups tab shows it next to the verdict ("restored in 1m 05s"). The CLI's pass line reads "the restore took N ms (M ms with setup and cleanup)". These are measurements of the bounded helper on the panel host, not an RTO commitment for a production restore.
- **PostgreSQL point-in-time recovery (2026-11-05)** is implemented; see section 11 of [Databases and backups](DATABASES_BACKUPS.md). Its hosted acceptance is the last step before R3 closes.
  - **Mechanics:**
    - Archiving: gzip-compressed `archive_command`, which never overwrites a different file, into a `<data volume>-wal` volume; `archive_timeout` 60 s.
    - Base backups: `pg_basebackup -Ft -z -X none` into the same volume, one a day, with retention by base backup plus `pg_archivecleanup`.
    - Recovery: a base backup restored into a new database's volume, `restore_command` replay in a networkless helper, `recovery_target_time` or the end of the archive, then a promote, a re-key of the role and a clean stop.
  - **Isolation:** the archive is writable by the database's own superuser, who can run programs as `postgres` in its container. So its names and contents are not trusted.
    - Every helper that touches it has no network, all capabilities dropped, no privilege gain and a PID limit.
    - The root step that restores a base backup keeps only CHOWN, DAC_OVERRIDE and FOWNER, to own the files it writes.
    - The recovery server runs as `postgres` from the start.
    - Only file names in PostgreSQL's own patterns ever reach a command.
  - **Refusal on missing or damaged WAL:**
    - Every segment the replay needs is `gzip -t` checked first.
    - A "latest" recovery must end (`redo done at`) in the newest archived segment. PostgreSQL itself promotes silently at a gap: in the experiment, a truncated segment 4 recovered only the first of four rows without any error.
    - A time with no transaction archived after it is PostgreSQL's own refusal ("recovery ended before configured recovery target was reached").
  - **Local real check:** `postgres:18`, with real archiving and a base backup taken through the panel's functions.
    - **Passed:** a recovery to a time returned the two rows committed before it; a recovery to the latest point returned all four. The new password worked, and no recovery settings were left in `postgresql.auto.conf`.
    - **Refused:** a time after the archive, a time before the first base backup, and a damaged segment.
    - **Retention:** a 0-day retention kept only the newest base backup and removed the WAL before it.
    - **Cleanup:** no helper was left behind.

**RabbitMQ (2026-11-05)**
- **What is restored.** The panel's RabbitMQ backup is `rabbitmqctl export_definitions`: users, vhosts, permissions, policies, queues, exchanges and bindings. It holds no messages, so the verification proves that the topology comes back, not that queued messages do.
- **Helper:**
  - It is the database's own engine image, run as `rabbitmq`.
  - The 1 GiB scratch tmpfs is `/var/lib/rabbitmq`. The logs and `/tmp` get small tmpfs mounts.
  - The PID limit is 512: the Erlang VM and each `rabbitmqctl` call start their own schedulers.
  - Readiness is `rabbitmq-diagnostics -q check_running`, so the broker application is up, not just the Erlang node. Each CLI call starts a VM, so readiness polls up to 90 times with a 5 s timeout.
- **Restore:**
  1. The definitions file is copied to `/var/lib/rabbitmq/nd-restore.json`.
  2. `rabbitmqctl -q import_definitions` imports it.
  3. The import is applied asynchronously, so the restore counts as done only once every vhost, queue, exchange and binding the file names is listed. This uses the same check as the panel's own restore. It gives up after 120 s as `unverifiable`.

  `restoreMs` covers the import and that settle wait.
- **Verdicts:** a file RabbitMQ cannot import (truncated JSON, not JSON at all) makes `import_definitions` fail. That is `failed`, and the engine's message is not returned.
- **Probe:** one `rabbitmqctl` list command, such as `list_queues -p shop name durable`. It runs as `rabbitmqctl -q --no-table-headers …`.
  - The expected value is the tab-separated rows. rabbitmqctl lists rows in no fixed order, so rows compare as a set of lines; a missing or an extra row still fails.
  - Anything else (another subcommand, shell punctuation, an upper-case subcommand, double spaces) is refused before admission, as a 400. The command is split on single spaces and passed as argv, never through a shell.
- **Local real check:** `rabbitmq:4-management` (4.4.0), with a real definitions export from a source holding a vhost, a durable queue, a topic exchange and a binding.
  - **Restore:** passed in 6.2 s, which is the import and the settle wait. The probe took 1.2 s, most of it the CLI's VM start.
  - **Failed:** a wrong value, a truncated JSON file, and a file that is not JSON.
  - **Cleanup:** every helper was confirmed removed.
- **Hosted cohort:** the hosted fixture covers it. It calls the panel's own `backupRabbitmq`.

**Meilisearch (2026-11-05)**
- **Why a start gate.** A Meilisearch dump is imported only at startup (`--import-dump`), so it uses the same start gate as the Redis family.
- **Helper:**
  - It is the database's own engine image. The image has no service user, so the helper runs as the unprivileged `65534:65534`.
  - The 1 GiB scratch tmpfs is `/meili_data`, plus a small `/tmp`.
  - The server runs with `--db-path /meili_data/data.ms --import-dump /meili_data/nd-restore.dump --http-addr 127.0.0.1:7700 --no-analytics` and no master key: the helper has no network and serves only the probe.
- **Restore:**
  1. The panel's `POST /dumps` file is copied in.
  2. `/meili_data/.nd-start` releases the server.
  3. `curl /health` is polled until `"status":"available"`; the import finishes before the server answers.
  
  `restoreMs` is the import.
- **Verdicts:** a dump Meilisearch refuses ("failed to iterate over archive", "invalid gzip header", "unexpected end of file") makes it exit. That exit is `failed`; any other exit is `unverifiable`.
- **Probe:** an API path, such as `/indexes/movies/documents/1?fields=title`. The expected value is the JSON body of a GET on it.
  - Search responses carry a processing time, so documents and stats make stable probes.
  - A query that is not a path (`/` followed by printable characters, no spaces) is refused before admission, as a 400.
- **Local real check:** `getmeili/meilisearch:v1.53` (1.53.3), with a real dump from a master-keyed source.
  - **Restore:** passed with a 0.9 s import.
  - **Failed:** a wrong value, a truncated dump, and a file that is not a dump.
  - **Cleanup:** every helper was confirmed removed.
- **Hosted cohort:** the hosted fixture covers it. It calls the panel's own `backupMeilisearch`.

**ClickHouse (2026-11-05)**
- **Helper:**
  - It is the database's own engine image, run as `clickhouse`.
  - The 1 GiB scratch tmpfs is the data path `/var/lib/clickhouse`. The logs and `/tmp` get small tmpfs mounts.
  - `CLICKHOUSE_SKIP_USER_SETUP=1`: the entrypoint would otherwise write user settings under the read-only `/etc`. The image's default user, local only, is all the helper needs.
  - The PID limit is 4096. ClickHouse starts about 700 threads at once, and its schedule pool alone asks for 512. It aborts outright under a 256 limit ("Couldn't get 512 threads from global thread pool"). 4096 is still a bound.
- **Restore:**
  1. `prepare` creates `/var/lib/clickhouse/backups`, the image's `<backups><allowed_path>`.
  2. The panel's `BACKUP DATABASE … TO File(…)` zip is copied there as `nd-restore.zip`.
  3. `RESTORE ALL FROM File('nd-restore.zip')` restores every database the archive holds. The panel's backups carry the user databases only. An empty `default` that already exists does not stop it.
  
  A truncated or non-zip archive is refused with `CANNOT_UNPACK_ARCHIVE`, and the server keeps running, so the verdict is `failed`. `NOT_ENOUGH_SPACE` and `MEMORY_LIMIT_EXCEEDED` are capacity verdicts.
- **Probe:** `clickhouse-client --database app -q`. The output is TabSeparated: a tab between columns, one line per row, and NULL printed as `\N`.
- **Local real check:** `clickhouse/clickhouse-server:25.8` (25.8.33.6), with a real backup from a source configured like production (`CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB=app`) and the panel's `BACKUP` statement.
  - **Restore:** passed in 0.25 s and returned `1\tbefore` and `2\t\N`.
  - **Failed:** a wrong value, a truncated zip, and a file that is not a zip.
  - **Cleanup:** every helper was confirmed removed.
- **Hosted cohort:** the hosted fixture covers it. It calls the panel's own `backupClickhouse`.

**Redis, Valkey and KeyDB (2026-11-05)**
- **Why a start gate.** These engines read their RDB file only while the server starts. The helper therefore replaces the image's entrypoint with a gate: PID 1 waits for `/data/.nd-start`, then becomes the server through `exec`. The flags are:
  - `--dir /data --dbfilename dump.rdb`;
  - `--save '' --appendonly no`, so the server never writes over the backup;
  - `--bind 127.0.0.1 --port 6379`.
- **Helper:**
  - It is the database's own engine image, run as `redis`, `valkey` or `keydb`.
  - The 1 GiB scratch tmpfs is `/data` itself.
  - There is no password and no network.
- **Restore:**
  1. The RDB is copied to `/data/dump.rdb`.
  2. The marker releases the server.
  3. The load is polled with `<cli> ping`. `LOADING` is not yet loaded; the load ends at `PONG`, or when the server exits.
  
  `restoreMs` is the load.
- **Verdicts:** a server that exits while loading is judged by its own log tail. Lines are only tested, never kept: a load report can name a key.
  - **`failed`:** the log contains "Wrong signature trying to load DB", "RDB ERROR DETECTED", "Unexpected EOF reading RDB", "Short read or OOM loading DB" or an unknown RDB version. The engine refused the file itself.
  - **`unverifiable`, capacity:** an out-of-memory line takes precedence, because "Short read or OOM" is also logged when memory ran out.
  - **`unverifiable`:** any other exit.
- **Probe:** the query goes to `<cli> -h 127.0.0.1` on stdin, one command per line, so no command text is in an argv. Replies print raw: one line per value or list element, and an empty line for nil.
- **Local real checks** used real `SAVE` backups from password-protected sources: `redis:8-alpine` (8.10.3), `valkey/valkey:9.1` and `eqalpha/keydb:x86_64_v6.3.4`. Each engine had four cases:
  - **Restore:** `GET`, `LRANGE` and a nil `GET` returned the known values.
  - **Failed:** a wrong expected value, a truncated RDB, and a file that is not an RDB.
  - **Cleanup:** every helper was confirmed removed.
- **Hosted cohort:** the hosted fixture covers `redis:8.8`, `valkey/valkey:9.1` and `eqalpha/keydb:x86_64_v6.3.4`. Each source has a production-like `--requirepass` and is dumped with the panel's `dumpCommands` (`SAVE`) and RDB path.
- **Dragonfly (2026-11-05)** uses the same gate and load poll, run as `dfly`. Its flags are the managed database's own snapshot flags: `--dir=/data --dbfilename=dump --df_snapshot_format=false`, so it loads `/data/dump.rdb`. Dragonfly reports every refused file as "Rdb load failed: …", which counts as `failed`. Its probe uses the image's `redis-cli`. A local real check on `ghcr.io/dragonflydb/dragonfly:v1.34.2` with a real `SAVE RDB` backup gave the right verdicts: restore passed; a wrong value, a truncated RDB and a non-RDB file were `failed`; cleanup was confirmed. The hosted fixture covers it too. Dragonfly zero-pads its RDB to 4 KiB after the EOF marker and checksum. Hosted run 42009985629 cut half of the *file*, which removed only padding, so the restore rightly passed. A cut anywhere inside the content (keys, EOF or checksum) is `failed`, and the fixture now cuts half of the content.

**MongoDB (2026-11-04)**
- **Helper:**
  - It is the database's own engine image, run as user `mongodb`, with 256 PIDs. mongod, mongorestore's workers and mongosh each run many threads.
  - The 1 GiB scratch tmpfs is mounted over `/data/db` itself, and `/data/configdb` gets 1 MiB. `/tmp` is a small tmpfs, set as `HOME`, for mongosh's history and logs.
  - There are no `MONGO_INITDB_*` variables. So there is no temporary initialization server, and no access control. The archive's own admin users are restored as data only.
  - `GLIBC_TUNABLES=glibc.pthread.rseq=1` overrides the image's own `rseq=0`.
    - **Why:** with `rseq=0`, TCMalloc uses per-CPU caches. On Linux 6.19 through 7.0.13 these crash, so mongod 8.0 refuses to start at all. MongoDB's [8.0 release notes](https://www.mongodb.com/docs/manual/release-notes/8.0/) say kernel 7.0.14 resolves it.
    - **Effect:** with `rseq=1`, TCMalloc falls back to per-thread caches, which start on every kernel. A short-lived helper does not need the per-CPU speed-up.
- **Restore:** the panel streams the `mongodump --archive --gzip` backup straight into `mongorestore --archive --gzip --stopOnError` on the helper's stdin.
  - No copy lands in the helper, so the whole scratch is left for data.
  - `restoreMs` is the streamed restore.
  - A truncated or corrupt archive makes mongorestore exit non-zero, which is `failed` on a healthy helper.
- **Readiness** is a mongosh `ping` with a 5 s budget per attempt, because mongosh alone takes about a second to start.
- **Probe:** the query is a mongosh script, run as `mongosh --quiet --norc --eval`. The expected value is what mongosh prints for the script's last expression.
  - `EJSON.stringify(…)` gives one stable line.
  - The default database is `test`; address yours with `db.getSiblingDB(…)`.
- **Local real checks** used `mongo:8.0` (8.0.34) with a real authenticated `mongodump --archive --gzip`:
  - the restore returned the known data;
  - a wrong expected value, a truncated archive and a malformed script were each `failed`;
  - every helper was confirmed removed.
  
  The capacity path is not exercised on MongoDB. A full scratch or memory limit is handled by the shared rule: an OOM kill, or a stopped helper whose log reports no space, is `unverifiable`.
- **Hosted cohort:** the hosted fixture also covers `mongo:8.0`. It creates a root user like production's, dumps with `dumpCommands`, mutates the source, then verifies the restore, a wrong value and a truncated archive.

**MySQL and MariaDB (2026-11-04)**
- **One adapter, engine profiles.** `verifyRestore(engine, probe)` runs every engine through the same hardened helper:
  - no network, all capabilities dropped and a read-only root;
  - CPU, PID and memory limits, and 1 GiB of tmpfs scratch;
  - removal and a confirmed absence check afterwards.
  
  Each engine profile supplies only:
  - the user and the socket/volume tmpfs mounts;
  - the empty-root variable and the daemon flags;
  - the readiness, restore and query commands.
  
  `verifyPostgresRestore` remains the PostgreSQL entry point.
- **Helper:**
  - It is the database's own engine image, run as user `mysql`.
  - The datadir is on the scratch tmpfs (`--datadir=/tmp/nd-restore/data`). Native AIO is off, because tmpfs does not take it reliably. MySQL also gets `--skip-log-bin`, since its binary log is on by default.
  - A 1 MiB tmpfs over `/var/lib/mysql` keeps an anonymous volume from ever holding restored data.
  - Root has no password and no network.
  - **Readiness** is `mysqladmin`/`mariadb-admin ping` over TCP. Both entrypoints initialize with `--skip-networking`, so TCP means the final server.
- **Restore:** the panel's `--all-databases` dump goes into the batch client on stdin through a fixed positional script. The client stops at the first failing statement.
  - The dump's `mysql` schema replaces the grant tables on disk, but not the server's in-memory privileges, because the panel's dumps carry no `FLUSH PRIVILEGES`. So the probe still connects as the helper's root.
- **Probe:** the client runs with `--batch --raw --skip-column-names --database=app`. Columns are tab-separated, values unescaped, and NULL is printed as `NULL`.
- **Engine failures are no longer blamed on the backup.** This applies to PostgreSQL as well.
  - **Lost server:** the client lost its server ("Lost connection", "server has gone away", "server closed the connection unexpectedly"), or the helper is not running. The verdict is `unverifiable`, not `failed`.
  - **MariaDB on a full tmpfs:** it aborts with signal 6, and its client then only sees a lost connection. So the helper's own log tail (`docker logs --tail 200`) is checked for capacity messages before the helper is removed. Each line is only tested, never kept: a crash report quotes the running statement.
  - **MySQL on a full tmpfs:** it stays up and returns "The table '…' is full". This is now a capacity message too.
- **Local real checks** used Docker Desktop with `mysql:8` (8.4.13) and `mariadb:11` (11.8.9), with real `--all-databases` dumps taken by the panel's flags.
  - **Passed:** the restore returned the older value with tabs and `NULL`, while the source held the newer one.
  - **Failed:** a wrong expected value, and invalid SQL under strict mode.
  - **Capacity:** a 480 MB dump was `unverifiable` with the capacity message on both engines.
  - **Cleanup:** every helper was confirmed removed.
- **Hosted cohort:** the hosted fixture now also seeds, dumps (`dumpCommands`, the panel's own argv), mutates and verifies `mysql:9.7` and `mariadb:12.3`. Run it with `restore_verification=true`.

**Public integration (2026-11-04)**
- **Endpoint:** `POST /v1/databases/:id/backups/drill` accepts `restore: { query, expected }`.
  - **Role:** this needs the `admin` role on the database, because the probe is a yes/no oracle over the backup's contents, like a download. The structural drill still needs only `member`.
  - **Validation:** the body is validated before any work: an object with exactly `query` (non-empty) and `expected`, each at most 16,384 bytes.
  - **Response:** the panel answers `202 { pending: true, status: 'running', drillId }` as soon as the `running` row exists, through `runBackupDrill`'s `onAdmitted`. The restore then finishes in the background.
  - **Concurrency:** one verification runs per panel process at a time; a second gets 409 `restore_verification_busy`. A refusal before admission frees the slot, and so does a failure after it.
  - **Audit:** the start and the verdict are both audited as `backup.drill`, never with the probe.
- **Polling:** the new endpoint `GET /v1/databases/:id/drills/:drillId` returns one drill (viewer). Another database's drill reads as 404.
- **Panel restarts:** the boot sweep marks a drill that was `running` when the panel restarted as `unverifiable`. The `restore-verification-helpers` step removes its helper.
- **Engine image:** before staging, the runner calls `ensureDockerImage` on the PostgreSQL engine image, because a node database's image may exist only on its node. If the pull fails, the drill is `unverifiable` before anything is decrypted.
- **SDK:** `drillBackup(id, { backupId, restore })`, `drill(id, drillId)` and the `BackupRestoreProbe` type; `BackupDrillResult.status` now also takes `running`.
- **CLI:** `backups drill … --restore-query <sql> --expect <value> [--no-wait]` polls until the verdict. Exit codes are 0 for passed, 1 for failed or a timed-out wait, and 2 for unverifiable.
- **Panel:** the Backups tab has **Verify restore** for PostgreSQL. It polls every 3 s while a drill is running, and labels a passed restore verdict "Restore verified".

Accepted component evidence: [run 41649048270](https://github.com/ninedeploy/ninedeploy/actions/runs/41649048270), frozen source `608fe3f094d952d0aff4b9073a340e2d708b2bee`; its tree matches local `34c3c4ad896c6c5fb6955dbad265d9419bab166f` before this documentation update. Both real plain/custom restores returned the known earlier value after the separate source had changed. Wrong expected data, invalid SQL and an unavailable extension produced the required failed verdicts. All five helpers confirmed cleanup; the source retained its newer value, original dump hashes and helper inventory were unchanged, and owned source/scratch cleanup passed. Independent receipt verification is retained at `.temp_files/restore-verification-41649048270/restore-verification-41649048270/independent-verification.json`; verifier: `.temp_files/verify-restore-41649048270.mjs`.

The successful fixture used immutable PostgreSQL config image `sha256:3a4264520e121176619f54ff867d12774bc81e95e7b84db58d63bccdb6144b81`. Measured total verification durations were 1,520 ms for plain and 1,495 ms for custom; restore/query times were also recorded separately. These small fixture measurements are not a production RTO commitment. The final local covering suite passed **91 tests in four files**, server typecheck, lint and four pre-Docker hosted guards. This source has not passed a dedicated full integration PR or final release gate. Earlier failed attempts below remain diagnostics, not accepted cases.

`verifyPostgresRestore` accepts an already decrypted backup, a managed engine image and a query with its exact expected result. It resolves the image to an immutable config ID, creates a separate PostgreSQL server, restores the plain SQL or custom archive, executes the query and confirms helper removal. It receives no production database identity or credentials. Errors and receipts exclude SQL, expected values, restored results and engine stderr.

The helper has no network, published ports, host mounts or Docker socket. It runs as the image's `postgres` user with all capabilities dropped, a read-only root filesystem, CPU/PID/memory limits and bounded tmpfs storage. A private scratch copy makes the dump readable by that user without changing source permissions or bytes. Restore, probe and setup operations have separate deadlines. This bounded verification profile supports dumps that fit its 1 GiB scratch filesystem; exceeding capacity is not a successful verification. Cleanup removes the owned helper and its anonymous volumes, confirms container absence and removes the private host copy. Unconfirmed cleanup prevents a pass.

Plain SQL uses `psql -X`, `ON_ERROR_STOP=1` and a single transaction; custom archives use `pg_restore --exit-on-error --single-transaction`. These follow the [psql error-handling contract](https://www.postgresql.org/docs/18/app-psql.html) and [pg_restore transaction/error options](https://www.postgresql.org/docs/18/app-pgrestore.html). Readiness requires TCP to avoid accepting the image entrypoint's temporary Unix-socket-only initialization server.

Local adapter tests passed 16 cases, including strict restore errors, custom archives, exact known-data mismatch, timeouts, output bounds, unavailable images, lost create replies, cleanup failure and source preservation. The covering legacy-drill suite passed 88 tests in three files; server typecheck and lint passed. These tests mock Docker command execution and are component evidence only. No local Docker was used.

The hosted fixture `scripts/smoke-backup-restore.mts` creates a real PostgreSQL source on an isolated GitHub-hosted runner. It writes known data, takes real plain/custom dumps, changes source data, restores the older backups into independent helpers, checks the old value, refuses a wrong expected value, malformed SQL and a missing extension, then confirms the source still has its newer value and both original dump hashes are unchanged. It also checks helper inventory and owned cleanup. Only its enumerated JSON receipt is uploaded. Run it through Runtime readiness with `restore_verification=true`; its outcome and frozen source must be recorded before claiming native acceptance.

The first native attempt is [run 41647674202](https://github.com/ninedeploy/ninedeploy/actions/runs/41647674202), frozen source `1c252b525b31b2a52f15b82ed7bb869736e77347`. Its source tree matched local `10d63359e6aacd5339bace21d5c33f9e301d8401` before this documentation checkpoint. The real restore step is running; no native outcome is accepted yet. Four local pre-Docker hosted guards and the workflow/public-upload preflight passed. PR #25 is unchanged and remains the only open integration PR; no R3 integration PR or release was opened.

That first attempt failed during fixture setup before any restore case ran. Its cleanup was not confirmed and must not be counted as successful. The initial phase receipt was too coarse to identify the exact setup operation. The fixture now distinguishes image pull, source creation, readiness, seeding and dumping; only synthetic image/container creation errors can retain a bounded diagnostic, excluding SQL/data and credentials. The production verifier has not been changed on the basis of this inconclusive setup failure.

Follow-up runs 41648010768 and 41648314463 located the failure at reading the synthetic dump from the source's tmpfs through `docker cp`. The final diagnostic reports the exact file missing through that API. [Docker documents this tmpfs limitation](https://docs.docker.com/reference/cli/docker/container/cp/#corner-cases). The fixture now captures its small synthetic dump with binary-safe `docker exec cat`; the production adapter streams the private 0600 copy through `docker exec -i` into tmpfs with a fixed positional shell script. Source dump bytes never become shell code or command arguments. The streaming helper has real-process tests for binary integrity, missing input and a child that never drains stdin. The adapter regression failed on its previous archive-copy call while 18 controls passed. No isolated restore case has been accepted yet; a corrected native run remains required.

Remaining work includes encrypted/remote backup staging and persisted drill history, public permissions and API/SDK/CLI/panel behavior, supported-engine adapters beyond PostgreSQL, real recovery-duration reporting, process-interruption cleanup, and PostgreSQL continuous WAL archiving/PITR with retention and missing/corrupt-WAL refusal. See [Competitive delivery](COMPETITIVE_DELIVERY.md) for the full R2–R6 and final release scope.

The internal drill runner now accepts an explicit restore probe and reuses encrypted/remote staging plus persisted history. It refuses non-PostgreSQL engines and incomplete/non-database backups before inserting a row. Restore mode records coarse verdicts, immutable image identity and timings, never probe SQL, expected values or restored output. Its private staging cleanup is mandatory. Ten new behavior checks initially failed or exposed missing cleanup, then the covering five-file suite passed **124 tests**, server typecheck, lint and diff checks. These staging/history checks use real temporary files with mocked remote/crypto/adapter boundaries; a real encrypted/remote public flow is not yet accepted. The existing public structural drill remains unchanged.

A partial remote download also exposed a real staging leak: fetch ran before the protected cleanup block. The unchanged regression observed the partial file remaining, then passed after fetch moved inside that block. Restore/setup exceptions become a sanitized `unverifiable` result, and a failed plaintext cleanup prevents success. The SDK's normal 30-second request budget requires asynchronous public admission and polling rather than a long synchronous restore request; that API, permission and client integration remains next.

### Crash leftovers and capacity verdicts — 2026-11-04

These pre-wiring fixes came out of a code review of the adapter. Its public route still never passes a restore probe.
- **No second plaintext copy.** The verifier no longer copies the decrypted dump into `<tmpdir>/nd-restore-verification-*/`. It streams the caller's private staged file directly. Before, a panel crash between the copy and cleanup left a plaintext dump that `pruneDrillLeftovers` never matched.
- **Leftover helpers are swept.** Housekeeping step `restore-verification-helpers` removes leftover helpers hourly. A helper holds the decrypted dump and restored data in its tmpfs. The step only removes containers that meet all three conditions:
  - they carry the `ninedeploy.role=restore-verification` label;
  - they have the exact generated `ninedeploy-restore-check-<uuid>` name;
  - they are older than one hour, far above one verification's bounded lifetime.
- **Capacity is `unverifiable`, not `failed`.** Before, running out of the helper's bounds returned `failed`, which reads as "this backup does not restore". Now a dump larger than half of the 1 GiB scratch is refused before any helper exists. A restore or query error is also `unverifiable` in three cases:
  - an engine out-of-space or out-of-memory message, used only as a boolean;
  - a cgroup OOM kill;
  - unreadable helper state.
- **Tests.** Seven new or changed unit cases failed on the previous source and pass now. These are mocked-Docker component checks. The hosted `restore_verification` cohort must be re-run on this source before it counts as native acceptance.
