# Capacity and resilience baseline

N06 begins with the capacity of one healthy NineDeploy panel. The test starts a fresh panel and two sealed agents on three private Linux Docker daemons. Only the test panel publishes a port, bound to loopback. The daemons, image registry, webhook log sink, and panel data volume belong to the run and are removed after it. The test uses its own panel registration, agent credentials, and private image registry.

## Run the baseline

Use a local Linux Docker engine, Docker Desktop in Linux container mode, or a disposable Linux runner. The engine must support Docker-in-Docker. Load the candidate and fixture images before starting.

```sh
docker pull docker:28-dind
docker pull registry:2
docker pull nginx:1.27-alpine
docker pull traefik:3
docker pull ghcr.io/ninedeploy/ninedeploy@sha256:113fb9e11ad3f8f94d38020e00e7744ad10c2f57c614afda89f089db2f4e51bf
node scripts/smoke-capacity-baseline.mjs --image=ghcr.io/ninedeploy/ninedeploy@sha256:113fb9e11ad3f8f94d38020e00e7744ad10c2f57c614afda89f089db2f4e51bf --proof=.temp_files/n06-capacity
```

For a later candidate, pass its local image name or immutable reference. Compare the recorded engine, image digests, and host resources when comparing results. The script saves its profile, limits, and image identities before setup. It writes raw request durations, event-loop samples, deployment records, log queue observations and receiver counts, and a final threshold-by-threshold receipt to a fresh `run-*` directory. Any failed threshold, setup error, or failed resource cleanup produces a nonzero exit status.

## Workload

- The panel registers 12 service definitions. Four services are first deployed and warmed. One is the log source. Three serve as the deployment targets, one on the panel daemon and one on each agent node.
- After a 10-second API warmup at 8 requests per second, the steady window lasts 60 seconds. It schedules 480 authenticated requests at fixed intervals, with 120 each for services, nodes, the deploy queue, and recent activity. The driver records both its launch delay and request time through response-body consumption.
- At 5 and 30 seconds, three real deployments enter the public API queue simultaneously. The private registry serves the same cached application image for every deployment. API timestamps give queue wait to one-second resolution. A later deploy can supersede an older one, so the probe requires the successful completion marker in each deployment's log.
- At 10, 25, and 40 seconds, the running log source emits 400 uniquely numbered lines per burst through its Docker stdout. NineDeploy's real shipper delivers to a private webhook sink. The driver polls the queue every two seconds and checks the sink for missing and duplicate lines after the load.
- After delivery and deploys settle, the driver restarts the panel container with its data volume. Recovery ends when the health route and authenticated service, node, and log queue reads succeed with the expected state.

## Acceptance thresholds

| Metric | Budget |
| --- | ---: |
| Requests completed per route | 120 |
| p95 response time per route | At most 350 ms |
| Failed HTTP or transport responses | 0 |
| p95 request launch delay | At most 250 ms |
| Panel event-loop coverage | At least 50 one-second windows |
| Worst one-second event-loop p95 | At most 100 ms |
| SQLite busy or locked diagnostics | 0 |
| Panel volume growth | At most 24 MiB |
| Deployments completed | 6 |
| Deployment queue wait p95 | At most 25 s |
| Peak pending log entries sampled | At most 1,200 |
| Final pending, missing or duplicate log entries | 0 each |
| Controlled panel restart to usable API | At most 30 s |

The in-process probe uses Node's event-loop delay histogram at 10 ms resolution. SQLite contention is counted from panel log lines that report busy or locked errors. Storage growth is measured with `du -sk /data` from just before the steady window through completion of the workload, and the receipt also reports logical SQLite file sizes. The storage budget covers panel state. The log queue peak is a two-second sampled observation.

This baseline establishes the healthy workload and the controlled restart budget on the recorded host. The follow-up resilience slice will reuse the workload with a slow node, full disk, and unreachable log destination. Host-loss RPO and restore timing are recorded in the [disaster recovery drill](DISASTER_RECOVERY.md).

## Baseline measurements on November 18, 2026

The candidate was the published NineDeploy v0.19.0 image built from `0a59b5ed4068334b5ee0d1ad36e43959e92525ba`. The load driver used Node 26.13.0 on Windows. Docker Desktop's Linux engine was Docker 29.9.3 with four CPUs and 7.76 GiB of memory. The panel used one deploy worker and fresh data for each run. The fixture image digests were recorded before the measurements.

| Fixture | Recorded registry digest |
| --- | --- |
| Docker-in-Docker | `docker@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac` |
| Private registry | `registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373` |
| Application | `nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10` |
| Traefik | `traefik@sha256:22a759fb803abb5c3a7ba5d5a55a201c5fb0fc8993d5c72c47a89075e64f1953` |

The thresholds were fixed before the first run. Two setup attempts stopped before measurement on the Windows archive copy and a log drain type rejected by the API. A later measurement exposed a fixture assertion that counted previously successful, subsequently superseded deployments as failures. The final fixture streams the preload archive, uses the HTTP log drain, and requires a successful deployment log for both running and superseded rows.

Both fresh runs passed all 21 checks.

| Measurement | Run 1 | Run 2 |
| --- | ---: | ---: |
| Authenticated requests, errors | 480, 0 | 480, 0 |
| Services API p95 | 19.2 ms | 58.1 ms |
| Nodes API p95 | 9.8 ms | 30.3 ms |
| Deploy queue API p95 | 11.4 ms | 31.8 ms |
| Recent activity API p95 | 28.7 ms | 23.8 ms |
| Request launch delay p95 | 13.9 ms | 13.6 ms |
| Panel event-loop windows | 58 | 59 |
| Worst one-second event-loop p95 | 15.6 ms | 51.7 ms |
| SQLite busy or locked diagnostics | 0 | 0 |
| Panel volume growth | 108 KiB | 108 KiB |
| SQLite file growth | 84 KiB | 84 KiB |
| Deployments completed, queue wait p95 | 6, 6 s | 6, 5 s |
| Peak sampled pending log entries | 400 | 0 |
| Log lines received, missing, duplicated | 1,200, 0, 0 | 1,200, 0, 0 |
| Final pending log entries | 0 | 0 |
| Controlled panel restart to usable API | 5.29 s | 4.61 s |

The queue sampler saw no pending entries in the second run. Both runs delivered every numbered log line and ended with an empty queue. An independent check recomputed route percentiles and queue wait from the raw samples, matched every numbered log at the receiver, and confirmed that zero run-labeled containers, volumes, or networks remained.

The run receipts and raw samples are under `.temp_files/n06-capacity-20261118/run-OJOmmI/` and `.temp_files/n06-capacity-20261118/run-NO855S/`. The observed margins apply to this workload and host. The highest observed route p95 was 58.1 ms against the 350 ms budget.
