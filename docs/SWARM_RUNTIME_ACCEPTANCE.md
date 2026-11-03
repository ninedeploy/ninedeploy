# Real Swarm artifact and recovery acceptance

Status, 2026-11-03: hosted cohort prepared; no native result yet. This closes a missing real-system gate in R2, not the entire runtime or release program. Local Docker remains disabled.

The cohort uses owned panel/node Docker daemons on a GitHub-hosted runner. A smart HTTP Git fixture serves two real commits. Normal authenticated API deployment builds the first repository-backed Docker image. The operator then initializes/enables an actual single-manager Swarm, selects Swarm placement and deploys through the normal worker.

Required cases:

1. Docker-to-Swarm migration: healthy task/image identities and encrypted overlay are confirmed; the captured previous Docker container is no longer serving. The source release reports an available recorded Docker artifact.
2. Pinned artifact promotion: advance repository HEAD to the second commit, then promote the first artifact to another Swarm service. Its native task must run the original config image ID and commit without another Git fetch. The source uses image-native health; the target uses an explicit command healthcheck.
3. Native restart recovery: deploy the second commit behind real native-image readiness, restart the panel after the pending journal and candidate exist, then release readiness. The original deployment and native service ID must settle with the captured candidate image ID, no new Git request, no unresolved journal and a persisted recovery outcome.
4. Recorded rollback: restore the first source artifact while repository HEAD remains at the second commit. Native task image ID and recorded commit must return to the first artifact without fetching/rebuilding from current source.

Independent HTTP observers run through the real Traefik proxy throughout source migration/update/restart/rollback and after target promotion. Only HTTP 200 with the exact baked first/second fixture bodies is accepted; status 502, unknown bodies, response errors and deadlines remain failures in the trace. Before readiness is released, only the original source body may serve. Final source samples must be the first body again. Cleanup must remove every owned outer container, both named volumes and the network. Uploaded evidence contains enumerated public JSON receipts, not Git data, raw logs, service environment or encrypted journal payloads.

Local preflight passed script/generated-CGI/sampler syntax, workflow parsing, JSON-only upload paths and all three pre-Docker hosted guards. Two files passed six helper checks: actual smart HTTP shallow clones of both commits and the original pinned commit, plus sampler controls for both application bodies, status 502, foreign bodies and oversized responses. These do not prove native Swarm behavior; the hosted result and its exact source will be recorded here.

Distributed workers, public DNS/TLS, storage/data migration, every native failure timing and final source/release/upgrade/artifact certification remain separate acceptance. Never-bound node wake catcher collection and R3–R6 also remain open in [Competitive delivery](COMPETITIVE_DELIVERY.md).
