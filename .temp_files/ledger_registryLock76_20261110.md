## Round76 — registry session admission
### Summary
Scope confirmed: apps/server/src/lib/registryLock.ts and apps/server/test/lib/registryLock.test.ts. Callers docker/remoteDocker/fanout/imageTransfer and registry auth parsing are read-only until a narrower proven caller defect needs its own scope. Mainb0cd6d59, round76_status_before.txt clean. Same CONTRIBUTING/scoped instructions/toolchain; no installs.
### Toolchain
Node26.13.0/TS7.0.2/Vitest5.0.5/Biome2.5.14. Existing registry test conventions and callers read before candidates. Promise/future barriers, no sleep-based ordering. Native Docker credential-store behavior requires its actual isolated CLI boundary; helper-only alias differences are insufficient for a credential/security claim.
### Invariants
One holder at a time per same credential store/registry; independent keys progress; release idempotent, only latest tail removed; callers release across errors; key representation must match real credential-store identity if aliases are accepted. No patch without runnable current-source proof.
### Findings
Pending controls/caller inspection.
### Boundaries
No live tenant credentials or remote registry mutations; source-only alias hunch is not a finding.

### Alias candidate dropped / native boundary
Docker29.9.3 --config disposable isolated configs with fakecredentials, loopback controlled /v1.52/auth, no realdaemon/registry: default+docker.io share canonical Hub configkey and already share ourhelperkey; index/registry-1/case spellings store distinct literalkeys. Native alias controls did not justify a lock alias patch. Native inspection separately exposed login docker.io / logout docker.io cleanup mismatch; defer to next concrete scope, no cleanup patch here. Official matching-version login/logout Go sources read from docker/cli tagv29.9.3; no source copied.
#### F1094 — race / ownership — Medium — registry-scoped admission loses another live session in the shared config
Scope expanded before edit to registryLock.ts, existingregistryLock.test.ts, newlib/registryLockStore.test.ts and integration/registryCredentialStore.test.ts; callerfiles stay read-only. Root cause: DockerCLI loads a complete config before auth; different-registry locks admit simultaneous read/auth/write sessions on one host. A held login saves registryA, later B saves its earlier snapshot, droppingA while A session still owns its lock. Native unchanged-source prove_F1094_registryStore.mjs twice: same-registry control correct/overlapfalse; different registry EXPECTEDfirstauthtrue ACTUALfalse/overlaptrue, PROBLEM CONFIRMED; round76_F1094_before_exit.txt=1. ActualCLI/configwrites; no realtenantsecuritybypass/privatepull claim. Narrow patch internal key percredentialstore only, retain signature/host isolation, update old incorrect independence test. No public API/schema/config change; same-host differentregistry session parallelism intentionally removed because it caused lostwrites.

### Verification
Original native DockerCLI proof after:two cases correct, bothPROBLEM NOT REPRODUCED; actualsharedJSON retainsone+two entries. Independent8cases/3runs FIX VERIFIED using native JSON files at verified CLI read/auth/write seam and explicit futures/setImmediate microtaskdrain, no elapsed-time race ordering. Permanent unitregistryLockStore.test.ts seenred6failed/2controls on guarded exactoldsource. Permanent integrationregistryCredentialStore.test.ts seenred1failed/1control with actualDocker29.9.3 binary/loopback controlled API/disposable configs; afterfinalharnesschanges2/2passed3times. No actualdaemon, publicregistry, realcredentials or userDockerconfig touched.
### Validation
Nearest final command includes registryLockStore,registryLock,engine/remoteDocker,fanout,lib/imageTransfer.coverage,imageTransferIntegrity,builders/docker,buildPlacement:313tests/8files passed. Earlier163/6scope passed. GOMAXPROCS4 server typecheck/build passed. Final configured Biomecheck4TSfiles clean; initialintegrationfixture finallyguard/style lint failure corrected, retainedoldlog. git diff --check passed. No newdependency/racedetector. Fullserver/rootrelease/coverage/live/nativeMac NOT RUN; R73 nativecrash stillunresolved.
### Boundaries
Internalkeygranularitychanged: allregistry sessions ononeknownhostserialize; distinctnodesstillindependent. Potentialwait/throughput tradeoff intentional; no performance claim. Checked builder/fanout/imageTransfer callsites for recursive samestore acquisition; push/pull sessions release separately, prebuiltship precedes targetregistrylock. This is in-process admission only; externalDockerCLI/otherpanelprocesses/duplicatephysicalhosts are not coordinated. A fake auth API validated actualCLI/config persistence, not liveprivatepull or tenantcredentialexfiltration.
### Working tree
Setup clean; only scoped helper/nearesttest/newunit+integration/docs/changelog/evidence selected.
### Next scope
registryCredentialFor literaldocker.io login/logout normalization, with nativeCLI controlled-daemon proof for lingering privateconfigauth. Aliascandidate for lock dropped; cleanup issue needs its own scoped beforeproof before patch.

Publication preflight:33exact owned staged paths; cached diff and limited staged-pattern scan passed. No full security audit. Guarded selected HEAD/remote receipt follows.
