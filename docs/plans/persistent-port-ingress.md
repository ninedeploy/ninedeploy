# Persistent TCP/UDP ingress and MonoSIP migration

Status: kernel rule foundation merged in PR #30. Publication authority acceptance
is in progress. No production deploy mode is enabled.

## Confirmed trigger

Normal Docker deploys publish direct host ports on the application container. The
Docker builder stops the previous runtime to free those ports before starting the
candidate. Traefik can still reference the previous runtime during this interval.
Readiness runs after candidate startup; it cannot keep an already stopped runtime
serving. Source inspection does not prove a particular production failure started
during image pull. Capture timestamps and immutable runtime IDs before attributing
the observed first 502 to a specific phase.

The reported bindings are explicit IPv4 `10.6.6.9`, TCP/UDP 5060, UDP 3478 and UDP
10000–10100. A container port base of 10000 already represents 10000–10100 in the
Docker formatter. The editor now displays the full range without changing the API.

## Network contract

Application containers must not own stable host ports in this mode. A separate
port keeper reserves them; a kernel DNAT publication selects the application
target. DNAT must preserve the original client IP and source port. A generic
userspace proxy that substitutes its own source tuple cannot silently replace
this path: SIP address handling and STUN XOR-MAPPED-ADDRESS depend on that tuple.

The first implementation supports explicit unicast IPv4 bindings only. Wildcard
addresses, IPv6, allow lists and unsupported firewall backends must fail preflight
without stopping a serving runtime. Existing direct-publish behavior remains the
default until migration and recovery are certified.

Only the service's owned nft table may be replaced. Publication uses one atomic
transaction at NAT priority -101, ahead of Docker's destination NAT. Existing
conntrack bindings continue using their original backend. Forwarding grants must
require the owned connmark, original destination tuple and retained backend
address. They must execute after DOCKER-USER so operator drops retain precedence.
Never flush a global ruleset or change Docker's default forwarding policy.

Conntrack preservation is not SIP dialog migration. Repeated registration packets
can keep an old UDP flow alive; active calls and ARI applications have their own
state. Retirement requires an explicit transport/application drain policy. A
timeout must report an unresolved drain rather than claim lossless retirement.

## Publication authority and runtime integration still required

`PersistentPortPublisher` now records intent before either routing plane changes,
retains both targets after an uncertain acknowledgement, and can resume from a
durable journal. It compares the actual nft table, chains and rule expressions
against the expected publication: a matching comment alone is insufficient.
Retirement requires a confirmed generation, no pending intent and a completed
drain observation followed by another kernel readback. Retention is bounded to
three targets; further deploys must wait instead of forcibly stopping active flows.
The journal also records retirement intent before issuing an immutable
runtime stop. A lost stop acknowledgement blocks later publication/reuse until
that retirement is reconciled. The runtime reference is removed only after stop
and forwarding-grant cleanup acknowledge completion.

The version 3 journal records the observed source publication of each pending
intent. An unresolved handoff can roll back only to the last confirmed immutable
target, after that target passes readiness again. The rollback receives a new
revision; it never replays an old revision. This allows recovery when the pending
candidate has become unhealthy, including a lost acknowledgement after kernel
commit. Unknown kernel state and an unhealthy fallback refuse mutation. The
candidate remains retained while its existing flows drain; rollback does not
authorize immediately stopping it. An unresolved first deploy has no invented
fallback target and remains held for recovery.

The hosted acceptance adapter writes and fsyncs a real journal, injects a lost
Traefik acknowledgement after the route actually loads, reconstructs the
publisher from that journal and checks active-flow retirement refusal. The runner
is the only writer in its owned daemon. The native publisher uses the journal
store under runner-scoped OS authority, while its kernel callbacks still traverse
Docker RPC into that isolated daemon. This does not certify target-host fencing:
the production adapter still needs non-stealable host authority, durable ownership
and pipeline cleanup integration. A process-local queue or stale-heartbeat lock
alone must not be used to fence firewall mutation.

`withPersistentPortHostAuthority` provides the Linux worker lock primitive. It
locks an owned private state directory's regular lock file through `flock`, keeps
the open file description in the worker and passes it to each mutator as file
descriptor 3. It closes its reference without explicitly unlocking a surviving
child's reference. Unsupported platforms, writable state directories, hard-linked
lock files, invalid deadlines and escaped command contexts are refused.

`withPersistentPortJournalStore` scopes one service journal to that same host
lock. It snapshots the service claim before waiting, refuses foreign or unsafe
existing entries, bounds decoded state, and commits through a private exclusive
nonce file, file fsync, atomic rename and directory fsync. Reads and writes cannot
escape the authority scope or follow a replaced state directory. FIFO entries
are opened nonblocking and rejected by type. Uncertain failures preserve the
installed intent and never authorize runtime deletion; private orphan files are
left for separately owned recovery when cleanup cannot be proved safe.

The Linux filesystem acceptance exercises process death before and after rename,
lost durable acknowledgement, reload under fresh authority, sync ordering,
malformed/oversized state and alias/ownership guards. Process-death tests do not
simulate storage-device power loss. This store is not yet wired to the production
publisher, managed host namespace or service cleanup paths.

The native process-death acceptance kills the worker while a child is still
running. In the fenced case the competitor enters only after the child finishes;
in the unfenced control it enters before the child finishes. This validates lock
lifetime, not the complete production worker: the target-host network namespace,
trusted helper image, managed state-volume ownership and publisher callbacks still
need wiring. Every kernel mutator must use the inherited-descriptor command path.

1. Persist binding ownership, service generation, immutable Docker IDs, backend
   addresses, keeper identity, firewall capability and publication revision.
   Serialize per-service operations and reject stale revisions. Reconcile kernel
   state after panel/agent restart before permitting cleanup.
2. Validate explicit addresses, port conflicts, Docker firewall topology and
   source-preserving return routing before any serving-state mutation. Refuse
   unsupported nodes before build/deploy consumes a stop-first fallback.
3. Prepare a candidate without published ports, retaining the old application.
   Shared persistent state must explicitly permit concurrent application access.
   Readiness evidence must belong to this candidate ID and deployment generation.
4. Install narrow forwarding grants for old and candidate targets. Publish the
   new DNAT revision only after readiness, then publish and acknowledge Traefik's
   web route. A partial/uncertain acknowledgement retains both runtimes and both
   forwarding grants while authority reconciles or rolls back.
5. Stop the old target only after both routing planes confirm the desired
   generation and its retained flows/application state have drained. Cleanup must
   reject any runtime still referenced by an active or unresolved publication.
6. Adopt existing direct mappings through a separately journaled migration. Port
   ownership cannot be assumed merely because a short preflight bind succeeded.
   Recovery must distinguish the old direct publication, an installed DNAT table
   and a committed keeper before deleting anything.

## MonoSIP v1.8.0: embedded database blocks naive overlap

The operator confirmed the default PostgreSQL in `/data`, not an external
`DATABASE_URL`. The official v1.8.0 installer places this cluster under
`/data/postgres`. Never start two PostgreSQL instances on that directory. Never
delete `postmaster.pid`, wipe the cluster, enable reset-on-failure, or copy live
PGDATA as a database backup.

The same image also embeds Asterisk and stores persistent generated configuration,
recordings and encryption/session secrets. Moving only PostgreSQL does not prove
that two all-in-one replicas can safely serve calls. The v1.8.0 API registers fixed
ARI application names (`monosip-inbound`, `monosip-flow`, `monosip-outbound`), so
control-plane overlap needs explicit application-level verification as well.

Before a live change:

1. Inventory the immutable image, actual volume/mount identity, database major,
   extensions, roles, database name, app migration state, Asterisk configuration,
   recordings and the existence of `/data/.monosip-secrets`. Keep secret values
   out of logs and reports. Confirm the original container still serves.
2. Take an online logical backup using the embedded PostgreSQL tools and an
   encrypted/permission-restricted backup of non-database state. Restore into an
   owned disposable PostgreSQL 17 instance. Check restoration, schema, constraints,
   row counts and application health using copies. A backup without a restore
   rehearsal is not a migration gate.
3. Rehearse a topology with independent PostgreSQL and a separately owned PBX,
   preserving secrets and recording/configuration paths. Verify application
   migrations and ARI ownership before enabling any overlapping web candidates.
   Do not attach a rehearsal candidate to production trunks or send real calls.
4. Plan the final write boundary: an online dump alone misses subsequent writes.
   Use a bounded maintenance cutover with a final consistent export/restore unless
   a separately verified replication path exists. Keep the original data and image
   intact. State clearly that this initial migration has a maintenance window.
5. Verify admin login, encrypted SIP secret access, extensions, trunk registration,
   inbound/outbound calls, WSS, RTP in both directions, STUN and recordings. Inspect
   an actual normal redeploy through public HTTP and SIP clients. Roll back before
   allowing incompatible writes if a gate fails; a new database with newer writes
   cannot be discarded by blindly starting the old database.

These are pending operational gates. No live data has been read, migrated or
modified by the kernel acceptance.

## Acceptance and evidence boundaries

`scripts/smoke-persistent-port-ingress.mjs` refuses to run outside a GitHub-hosted
runner and creates an owned privileged Docker-in-Docker daemon. Its inner networks,
firewall rules, test IP, applications and port keeper are disposable. Cleanup
removes that daemon and its anonymous volumes; it does not enumerate/delete user
containers.

The acceptance checks TCP/UDP on 5060, first/middle/last RTP ports, STUN binding
responses, client source preservation, readiness-held target publication, retained
old flows, new-flow handoff, rollback and web traffic through actual Traefik.
SIP/RTP packet round trips use synthetic endpoints, not a real PBX call test.
Passing this lab proves the network primitive only. It does not certify database
migration, SIP dialog HA, durable ownership, restart recovery or production pipeline
integration. Those remain explicit gates above.

Primary references:

- [MonoSIP v1.8.0 installation](https://github.com/MonoSIP/MonoSIP/blob/v1.8.0/docs/INSTALL.md)
- [MonoSIP v1.8.0 ARI client](https://github.com/MonoSIP/MonoSIP/blob/v1.8.0/apps/api/src/asterisk/ari.ts)
- [nftables stateful NAT](https://wiki.nftables.org/wiki-nftables/index.php/Performing_Network_Address_Translation_(NAT))
- [PostgreSQL server startup and data-directory ownership](https://www.postgresql.org/docs/17/server-start.html)
- [util-linux flock descriptor and child-lifetime semantics](https://github.com/util-linux/util-linux/blob/master/sys-utils/flock.1.adoc)
