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
| Password resets, recovery codes, invitations, the setup token | In the database or a file | Kept. |

## Replay protection

A webhook delivery, a SAML assertion and a GitHub App callback each carry an id the panel remembers for a while, so a captured request cannot be sent again. The panel remembers those ids in memory, and says so where it does: "a panel restart clears it", "one replay per panel restart, not one per attacker attempt" (`lib/webhooks.ts`, `lib/saml.ts`). After a restart, one captured request can be replayed inside its own validity window: a day for a webhook body, minutes for an assertion.

Signatures still hold. A replayed webhook needs a body the provider signed, a replayed assertion one the identity provider signed, and a push for a commit that is already running or queued is still refused. What is left is the residual the code names. Keeping the ids in the database would remove it; that needs a table or rows with an expiry, and is not done.

## Not in this panel's memory

The node agent and the wake catcher are processes of their own, on their hosts. What they hold in memory is lost when they restart, not when the panel does, and is not listed here.

## Tests

No test under `apps/server/test` restarts the panel during a canary, a forward-auth sign-in or an idle window: their reset functions are called between tests, and the only exercise of a hard restart during a canary is `scripts/smoke-node-canary.mjs`. The recovery rows above are each proven at boot by the test named in their row.
