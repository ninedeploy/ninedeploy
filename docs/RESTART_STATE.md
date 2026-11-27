# What a panel restart keeps and loses

The panel is one process. What it keeps in its database and in files is there after a restart; some of what it holds in memory is not. This page lists what a person can notice after a restart, what the panel does about each at boot, and where each decision is written in the code. It is the inventory of work item N07 (November 2026): for each kind of state, the panel resumes it, ends it safely, or lets it start again.

A restart means any end of the process: a crash, a service restart, a self-update, or a host reboot.

## Recovered at boot

Each of these was running in the process that stopped. Nothing in the new process can finish it the way it was going, so at boot the panel either resumes it from what it wrote down, or marks it ended with a reason.

| What was in progress | What the panel does at boot | Where |
| --- | --- | --- |
| A deployment | A local deployment is marked failed at once, with the reason in its log and a notification. One on a node is held for a grace period first, because the node may still be running the last operation of the dead pipeline. | `plugins/worker.ts`, `test/plugins/worker.test.ts` |
| A zero-downtime release, a fan-out, a Swarm update or a canary | The transition was written to a journal before it started. Recovery resumes it from the journal: routing and the runtime are confirmed before the old release is retired. A canary's measurements are not replayed; the release finishes on the stable intent. | `plugins/primaryRecovery.ts`, `fanoutRecovery.ts`, `swarmRecovery.ts`, `test/primary-recovery.test.ts`, `test/plugins/worker-primary-recovery.test.ts` |
| A service's state against its container | The first reconcile pass runs at startup: a row that says `running` while its runtime is down is repaired. | `plugins/runtimeState.ts` |
| A node's sleep, wake, scale or preparation step | Each was journalled before it started and is recovered from the journal, once. | `test/lib/nodeSleepRecovery.test.ts`, `test/lib/nodeAutoscaleRecovery.test.ts` |
| A database dump or volume import | Marked failed: "interrupted by panel restart". Its staging file is removed. | `plugins/databaseImports.ts`, `test/lib/databaseImport.test.ts` |
| A database backup or a restore drill | Marked failed. | `plugins/housekeeping.ts`, `test/plugins/interruptedBackups.test.ts` |
| A major version upgrade of a database | Finished on the host the database lives on: its helper containers are removed and it starts on the volume its row names (the old one before the switch, the verified copy after it); the record says it was interrupted. A host that does not answer leaves the upgrade open with a note (nothing may start beside a helper the panel could not remove), and a sweep finishes it when the host answers. | `plugins/databaseImports.ts`, `lib/databaseUpgrade.ts`, `test/lib/databaseUpgrade.test.ts`, `test/lib/databaseUpgradeNode.test.ts` |
| The panel's own backup | Reported failed when the Backup page is read: it did not finish on this panel. | `lib/panelBackup.ts`, [Panel self-backup](PANEL_BACKUP.md) |
| A PITR restore | Marked failed. | `test/lib/pitrRemote.test.ts` |
| A CI job's lease | A live lease gets a fresh period, so a runner that could not report while the panel was down does not lose its job. | `lib/ci.ts`, `test/lib/ciLeaseSweep.test.ts` |
| An open terminal | Its session is ended as `panel_restart`, and the helper container is removed. A shell that was open never receives the hang-up. | `plugins/terminals.ts`, `test/plugins/terminals.test.ts`, [Terminals](TERMINALS.md) |
| A move of a service with its data | Marked failed with what happened and what to do. The service row is left as it is. | `plugins/serviceMoveRecovery.ts`, `test/plugins/serviceMoveRecovery.test.ts`, [Move a service with its data](NODE_OPERATIONS.md) |

## Starts again, by design

These are observations or counters. Losing them delays a decision or repeats a message; it loses no data. Each is kept in memory on purpose, and the reason is written where it lives.

| What | After a restart | Effect |
| --- | --- | --- |
| Canary measurements | The canary ends. Traffic goes to one release: the one the stable intent names. | The release finishes without the canary's observation. [Deployments](DEPLOYMENTS.md) |
| Requests per service | The count starts from zero. | A scale-down by request rate waits a full window. `lib/requestRate.ts` |
| The idle window for sleep | It starts again: "just started; the idle window begins now". On a node, idle coverage starts from zero too. | A service sleeps later than it would have. `lib/sleep.ts`, [Node sleep and wake](NODE_SLEEP_WAKE.md) |
| Autoscale windows | They start again. | Scaling waits for its window again. `lib/autoscaler.ts` |
| Restart-loop windows | Each window starts again. | A crash-looping service gets its full count again. [Deployments](DEPLOYMENTS.md) |
| Sign-in lockouts | Counters are cleared. | A locked account can try again sooner. `lib/loginLockout.ts`, [Workspaces and access](WORKSPACES_RBAC.md) |
| Request rate limits | Buckets are cleared. | `plugins/rateLimit.ts` |
| Alert throttles | They are cleared. | An alert that repeats itself may be sent once more after a restart. `plugins/runtimeState.ts` |
| GitHub runner queue | Jobs waiting in the panel for a slot are no longer queued by it. | GitHub keeps the job queued until a runner takes it or it times out. [GitHub App](GITHUB_APP.md) |
| A host's provisioning log | The last 25 bootstrap logs are gone. | The bootstrap-log endpoint answers an empty list. `engine/serverProvisioner.ts` |

## One-time codes and in-flight requests

| What | Lifetime | After a restart |
| --- | --- | --- |
| A forward-auth sign-in code | One minute, in memory | The visitor sees "This sign-in link is invalid or expired. Open the page again." A session that was already signed in keeps working: its cookie is signed and lives 12 hours. `lib/forwardAuth.ts` |
| An MCP authorization code | One minute, in memory | The client signs in again. [AI, MCP and CLI](AI_MCP_CLI.md) |
| A passkey challenge | Five minutes, in memory | The visitor tries again. `lib/webauthn.ts` |
| A terminal that was opening | Its ticket lasts 30 seconds | The connection ended with the process; the terminal page starts a new session. `lib/terminalSessions.ts` |
| A wake-up of a sleeping service | In flight | The request that woke it ended with the process. The next request wakes the service again. `lib/sleep.ts` |
| A GitHub App setup in progress | Minutes, in memory | The callback says the setup state was used or expired; the setup starts again from Sources. [GitHub App](GITHUB_APP.md) |
| Password resets, recovery codes, invitations, the setup token | In the database or a file | Kept. |

## Replay protection

A webhook delivery and a SAML assertion each carry something that makes a captured, correctly signed request recognisable when it is sent again. The panel remembers it for a while and refuses the second time: for a day for a webhook body, and for a SAML assertion at least six hours or until the assertion's own expiry, whichever is later.

It is remembered in the `replay_window` table (`lib/replayWindow.ts`), since November 27, 2026. Before, the panel kept it in memory and said so, and a restart let each captured request through once more. A row is the kind and a digest of what identifies the request, never the request itself. The check and the remembering are one statement, so two identical requests that arrive together are accepted once, and the row is written before the panel acts on the request. The hourly sweep removes rows whose time has passed (`plugins/housekeeping.ts`); a request that arrives after that time is accepted again.

Signatures still hold. A replayed webhook needs a body the provider signed and a replayed assertion one the identity provider signed; only a request whose signature was verified reaches the table.

## Not in this panel's memory

The node agent and the wake catcher are processes of their own, on their hosts. What they hold in memory is lost when they restart, not when the panel does, and is not listed here.

## Tests

Each recovery row above is proven at boot by the test named in its row.

What follows a restart in the middle of a canary or of an idle window is held by `test/lib/restartBehaviour.test.ts`, which empties the registries a new process starts with:

- A canary is over. The next routing sends nothing to the candidate, the status says there is no canary, and the promote control answers that there is none. The work of the stopped process (its observations, its promote request, its ending by deployment id or owner) cannot reach a canary the new process starts, and an access-log line from before the new step began is not counted in it.
- An idle window starts again. A service idle for hours before the restart is not put to sleep right after it, a request keeps it awake, and a new wake is not held to the one the stopped process had begun.
- The operator's message for an interrupted canary is in the deployment's log: `test/primary-recovery.test.ts` holds its two lines ("Primary recovery confirmed …", "Recovery does not re-run lifecycle hooks, canary observation …").

The replay window is opened a second time, as a restarted panel opens it, in `test/lib/replayWindow.test.ts`.

Not under test: a forward-auth sign-in across a restart. Its code is one lookup in a one-minute list, and the refusal is the message named above.
