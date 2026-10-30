# Resource history, metrics export and durable logs

Status: resource history, Prometheus and OTLP export shipped in 0.18.2;
error-rate and latency alerts are on main for the next release. Validation is
tracked in [competitive delivery](COMPETITIVE_DELIVERY.md).

## Configure resource history

An operator can open **Monitoring → Resource history and metrics export** or use:

```sh
ninedeploy metrics settings
ninedeploy metrics configure --retention-days 30 --log-queue-mb 32
```

The default remains **one day**, with export disabled. Retention accepts 1–90 days.
Raw CPU/memory samples are retained for approximately 24 hours; opted-in history
uses five-minute summaries through seven days and hourly summaries thereafter.
Cleanup aligns with summary boundaries so adjacent tiers do not overlap or leave
a partial boundary bucket missing. Chart queries return weighted averages over
the complete requested interval, bounded to roughly 900 points. Longer charts
therefore smooth spikes. CPU is percent (100 means one core); memory charts use MiB.

Select 1 hour, 24 hours, 7, 30 or 90 days in a service's resource charts. A longer
selection does not recover data already removed under an earlier retention
setting. Reducing retention deletes older summaries during the next cleanup.
The existing per-service visibility checks still apply.

This covers currently collected local and ordinary node-service CPU/memory.
Remote Swarm task aggregation, fan-out destination history and node-only database
history remain separate work. Monitoring's panel-host totals stay local.

## Prometheus

Enable **Prometheus scraping**, or:

```sh
ninedeploy metrics configure --prometheus on
```

Scrape **GET /v1/stats/prometheus** using an operator bearer credential. Disabled
export returns 404; unauthenticated or non-operator callers cannot read it.
Use HTTPS and store the credential in the scraper's secret store/file, rather
than embedding it in a shared configuration. A dedicated read-only scrape token
is not provided by this increment; the credential must have operator API access.

Example Prometheus configuration:

```yaml
scrape_configs:
  - job_name: ninedeploy
    scheme: https
    metrics_path: /v1/stats/prometheus
    static_configs:
      - targets: ["panel.example.com"]
    authorization:
      credentials_file: /run/secrets/ninedeploy_operator_token
```

Text exposition uses these gauges:

| Metric | Value |
| --- | --- |
| ninedeploy_service_cpu_percent | CPU percent; 100 is one core |
| ninedeploy_service_memory_bytes | Resident memory in bytes |
| ninedeploy_service_sample_timestamp_seconds | Collection time in Unix seconds; includes a kind label |

Series include service_id, service and server_id (panel for local services).
Only samples from the last 120 seconds are exposed. Missing/stale samples remain
absent rather than becoming zero. Export is bounded to 10,000 CPU/memory series.

## OTLP/HTTP JSON

Configure the full metrics receiver URL, including **/v1/metrics** where required.
This is OTLP/HTTP JSON, not gRPC:

```sh
ninedeploy metrics configure --otlp-endpoint https://collector.example.com/v1/metrics
# Set COLLECTOR_AUTH securely in your shell/secret manager before this command:
ninedeploy metrics configure --otlp-authorization-env COLLECTOR_AUTH
```

The selected variable supplies the complete Authorization header, for example a
Bearer credential. Its value is never printed by these CLI commands. Omitting
the field preserves a saved credential; explicit removal uses
**--clear-otlp-authorization**. An empty endpoint disables export.

The panel exports every 30 seconds after an initial 15-second delay. The
Monitoring card can test the saved destination immediately and shows the last
attempt/result. Export status is process-local and resets on restart. Each
request has a six-second timeout, rejects redirects, bounds the receiver response
to 16 KiB and reports partial rejection as failure. Failed metric exports are
not spooled; the next cycle sends current samples.

The normal outbound URL policy applies. An internal collector requires the
existing **NINEDEPLOY_ALLOW_PRIVATE_EGRESS=1** operator setting. URL userinfo,
fragments and CR/LF in authorization are rejected. Settings, including the
collector credential, are encrypted in Config Center and participate in master
key rotation. The monitoring API returns only whether a credential is saved.

This exporter handles infrastructure CPU/memory gauges. Existing
**metrics show/flush** commands still refer to the separate kernel event archive;
their backend settings do not configure this exporter.

## Durable captured-log delivery

Each log drain now has an encrypted SQLite queue and persistent cursor per
runtime, host and destination binding. Capture commits a batch and cursor
together. A stopped source container does not prevent delivery of an already
captured batch, including after a panel restart. A failing destination retries
with exponential backoff (10 seconds up to five minutes); another successful
destination does not need to resend its acknowledged batch.

Delivery is **at least once**. A receiver accepting a request before the panel
records acknowledgement can receive a duplicate. New runtimes start at the
current time, without backfill. Capture is bounded: remote reads return at most
1,000 lines/256 KiB and may clip long lines; local Docker reads are also bounded.
Logs rotated before capture or produced faster than those reads can be lost.
PM2 file logs and secondary Compose services are outside this delivery path.
A durable captured queue is not a guarantee of lossless source collection.

The default queue limit is 16 MiB of payload per destination (configurable
1–256 MiB), with an additional 10,000-batch ceiling. SQLite/encryption overhead
uses additional disk space. Batches contain at most 1,000 entries/256 KiB.
When full, capture pauses without advancing that source cursor or evicting
pending data. An oversized single entry also pauses capture. The log-drain
card shows queue depth, oldest batch, blocked batches and paused sources.

Changing a drain's URL, headers, format, service filter or resolved credential
does not forward old batches to the changed destination: those batches remain
blocked. Reverting to the original binding allows retry, or an operator can
explicitly discard the old queue. Master key rotation re-encrypts the queue
without changing its resolved destination binding. Disabling a drain retains its
queue; deleting the drain or service deletes related queued data.

```sh
ninedeploy log-drains queue 4
ninedeploy log-drains retry 4
ninedeploy log-drains discard 4 --yes
```

Retry schedules delivery for the next cycle; it does not certify delivery.
Discard permanently removes pending batches without rewinding the source cursor.
The panel requires an explicit confirmation for the same operation.

## Log drain targets (G3.4)

Besides Loki, Datadog, Vector, syslog-over-HTTP and plain HTTP, a drain can send to the services below. They use the same shipper, with batches, retries, the durable queue and the egress guard. The body format is the target's own, so the drain's format setting does not apply to them.

| Type | URL | API key |
| --- | --- | --- |
| `elasticsearch` (also OpenSearch) | the index or data stream, `https://es.example.com:9200/logs-ninedeploy`; batches go to `_bulk` as `create` actions | `user:password` (basic auth) or an Elasticsearch API key |
| `splunk` | the HEC event endpoint, `https://splunk:8088/services/collector/event` | the HEC token |
| `betterstack` | the source's ingesting host | the source token |
| `newrelic` | `https://log-api.newrelic.com/log/v1` (or the EU host) | a license or ingest key (`Api-Key`) |
| `axiom` | `https://api.axiom.co/v1/datasets/<dataset>/ingest` | an API token |
| `cloudwatch` | `https://logs.<region>.amazonaws.com/?group=<log group>&stream=<log stream>` | `ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]` |

**Notes per target**
- **Elasticsearch:** answers 200 even when some documents were refused. The shipper reads the `errors` flag and retries the batch, reporting the first reason.
- **CloudWatch:** signed with SigV4 (`PutLogEvents`). The log group and stream are created the first time AWS says they do not exist. The key needs `logs:PutLogEvents`, plus `logs:CreateLogStream` and `logs:CreateLogGroup` if they should be created.
- **Saving a drain:** a URL that does not name what its target needs is refused (422). That means the index for Elasticsearch, and the region, group and stream for CloudWatch.

**Storage:** no migration is needed; the drain type is a text column without a CHECK.

## Search shipped logs

When a Loki drain is enabled, the lines it received can be searched, including
those of containers that no longer exist. On a service, open **Activity Logs →
Search shipped logs** (web UI since G1.5), type the text to find and pick a
window from 15 minutes to 7 days; up to 500 matching lines are shown. The CLI
(`ninedeploy logs search`) and `POST /v1/log-drains/search` do the same, and an
operator can also search across all services there. Searching one service needs
`member` on it, and on a protected lane the lane's admin rights. A member's
window never starts before the service was created, because a reused service
name could otherwise show a deleted service's lines. Without an enabled Loki
drain the search answers that no drain exists; drains of other types cannot be
searched.

## Error tracking (G5.4)

Any Sentry SDK can report a service's errors to the panel. Create the DSN under **Service → Activity → Errors**. It is shown once, as `https://<key>@<panel host>/<serviceId>`. Give it to the SDK as `SENTRY_DSN`. Set `SENTRY_RELEASE` to the commit SHA the service runs, for example from a build argument. The SDKs read both variables themselves:

```js
Sentry.init({ dsn: process.env.SENTRY_DSN, release: process.env.SENTRY_RELEASE });
```

Without a release, an issue is linked to the deploy that was live when it first happened.

**Ingest**
- `POST /api/<serviceId>/envelope/`, and the older `POST /api/<serviceId>/store/`.
- The key is accepted from the `X-Sentry-Auth` header, from `?sentry_key=` (browser SDKs), or from the envelope's `dsn`.
- Bodies may be plain, gzip, deflate or br, up to 1 MiB uncompressed.
- Only `event` items are stored. Sessions, transactions and attachments are skipped.
- Limits: 600 requests a minute per client and 300 events a minute per service. Past them the answer is 429 with `X-Sentry-Rate-Limits`, which the SDKs honour.

**Issues**
- Events are grouped by fingerprint: the SDK's `fingerprint` when given, otherwise the exception type and its last five in-app frames. Without frames, the normalised message is used, with digits, hex ids and quoted values masked.
- Each issue keeps its count, first and last sighting, and the deploy it first appeared under. That is the deploy whose commit is the event's `release`, otherwise the live deploy.
- An issue can be resolved, ignored or reopened. A resolved issue that happens again reopens by itself.

**Alerts**
- A new issue is audited as `alert.error_new`, and a reopened one as `alert.error_regressed`.
- Both reach the notification channels that receive alerts.

**Access**
- Issue titles are exception messages, and event payloads may carry request headers and user data. Both are for members and up, as are creating, replacing and removing the DSN.
- Viewers only see whether the service has a DSN.

**Bounds**
- A browser DSN is public, so anyone can send events.
- An issue keeps its first 5 events and its latest 15, each payload capped at 32 KiB. A flood therefore cannot evict the first evidence. An SDK retry with the same `event_id` is counted but not stored twice.
- Past 500 unresolved issues in a service, new fingerprints are counted under one overflow issue. Resolving or ignoring issues makes room again, up to a hard cap of 1,500 issues of any status.
- Alerts are limited to 10 per service per hour. The next one is `alert.error_burst`, and then alerts stay quiet until the hour ends. Reaching the issue cap always alerts.
- Alerts name the service and the issue number, never the text the sender chose.

**Retention**
- Events are kept 30 days.
- An issue not seen for 90 days is removed with its events, by the housekeeping step `error-events`.
- The key is stored as a SHA-256 hash in the settings row `error_ingest:<serviceId>`.

**Upgrade**
- Migration `0105_error_ingest` only adds the two tables.

## Error-rate and latency alerts

Two alert metrics read the traffic analytics of one service: `error_rate`, the share of requests answered 5xx in percent, and `latency_p95`, the 95th percentile response time in milliseconds. Add them under **Monitoring → Alert Rules**, or with `POST /v1/alerts` (operator), for example `{ "name": "api errors", "metric": "error_rate", "operator": ">", "threshold": 5, "serviceId": 12 }`.

**How they are measured**
- Each 30-second collector tick sums the minute rollups of the last 5 minutes for the rule's service, across all its domains.
- A service with fewer than 20 requests in that window gets no sample, so its rule keeps its current state: two failed requests on a quiet service are not an outage, and silence is not a recovery.
- The p95 is estimated from the latency histogram (buckets 5 ms to 10 s), so it is exact only to its bucket.
- Fire-after counts collector samples as for every other metric. Because the window is 5 minutes, a short spike keeps the value up for up to 5 minutes.

**Limits**
- Traffic analytics must be on (**Traefik → Traffic**). With it off, these rules never sample.
- They are per service: a rule without a `serviceId` is refused (`error_rate rules are per service`), and so is a patch that clears it.
- Only traffic that passes the panel host's Traefik is counted, as in the traffic view.
- Fired and recovered alerts go to the same channels and subscriptions as the other alert metrics. No migration: `alert_rules.metric` is free text.

## Usage and cost

**Monitoring → Usage and cost** (operators) shows what each service used over the last 24 hours or 7, 30 or 90 days, and what that cost. Group it by service, project or workspace.

What is counted:
- **CPU in core-hours.** One fully busy core for an hour is 1. It comes from the 30-second samples and their summaries described under [resource history](#configure-resource-history). The window uses the same tier boundaries as the charts, so no sample is counted twice.
- **Memory in GiB-hours**, from the same samples.
- **Disk in GB-hours**: once an hour, the panel measures the volumes each service mounts, its data volume and its attached volumes, and stores the total. The panel host reads every volume with one `docker system df -v`; a node's agent measures each volume. A volume that cannot be measured is left out of that hour rather than counted as zero. Disk follows the same retention as CPU and memory.
- **Egress in GB and requests**, from the hourly rows of traffic analytics. Both stay at zero while traffic analytics is off.

Each sample stands for one 30-second interval. A collection cycle the panel skipped, for example while it was restarting, is not counted.

CPU and memory reach back only as far as resource history is kept. With the default of one day, a 30-day window counts one day, and the card says so. Raise the retention to cover longer windows; data already deleted does not come back.

**Cost.** Under *Server costs*, enter what each server costs a month and the currency. The panel host is one of the servers. For a window, the panel:
1. prorates each server's monthly cost at 730 hours a month;
2. splits it among the services on that server: half by their share of its CPU time, half by their share of its memory.

A server that measured nothing keeps its whole cost as *not carried by any service*. A server with no cost entered leaves its services unpriced.

Limits:
- A service is priced on its primary server. Extra placements and Swarm tasks on other nodes are not split out.
- A service tagged into two projects or workspaces counts in both, so group rows do not add up to the total.
- Disk is reported but does not enter the cost split, which stays half CPU, half memory. Database volumes are not counted, since the report covers services.

Routes (operator only):
- `GET /v1/usage?days=30` returns the report, 1–90 days.
- `GET` and `PUT /v1/usage/costs` read and set the costs, for example `{ "currency": "EUR", "servers": [{ "serverId": null, "monthlyCost": 40 }] }`, where `serverId: null` is the panel host. A change is audited as `usage.costs_update`.

SDK: `usage.report({ days })`, `usage.costs()` and `usage.setCosts(input)`.

No migration: the costs are one settings row (`usage_costs`). Nothing new is collected.

## API and SDK

All monitoring settings/export and log-queue management routes require an
operator. Queue responses contain counts and timestamps, never queued log payloads.

| Method and path | SDK |
| --- | --- |
| GET /v1/stats/observability | stats.observability.get() |
| PATCH /v1/stats/observability | stats.observability.update(patch) |
| POST /v1/stats/observability/test | stats.observability.test() |
| GET /v1/stats/prometheus | Authenticated text scrape |
| GET /v1/log-drains/:id/queue | logDrains.queue(id) |
| POST /v1/log-drains/:id/queue/retry | logDrains.retryQueue(id) |
| DELETE /v1/log-drains/:id/queue | logDrains.discardQueue(id) |

PATCH accepts retentionDays, prometheusEnabled, otlpEndpoint,
otlpAuthorization and logQueueMaxMb. Omitted fields remain unchanged.

## Upgrade and recovery

Migration **0096_observability_delivery** adds metric_rollups,
log_drain_cursors and log_drain_batches. Existing service data and the one-day
default are preserved. Save the panel database and master keys together:
encrypted queued logs cannot be recovered without their keys. Do not manually
drop the new tables during a downgrade; older binaries do not deliver this queue.
Use the normal panel backup/restore procedure before any rollback.
