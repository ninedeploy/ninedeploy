# CI jobs on your own runners (R5)

NineDeploy can run a service's tests or build steps on machines you enrol as **runners**. A pipeline is a container image and a shell script. A job is one run of the pipeline at a commit.

The panel keeps every job and every attempt in its database. Runners pull work over HTTPS with their own token; the panel never connects to them.

In the panel, a service's **CI** tab holds its pipeline, its jobs and each attempt's log, and **Settings → CI runners** enrols runners. The SDK exposes the same through `client.ci`, and the CLI through `ninedeploy ci`:

```sh
ninedeploy ci runners add builder-1 --labels linux,x64 --capacity 2   # prints the token once
ninedeploy ci runners list
ninedeploy ci set web pipeline.json          # the JSON body shown below
ninedeploy ci run web --ref main --follow    # exits non-zero unless the job succeeds
ninedeploy ci jobs web
ninedeploy ci log web 12 --follow
ninedeploy ci approve web 12                 # or: cancel
```

## Enrolling a runner

An operator creates the runner in **Settings → CI runners**, or with the API, and receives its token once (`ndrun_…`). Only the token's hash is stored.

```sh
curl -X POST https://panel.example.com/v1/ci/runners \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"builder-1","labels":["linux","x64"],"capacity":2}'
```

On the runner machine, start the panel image's runner with Docker. The work directory must be mounted **at the same path** on the host, because the job containers' bind mounts are resolved by the host's Docker:

```sh
docker run -d --name ninedeploy-ci-runner --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/ninedeploy-runner:/var/lib/ninedeploy-runner \
  -e NINEDEPLOY_RUNNER_WORKDIR=/var/lib/ninedeploy-runner \
  -e NINEDEPLOY_RUNNER_URL=https://panel.example.com \
  -e NINEDEPLOY_RUNNER_TOKEN=ndrun_… \
  -e NINEDEPLOY_RUNNER_CAPACITY=2 \
  ghcr.io/ninedeploy/ninedeploy:v<panel version> node apps/server/dist/ciRunner.js
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `NINEDEPLOY_RUNNER_CAPACITY` | 1 | Jobs run at the same time. The panel also checks this against the runner's recorded capacity. |
| `NINEDEPLOY_RUNNER_MEMORY` | `2g` | Memory limit of each job container. |
| `NINEDEPLOY_RUNNER_CPUS` | `2` | CPU limit of each job container. |
| `NINEDEPLOY_RUNNER_PIDS` | 1024 | Process limit of each job container. |
| `NINEDEPLOY_RUNNER_WORKDIR` | the system temp directory | Where job workspaces are created. |
| `NINEDEPLOY_RUNNER_NETWORK` | `isolated` | `isolated`: each job gets a bridge network of its own. `none`: jobs get no network at all (no package downloads either). |

`DELETE /v1/ci/runners/:id` revokes a runner:

- its token stops working at once;
- jobs it was running are requeued;
- at its next heartbeat it is refused and kills them.

`GET /v1/ci/runners` lists every runner with its labels, capacity, online state (seen within 90 s) and running attempts.

## A service's pipeline

A service admin sets the pipeline (`PUT /v1/services/:id/ci`):

```json
{
  "image": "node:24-alpine",
  "script": "npm ci\nnpm test",
  "labels": ["linux"],
  "secrets": ["NPM_TOKEN"],
  "timeoutMinutes": 30,
  "maxAttempts": 2,
  "requireApproval": false,
  "runOnPush": true,
  "gateDeploys": false
}
```

| Field | Meaning |
| --- | --- |
| `script` | Runs with `sh -e` in `/workspace`. |
| `labels` | A runner must carry every one of them to take the job. |
| `secrets` | Names of **service variables** the job receives as environment. Nothing else from the service reaches it, and a PR preview receives none. Setting the pipeline is admin-only for this reason. |
| `maxAttempts` | Total tries when a runner is **lost** mid-job. A script that fails is not retried. |
| `requireApproval` | Holds every job until a service admin approves it (`POST …/ci/jobs/:jobId/approve`). Runners see nothing before that. |
| `runOnPush` | A push to the service branch runs a job at the pushed commit (see below). |
| `gateDeploys` | Every deploy waits for a job at its commit and builds only what the job passed (see below). |

Members run the pipeline with `POST /v1/services/:id/ci/jobs` and an optional `{ "ref": "<branch or commit>" }`; the service branch is used by default. A job copies the pipeline when it is created, so later edits never change it.

`GET /v1/services/:id/ci/jobs/:jobId` shows the job with its attempts: runner, status and exit code.

`GET …/attempts/:number/log?offset=<bytes>` reads the log from that byte on:

- it answers `{ "data": "…", "size": 1234, "done": false }`: ask again with `offset=size` for what came after, until `done` is true (the panel's CI tab follows a log this way);
- the log is capped at 8 MiB per attempt;
- on a protected lane, only the lane's admins can read it.

Finished jobs and their logs are removed after 30 days.

## Jobs on push

With `runOnPush`, a verified push webhook for the service branch runs a job at the pushed commit:

- a `[skip ci]` or `[skip cd]` marker in the head commit skips the job as it skips the deploy;
- a job runs even when watch paths skip the deploy;
- a replayed delivery for a commit that already has a push job adds none;
- the webhook's answer names the job (`ciJobId`).

When the pipeline also has `gateDeploys`, the push adds no job of its own: the deploy it queues runs one.

## Deploys gated on CI

With `gateDeploys`, every deploy of the service waits in **`awaiting_ci`** until a job passes, whatever queued it: a push, the UI, the API, a schedule or a rollback.

1. When the deploy reaches the front of the queue, the panel creates a job at the deploy's commit (or at the branch head when the deploy names none). The job is linked to the deploy, and the deploy holds no build slot while it waits.
2. The job checks out the source and pins the commit it tested.
3. When the job passes, the deploy gets that commit and is queued again. The build checks out exactly that commit, and the pipeline refuses to build any other.
4. When the job fails or is cancelled, the deploy fails with the job's error.

More rules:

- Cancelling a waiting deploy, or replacing it with a newer one, cancels its job.
- An approval given before the commit was known is cleared, as with the GitHub workflow gate.
- When the service also requires GitHub workflows, the NineDeploy job runs first and the GitHub check then verifies the commit the job pinned.
- **PR previews** of the service are gated by the same pipeline. Their jobs get none of the service's variables. A job for a pull request from a **fork** waits for a service admin to approve it before any runner sees fork code.
- Removing the pipeline, or turning `gateDeploys` off, lets waiting deploys through at the next check.

## What a job sees, and what it doesn't

The runner fetches the source from the panel (`GET /v1/ci/runner/attempts/:id/source`):

- The panel checks it out with the service's own Git credential, or uses the uploaded source archive.
- It sends the files as a tar.gz **without `.git`**, so the credential in the remote URL never leaves the panel.
- The first checkout pins the commit on the job, so a retry builds the same tree.
- The job sees the commit as `NINEDEPLOY_CI_COMMIT`, with `CI=true`, `NINEDEPLOY_CI_JOB` and `NINEDEPLOY_CI_ATTEMPT`.

The job container:

- gets `/workspace` and the variables the pipeline names;
- runs with `no-new-privileges` and the memory, CPU and process limits above;
- is removed when it ends;
- never gets the Docker socket, the runner token or its lease token.

Variable values reach Docker through the client's environment, not its command line.

Some names would change the runner's own Docker client rather than the job, so the pipeline refuses them as `secrets`:
- `PATH`, `HOME`, `LD_*`, `DYLD_*`
- `DOCKER_*`, `BUILDKIT_*`, `NODE_*`
- the proxy and CA variables
- `BASH_ENV`, `ENV`, `IFS`, `CI`, `NINEDEPLOY_*` and similar

The panel and the runner drop such a name again before a job starts.

Each job runs on a Docker bridge network of its own (`nd-ci-net-<attempt>`), removed with the job:

- it cannot reach other containers on the runner machine by their address, nor another job;
- it can still reach the internet, the runner machine itself (and ports published on it) and whatever the machine's network reaches.

So use a dedicated machine for runners and keep production networks out of its reach. With `NINEDEPLOY_RUNNER_NETWORK=none`, jobs have no network at all.

## Recovery

All of a job's state lives in the panel's database.

| Event | What happens |
| --- | --- |
| Two runners ask for the same job | A conditional update gives it to one; the other gets nothing. |
| A runner reports | Each attempt has a 60-second **lease** that the runner renews every 15 s. Every report carries the attempt's lease token, which is bound to that runner. |
| A runner disappears | It crashes, loses its network or is killed. Its lease lapses, the attempt is marked **lost**, and the job is requeued, or failed once `maxAttempts` is used up. When that runner comes back, its heartbeat answers `stop`, its result is refused (409), and it removes the containers it left when it restarts. **A job can't be counted as succeeded twice.** |
| A job is cancelled | Its runner kills the container at its next heartbeat. A late result does not count. |
| The panel restarts | Every live lease gets a fresh period, so runners that could not report while the panel was down are not declared lost. Log chunks are numbered and retried for about five minutes, so the log keeps its order and loses no lines. |

The runner protocol is described in the API document under the `ci` tag (`/v1/ci/runner/claim`, `…/heartbeat`, `…/log`, `…/finish`, `…/source`).

## Verified

On Docker 28 in an isolated dind, with a public repository as the source:

- **Successful job:** the source arrived at a pinned commit without `.git`, and the named secret arrived. The container had no Docker socket and no runner token, and it was removed afterwards.
- **Failing script:** it exited 3, failed the job and was not retried.
- **Cancel during a run:** the container was gone 13 s later.
- **Runner killed with SIGKILL:** its container kept running. 61 s later the lease lapsed and the job was requeued. The restarted runner removed the orphaned container and finished attempt 2. Attempt 1 stayed lost.
- **Panel down for 70 s, longer than a lease, during a job:** after the restart, attempt 1 finished with its whole log in order.

Job networks, on Docker 28 with a listener in a container on the default bridge:

- a container on the default bridge (where jobs ran before) reached it;
- a container on a job network could not, yet reached the internet;
- with `none`, a container could not even resolve a name.
