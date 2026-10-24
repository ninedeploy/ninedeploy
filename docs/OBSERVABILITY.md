# Resource history, metrics export and durable logs

Status: implemented on the working branch after 0.17.1; validation is tracked in
[competitive delivery](COMPETITIVE_DELIVERY.md). These changes are not part of the
published 0.17.1 release.

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
