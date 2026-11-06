# Real Swarm artifact and recovery acceptance

## Support matrix on real tasks — 2026-11-06

[Hosted run 42238384185](https://github.com/ninedeploy/ninedeploy/actions/runs/42238384185) (runtime-readiness, `swarm_support=true`) passed on `abd8eb45`. It builds the candidate image and runs `node scripts/smoke-multinode.mjs --swarm-only`, whose `swarmSupportChecks` exercise each row of the matrix in [DEPLOYMENTS.md §7](DEPLOYMENTS.md) against a two-task service on a real single-manager swarm in DinD:

- logs: 88 lines from both tasks, in time order;
- Stop → 0/0, Restart → 2/2, and the route serves again;
- `docker service scale <svc>=0` outside the panel: the runtime patrol scaled it back to 2/2, status still `running`;
- inspect and the File Browser on the service name reached a task on the panel host;
- `/v1/stats` reported the 128 MiB per-task limit, the two tasks averaged;
- a health path answering 404 through Traefik read healthy on the dashboard;
- `Container running` readiness deployed a service whose port answers nothing;
- `docker service rm` behind the panel's back: the patrol marked the service `error`;
- refused: volume attachment (422 `swarm_unsupported`, nothing created), TCP readiness (400), sleep (400 `cannot_sleep`); autoscaling offers no metric.

The same checks run in every release's `swarm-artifacts` cohort. Not covered: metrics of tasks on worker nodes (only the panel host's tasks are sampled), distributed workers, and Swarm autoscaling, which is not offered.

## Artifact and restart cohort — 2026-11-03

Status, 2026-11-03: the corrected hosted cohort passed, and its downloaded public receipts passed independent verification. This closes the single-manager artifact/restart cohort in R2, not the entire runtime or release program. Local Docker remains disabled.

Integration checkpoint: after PR #25 passed all required checks and merged as `977390d7279268b3ab8dffd0dde133fa40668c01`, [PR #26](https://github.com/ninedeploy/ninedeploy/pull/26) opened with frozen head `817af47a4bfa17b3cdae90f4d810a61e892df5f1`. It is the only open integration PR. Its prepared source tree was unchanged when accepted main history was merged. [Full CI 41650523274](https://github.com/ninedeploy/ninedeploy/actions/runs/41650523274) and serving checks are running; real Docker/PostgreSQL integration has passed. This PR contains the Swarm cohort and release gate, not the later R3 restore adapter. No new release was created.

Accepted evidence: [run 41644236264](https://github.com/ninedeploy/ninedeploy/actions/runs/41644236264), frozen source `1e2214e3ae765e1d414f89149649abb9c38bfee1`. All four cases completed: Docker-to-Swarm migration retired the previous Docker container; promotion retained the first image config ID and commit after repository HEAD advanced; a panel restart recovered the original pending deployment with its captured second image; recorded rollback returned to the first image and commit. Promotion and recovery made no additional Git fetch. The worker also asserted no fetch during recorded rollback.

Independent recount of the downloaded traces found **7,171 source and 6,003 target requests: 13,174 exact application HTTP 200 responses**, with no errors or 502. Source traffic contains both image bodies and ends with 40 first-image responses after rollback; every target response remains the promoted first image. Recovery and rollback preserve the source native service, manager and encrypted overlay identities. Four owned outer containers, both named volumes and the network were removed. Evidence is retained in `.temp_files/swarm-runtime-41644236264/swarm-runtime-41644236264/independent-verification.json`; verifier: `.temp_files/verify-swarm-runtime-41644236264.mjs`. This fixture is not yet integrated through its own full-source PR gate. Earlier preparation/failure checkpoints below are historical.

The release matrix now requires a separate `swarm-artifacts` cohort against the pushed candidate image, with no failure bypass and a 15-minute step bound. Promotion and npm publication depend on the entire matrix. Its evidence upload enumerates public JSON receipts on success or failure and excludes private Git repositories, raw logs and environment data. The existing matrix guard failed four checks before this addition; afterward all 82 covering checks in five files passed, including the eight-cohort schedule, existing release/security policies, real Git helper and sampler controls. Lint and diff checks passed. This wiring has not yet run against a numbered release image and does not constitute publication.

The cohort uses owned panel/node Docker daemons on a GitHub-hosted runner. A smart HTTP Git fixture serves two real commits. Normal authenticated API deployment builds the first repository-backed Docker image. The operator then initializes/enables an actual single-manager Swarm, selects Swarm placement and deploys through the normal worker.

Required cases:

1. Docker-to-Swarm migration: healthy task/image identities and encrypted overlay are confirmed; the captured previous Docker container is removed. The source release reports an available recorded Docker artifact. Public service and deployment commit identities must agree with the actual selected image in every case.
2. Pinned artifact promotion: advance repository HEAD to the second commit, then promote the first artifact to another Swarm service. Its native task must run the original config image ID and commit without another Git fetch. The source uses image-native health; the target uses an explicit command healthcheck.
3. Native restart recovery: deploy the second commit behind real native-image readiness, restart the panel after the pending journal and candidate exist, then release readiness. The original deployment and native service ID must settle with the captured candidate image ID, no new Git request, no unresolved journal and a persisted recovery outcome.
4. Recorded rollback: restore the first source artifact while repository HEAD remains at the second commit. Native task image ID and recorded commit must return to the first artifact without fetching/rebuilding from current source.

Independent HTTP observers run through the real Traefik proxy throughout source migration/update/restart/rollback and after target promotion. Only HTTP 200 with the exact baked first/second fixture bodies is accepted; status 502, unknown bodies, response errors and deadlines remain failures in the trace. Before readiness is released, only the original source body may serve. Final source samples must be the first body again. Cleanup must remove every owned outer container, both named volumes and the network. Uploaded evidence contains enumerated public JSON receipts, not Git data, raw logs, service environment or encrypted journal payloads.

Local preflight passed script/generated-CGI/sampler syntax, workflow parsing, JSON-only upload paths and all three pre-Docker hosted guards. Two files passed six helper checks: actual smart HTTP shallow clones of both commits and the original pinned commit, plus sampler controls for both application bodies, status 502, foreign bodies and oversized responses. These do not prove native Swarm behavior; the hosted result and its exact source will be recorded here.

The first hosted cohort is [run 41641877386](https://github.com/ninedeploy/ninedeploy/actions/runs/41641877386), frozen source `7e91d9f210c4f4aa801289cf4700f565d9165185`. Its tree matches the prepared local source before this documentation update. It is running independently of PR #25; no additional integration PR was opened. PR #25's initial full source job failed only the omitted runtime-reader inventory classification; that same check reproduced locally, and the correction passed 34 covering tests. Its old image/runtime job is still allowed to finish before the test-only PR update starts a fresh exact-head gate.

That first run completed with failure at the initial traffic-observer baseline, before Docker-to-Swarm migration. The ordinary repository deployment and operator Swarm initialization/enabling had completed. The observer incorrectly addressed the node's `ninedeploy-proxy`, while this cohort uses the panel's `ninedeploy-traefik`. The sampler regression now checks its transport target against the production panel container constant: all five cases failed on the wrong target, then all six sampler/Git helper checks passed after correction. Baseline collection is also inside the protected diagnostic block now, so a future early failure preserves its traffic and redacted recovery state. Four owned outer containers, both named volumes and the network were removed. No native Swarm scenario was accepted by this failed run.

The corrected cohort is [run 41644236264](https://github.com/ninedeploy/ninedeploy/actions/runs/41644236264), frozen source `1e2214e3ae765e1d414f89149649abb9c38bfee1`; its real Swarm step is in progress. Its tree matches the prepared candidate before this documentation update. The corrected public-node PR #25 now has fresh [CI 41643863613](https://github.com/ninedeploy/ninedeploy/actions/runs/41643863613) on `65d15f69f71eb0e63e59dd1600e7455089e331a8`; its early Swarm runtime guard has already passed, while its full source/image checks continue. This Swarm fixture is not part of that PR, and no additional integration PR or release was opened.

Distributed workers, public DNS/TLS, storage/data migration, every native failure timing and final source/release/upgrade/artifact certification remain separate acceptance. Never-bound node wake catcher collection and R3–R6 also remain open in [Competitive delivery](COMPETITIVE_DELIVERY.md).
