## Round 17 — bounded workload probe
### Setup
- Scope confirmed: apps/server/src/lib/containerProbe.ts and apps/server/test/lib/containerProbeAddress.test.ts. HEAD7e3a9572; source/test clean, full status in round17_status_before.txt; concurrent capability work preserved.
- CONTRIBUTING applies; current checked root/server manifests/config: Node26.13.0/pnpm11.23.0/TypeScript7/Vitest5.0.5/V8/tsc/Biome2.5.14; serial server files, formatter disabled, no race/sanitizer. No dependency/config changes.
- Entire source and nearest address tests read; readiness agent and local builder caller references inspected read-only.
- Invariants: reject invalid names/ports/protocols/paths/address before spawn; user operands stay separate from fixed shell code; unique helper name; run bounded at 10s; cleanup attempted even if run fails; explicit primary address stays selected; HTTP readiness needs successful command and acceptable parsed status; TCP readiness needs successful command.
- Candidate review: UUID names and finally cleanup cover resource ownership paths; explicit address/path validation precedes spawn. No new executable failing candidate yet. Native BusyBox HTTP script behavior and every informational-response case are not verified by mocked spawn tests.

### F1044 root cause recorded before patch
- bug, Medium: HTTP_PROBE reads one status line then exits, treating informational 103 as the final result. Healthy workloads returning Early Hints are reported unready, preventing deployment promotion; no outage claimed.
- Primary contract: https://www.rfc-editor.org/rfc/rfc9110.html#section-15.2 — informational responses can precede the final response. 101 protocol switching must not count as ordinary healthy HTTP completion.
- Local boundary verified: Docker desktop-linux, Linux server, pre-existing busybox:1.36 image sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662. No image pulled. Proof creates only UUID-named internal network/fixture, no published ports, and removes its owned resources in finally.
- First proof attempt failed its fixture readiness gate because nc listened on IPv6, not the inspected IPv4 table. F1044_setup_failed.log retained; this is not a product reproduction. Gate corrected to inspect both proc socket tables; no sleep.
- F1044_before.log: actual product helper against actual BusyBox server; plain200 control ready=true/status200; 103+200 actual ready=false/status103; PROBLEM CONFIRMED, exit1.
- Narrow patch: fixed helper shell drains informational headers and reads subsequent status, stops on final response or unsupported101, retains read/global timeouts and existing status parser/readiness policy. No operands/API/schema/dependency change.
- Expanded permanent scope: apps/server/test/integration/containerProbeHttp.test.ts, using existing Vitest and local pre-existing image. Integration tests are intentionally excluded by the default server config; explicit native run will be recorded.

### Protocol boundary correction before final validation
The probe sends HTTP/1.0. RFC9110 section15.2 forbids servers from sending 1xx to an HTTP/1.0 client, while also requiring clients to parse unexpected informational responses. The fixture deliberately exercises this robustness edge, not a claim that compliant HTTP/1.0 servers normally emit Early Hints. F1044 is therefore **Low**, not the initially proposed Medium: compatibility with a server that emits informational responses despite the request version. Native proof remains valid for actual helper behavior; no broad prevalence claim. The patch keeps HTTP/1.0 and its existing wire request unchanged.

### Summary
One Low compatibility bug confirmed with native Linux-container execution, fixed and promoted to explicit integration coverage. Normal unit scope has 26 passing tests; full release/macOS certification remains outside scope.
### Toolchain
Current manifests/config as recorded in Setup; Docker desktop-linux/Linux server and existing BusyBox1.36.1 image used without pulling. No dependency or runner installed.
### Findings
#### F1044 — bug — Low — HTTP readiness stops at an informational response
- Location: apps/server/src/lib/containerProbe.ts:18, HTTP_PROBE fixed shell command.
- Root cause: helper read exactly one status line; an unexpected103 hid the subsequent final200. Severity/protocol qualification recorded above.
- Proof (before): audit_continuous_20261109/prove_F1044_probe_early_hints.test.ts, F1044_before.log exit1/PROBLEM CONFIRMED; native plain200 control passed, 103+200 reported ready=false/status103. Setup-only failed attempt separately retained.
- Patch: consume informational headers then read next status; 101 stays unready, final status keeps existing acceptance rules; original request version, fixed operands and timeouts preserved. No API/schema/config/dependency changes.
- Proof (after): unchanged original exit0/PROBLEM NOT REPRODUCED. Independent verify_F1044_probe_early_hints.test.ts three consecutive passes/FIX VERIFIED, seven native response cases: plain200, 103+200, 100+103+302, 103+503, no final response, unsupported101, malformed status. Socket LISTEN state is the explicit startup gate; no sleeps.
- Regression test: apps/server/test/integration/containerProbeHttp.test.ts; seen fail before on status/ready assertions and pass after. Requires local Linux Docker and existing busybox:1.36; excluded by normal server integration exclusion, explicitly executed with F1044.integration.config.ts.
### Not reproduced (dropped)
Initial fixture gate timeout was a fixture bug (IPv6 listener omitted from gate), not a product finding. No command-injection or container-isolation claim inferred.
### Validation
- Focused: root pnpm exec vitest run --config .temp_files/audit_continuous_20261109/vitest.config.ts with each named proof/verifier --reporter=verbose: after proof passed, verifier three passes.
- Native regression: pnpm exec vitest run --config .temp_files/audit_continuous_20261109/F1044.integration.config.ts --reporter=verbose: 1 passed/1 file; before 1 failed on expected ready/status.
- Scope: pnpm --dir apps/server exec vitest run test/lib/containerProbeAddress.test.ts test/agentReadiness.test.ts test/lib/nodeProbeReceipt.test.ts --coverage=false: 26 passed/3 files, before and after.
- Build/typecheck: pnpm --dir apps/server typecheck and build each exit0; retained F1044 logs.
- Format/lint: pnpm exec biome lint apps/server/src/lib/containerProbe.ts apps/server/test/integration/containerProbeHttp.test.ts: 2 checked/no fixes; formatter disabled.
- git diff --check on source/test/changelog: exit0.
- NOT RUN: full release/coverage, production deployment, actual macOS host or native Linux installer acceptance. Integration only tests local Linux containers on Windows Docker Desktop.
### Boundaries
Fixture deliberately emits1xx despite HTTP/1.0 (server nonconformance); client robustness is the proven edge, not normal-server prevalence. UUID-owned internal networks/containers, no published ports/credentials/mounts/image pulls. Cleanup runs only for successfully created owned resources; final labeled-resource listing recorded separately.
### Working tree
Other capability/localization/docs work retained. Only own source, integration test, changelog hunk, Mac handoff addition and selected audit evidence staged; no reset/stash/cleanup of historical evidence.
### Next scope (if rounds continue)
apps/server/src/lib/nodeProbeReceipt.ts and its nearest tests — strict interpretation of bounded readiness receipts.
