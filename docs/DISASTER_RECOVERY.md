# Combined disaster recovery drill

N05 tests recovery of the panel, application volumes and managed database contents in a single sequence. This first drill covers a panel-host Docker service, two named volumes and two PostgreSQL 18 logical backups. It uses an independent RustFS 1.0.4 bucket over HTTPS and a fresh Docker daemon for recovery.

## Prepare the recovery set

1. Keep the S3 endpoint, bucket, prefix, credentials and panel recovery passphrase off-host. Keep the master key separately if it comes from environment variables. The drill uses the file-backed key that the panel snapshot carries.
2. Quiesce writes when the application requires a consistent point across volumes and databases. Capture database dumps and volume snapshots, then confirm that each object reached remote storage. Local backup completion can precede or survive a failed remote upload.
3. Take the encrypted panel snapshot after the data backups. This order captures the metadata and remote object pointers needed by the restore APIs. Record the panel snapshot key and data backup IDs. Keep the recovery set together when applying retention.
4. Record the runtime images, volume names, database engines and routing dependencies needed to bring the application back. The panel snapshot carries configuration and credentials. The payload backups carry the volume files and database contents.

The drill verifies remote object sizes and makes a later change in every source payload before declaring host loss. That change must be absent after restore. The backups are sequential. This procedure gives the operator a way to coordinate writers, and the drill records backup ages rather than assuming a cross-resource atomic snapshot.

## Restore in order

1. Fence the source so its panel, applications and databases cannot write. The drill removes the source panel, its data volume and its Docker daemon, which holds the application and database volumes. The remote provider stays online.
2. Start a fresh panel and sign in as its temporary operator. Add the backup destination with the original prefix. Restore the panel snapshot using the recovery passphrase and confirm its filename. Restart the panel. Sign in as the original operator and verify that the panel can read the restored secrets and settings. The drill also verifies that the running Traefik container mounts the restored configuration directory. [Panel self-backup and restore](PANEL_BACKUP.md)
3. Recreate the empty application volumes by their recorded names. Restore their remote snapshots while the application is stopped. Start the restored PostgreSQL database records on fresh storage and restore their logical dumps.
4. Redeploy the service and verify the volume data through the application route. Verify database credentials and sample queries from the application network using its restored attachments. Keep external traffic fenced until these checks pass.

The test installs a new JWT signing secret on the target and checks rejection of the old access and refresh tokens. Restore of a file-backed master key serves a different purpose. It lets the target decrypt stored credentials and encrypted backups. Inventory and rotate other credentials as required before production cutover.

PostgreSQL logical dumps cover the data and schema supported by the managed dump path. For a WAL recovery set, use the point-in-time recovery runbook and verify the chosen transaction boundary. Backup contents differ by engine. RabbitMQ backups preserve definitions and exclude queued messages. [Remote PostgreSQL recovery archives](PITR_REMOTE_CHECKPOINTS.md) · [Database and backup guide](DATABASES_BACKUPS.md)

## Run the isolated drill

Build a candidate image in the repository and pull the independent S3 server. Docker must support privileged Docker-in-Docker containers. The script creates labelled disposable resources and binds panel ports only to loopback. It pre-pulls public runtime images on the recovery daemon and checks that the daemon has no application containers or volumes when recovery begins. Every run writes a separate receipt directory.

```sh
docker build -t ninedeploy-review:n05 .
docker pull rustfs/rustfs:1.0.4
node scripts/smoke-disaster-recovery.mjs --image=ninedeploy-review:n05 --proof=.temp_files/n05-disaster-recovery
```

Read the run's `result.json` for backup sizes, age at source loss, elapsed time until recovered service verification, pass cases and cleanup result. If deployment fails, check the saved deployment log in the receipt directory. Add `--cutover` to include the node and DNS/ACME steps below.

## Verified result on November 17, 2026

All seven checks passed. **Recovery took 56.7 seconds** from confirmed source removal to serving both protected files through Traefik and querying both databases with the application's restored credentials. The two restored databases contained all four protected rows. Both post-backup inserts and both later file writes were absent.

| Remote artifact | Size in bytes | Age at source loss |
| --- | ---: | ---: |
| Encrypted panel snapshot | 41,251 | 6.9 s |
| Application content volume | 794 | 11.2 s |
| Application assets volume | 195 | 8.2 s |
| `orders` PostgreSQL dump | 1,516 | 12.2 s |
| `ledger` PostgreSQL dump | 1,516 | 12.2 s |

The target rejected an incorrect recovery passphrase before import. After restart, the original operator could sign in. Source access and refresh tokens and the temporary target access token were refused. The master key and saved route file matched their source checksums, and the recreated Traefik container mounted the restored configuration directory. The drill removed its Docker resources and temporary TLS private key.

These timings describe the small fixture on one Docker host with pre-pulled recovery images. The receipt is `.temp_files/package-9-20261117/run-fBiRen/result.json`. [Implementation and test record](plans/PROJECT_REVIEW_2026-11-16.md#ninth-package-implementation-record--november-17-2026)

## Re-enroll nodes and cut over DNS and ACME

1. Before the cutover, record each node's advertised endpoint, server ID, assigned workloads and install or environment configuration. Preserve the surviving agent's state directory, including its persisted identity. Inventory the DNS `A`, `AAAA` and `CNAME` records and their TTLs. If reducing TTL for a planned cutover, allow the previous TTL to expire first.
2. Fence the original panel and the workloads it coordinated on the lost host. Restore the panel and application data as above. Check the recovered application over a private route before redirecting visitors.
3. Rotate the announcement credential in **Settings → Node enrolment**. For each surviving auto-discovered node, set `NINEDEPLOY_MASTER_URL` to the recovered panel and `NINEDEPLOY_ENROLMENT_TOKEN` to the newly issued value. Restart the agent with its existing state directory and advertised endpoint. Confirm the restored registry ID and that **Test connection** reports online. Check the rendered service placement and verify the node can still reach its existing workloads. The announcement credential and the agent's persisted identity serve different purposes. If the identity is lost, inventory the node's dependencies before registering a replacement and reassigning workloads through their normal controls.
4. Update DNS to the recovery ingress. Remove obsolete addresses from both address families. Query the authoritative nameservers and a recursive resolver used by clients. For HTTP-01, confirm the recovered ingress is reachable on port 80. Check the HTTPS route, certificate chain, hostname and expected application response before reopening traffic. [Traefik ACME configuration](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/)
5. Track DNS propagation against the previous TTL. If cutover fails, keep the fenced host out of rotation and return traffic only to a healthy, verified endpoint. Preserve the observed DNS answers, TLS error and proxy logs for diagnosis.

### Run the isolated cutover drill

The cutover starts with HTTP on the source. A separate surviving node runs an application on its own Docker daemon. Following source loss and panel restore, the drill re-announces the agent with its original identity and then changes a single `A` record in a private resolver. Traefik requests a fresh certificate from Pebble using HTTP-01. The test client resolves through the private DNS server and verifies HTTPS with Pebble's signing root and the original hostname. No public DNS or production CA account is needed. [Pebble test CA](https://github.com/letsencrypt/pebble) · [Private DNS controls](https://github.com/letsencrypt/pebble/tree/main/cmd/pebble-challtestsrv)

```sh
docker pull ghcr.io/letsencrypt/pebble:2.10.1
docker pull ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1
node scripts/smoke-disaster-recovery.mjs --image=ninedeploy-review:n05 --cutover --proof=.temp_files/n05-cutover
```

Run the image build and RustFS pull from the preceding drill first. The fixture installs the Pebble API certificate only in Traefik's disposable test image. The receipt reports separate source-loss-to-cutover and DNS-to-verified-HTTPS timings. Public-provider propagation, production certificate issuance and rebuilding a lost node's local workloads require their own acceptance.

### Verified cutover on November 17, 2026

All **11 checks passed**. The surviving agent re-announced under its original server ID, passed an authenticated connection test, and kept its existing application container running on the same daemon. The recovered panel rejected both the old announcement credential and an attempt to announce the same endpoint with a different agent identity.

The visitor reached the source before fencing and failed to connect while the stale DNS answer remained. The private DNS server then returned only the recovery address. Pebble validated a real HTTP-01 challenge for `disaster-recovery.test`, and the visitor verified the issued certificate chain and hostname. Both protected files returned HTTP 200 over HTTPS, and plain HTTP redirected with HTTP 302. The redeployed service queried both restored PostgreSQL databases with the recovered credentials.

| Measured interval | Elapsed |
| --- | ---: |
| Source removal to private application verification | 61.7 s |
| Source removal to completed node and HTTPS cutover | 75.7 s |
| Start of DNS cutover to verified HTTPS and redirect | 9.9 s |

The private DNS fixture used a zero-second TTL. The final receipt is `.temp_files/package-10-20261117/run-prSMZv/result.json`. [Implementation and test record](plans/PROJECT_REVIEW_2026-11-16.md#tenth-package-implementation-record--november-17-2026)

## Recover a node after complete local state loss

1. Record the node's registry ID, advertised host and agent port. Keep the operator's SSH access and the encrypted panel snapshot off-host. Back up the application volume and database and verify their remote objects before taking the panel snapshot.
2. Fence the old node. Rebuild Docker on the replacement and assign the original private agent endpoint. Verify the new SSH fingerprint out of band. Use **Servers → SSH Bootstrap** for that endpoint and provide the verified fingerprint. Bootstrap should retain the server ID and create a new agent credential, preserving the service and database placements.
3. Recreate the empty application volume on the node. Keep the application stopped while restoring the remote volume snapshot. Start the managed PostgreSQL record on its fresh volume and restore its logical dump. Redeploy the application and verify both its route and a database query from the application network.

The drill removes the old node, including its Docker state and agent files. It proves that a stale SSH fingerprint cannot provision the replacement. Recovery supplies the new fingerprint explicitly and uses only the recovered panel registry, remote backups and the operator's SSH key.

Build the panel candidate and pull RustFS as above. Create an SSH-capable Docker-in-Docker image for the fixture with this Dockerfile.

```dockerfile
FROM docker:28-dind
RUN apk add --no-cache openssh-server openssh-keygen && mkdir -p /run/sshd /root/.ssh
```

```sh
docker build -t ninedeploy-dr:ssh-fixture -f /path/to/fixture.Dockerfile .
node scripts/smoke-disaster-recovery.mjs --image=ninedeploy-review:n05 --replace-node=ninedeploy-dr:ssh-fixture --proof=.temp_files/n05-node-loss
```

SSH bootstrap uses the registry agent image for the candidate's version. The fixture requires that image to be available to its private Docker daemons.

### Verified node replacement on November 17, 2026

The combined drill passed **11 checks**. The replacement began with an empty Docker daemon and no agent directory. The panel refused the original host fingerprint before starting an agent. It accepted the independently verified replacement fingerprint, kept the original server ID and issued a fresh agent credential. The application and managed database kept their registry placements.

The recovery used a **767-byte node volume archive** and a **1,520-byte PostgreSQL dump** from RustFS. The redeployed application served the protected file through node Traefik and queried both protected rows through its restored attachment. The later file change and database insert were absent. Recovery took **193.1 seconds** from removal of the original node to application verification, including panel recovery and cold image pulls. The final receipt is `.temp_files/package-11-20261117/run-KNnPFV/result.json`. [Implementation and test record](plans/PROJECT_REVIEW_2026-11-16.md#eleventh-package-implementation-record--november-17-2026)

## Verify public DNS and ACME staging

Set `N05_DNS_ZONE` to an authorized Cloudflare zone and `N05_DNS_SUFFIX` to a test suffix within it. Provide `CLOUDFLARE_DNS_API_TOKEN` through the environment with **Zone DNS Edit** and **Zone Read** scoped to that zone. The drill generates a random name under the suffix and creates a DNS-only record. It keeps existing names out of the cutover. [Cloudflare DNS record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/)

```sh
node scripts/smoke-disaster-recovery.mjs --image=ninedeploy-review:n05 --cloudflare-staging --proof=.temp_files/n05-cloudflare-staging
```

The drill checks both assigned authoritative nameservers and a public recursive resolver before and after changing the record. The published addresses belong to disposable private Docker gateways, so the visitor runs inside the fixture and uses the IP returned by public DNS. Traefik uses DNS-01 and the Let's Encrypt staging directory. The client validates the certificate with the official staging roots, which stay confined to the test client. The run removes its DNS record and any test challenge TXT records and reports cleanup in its receipt. Public internet reachability at an operator's origin is a separate check. [Let’s Encrypt staging environment](https://letsencrypt.org/docs/staging-environment/)

### Public cutover preflight on November 17, 2026

The suggested hostname, `ninedeploy.vm.oxog.net`, resolved through public DNS and returned HTTPS 200 from `/health`. Cloudflare was authoritative for `oxog.net`. The Let's Encrypt staging directory returned a replay nonce, and a separate HTTPS request verified the certificate chain of the CA's official staging test site. The public cutover and a new staging order for the drill hostname await a zone-scoped Cloudflare token. The preflight made zero DNS changes. Evidence is in `.temp_files/package-11-20261117/dns-preflight.json` and `staging-preflight.log` in the same directory. [Official staging CA and test sites](https://letsencrypt.org/docs/staging-environment/#root-cas)

On November 18, both Cloudflare authoritative nameservers again agreed on the existing deployment's address, `/health` returned HTTPS 200, and the staging endpoint returned a replay nonce. The candidate image built and 164 focused server and documentation tests passed. The Cloudflare token was unavailable to the drill process, so this attempt stopped before creating a DNS record or opening an ACME order.
