## Round75 — failed cross-process lock initialization
### Summary
Scope confirmed: apps/server/src/lib/crossProcessLock.ts and apps/server/test/lib/crossProcessLockInit.test.ts; existing write/ownership/native-child tests and database lifecycle callers read-only. Main14ebea9c/current tree clean, round75_status_before.txt. Same root/scoped instructions and installed toolchain as round74, reread patched initialization before forming candidate.
### Toolchain
Node26.13.0/TS7.0.2/Vitest5.0.5/Biome2.5.14, native node:fs disposable files. No dependencies. No global process/daemon/coverage-lock operations in this scope.
### Invariants
A rejected acquisition must not leave an owned fresh public lock that blocks an immediate corrected retry. Cleanup must never delete a later owner's lock. The complete token and heartbeat belong only to a successfully published holder. Existing stale recovery semantics and exclusive inter-process admission must remain intact.
### Findings
Pending beforeproof, source unchanged.
### Boundaries
Injected ENOSPC/zero-progress at native write seam, real created files/partial bytes; not an actual disk-full machine, live backup/restore or distributed-algorithm completeness claim.

#### F1093 — ownership / resource-leak — Medium — rejected initialization leaves a fresh public lock
Root cause recorded before patch: public O_EXCL pathname is created before identity write; ENOSPC/partial-write rejection closes FD but leaves that fresh path. Later healthy requests see EEXIST and are blocked until staleness. Before F1093_before.log:2failed/1normalcontrolpassed, PROBLEM CONFIRMED, exit1. Narrow root fix: prepare complete identity in an exclusively created unique same-directory private candidate, publish with existing native linkSync no-clobber primitive only after successful write, always clean owned candidate; public path untouched on preparation failure. Native hard links already used by stale-lock restoration; now publication also requires them, unsupported link errors must propagate rather than fall back to unsafe rename. Public token format, APIs and retry/stale budgets unchanged; transient .pending path is a filesystem-layout change directly caused by this finding. Existing stale takeover/release residual windows not redesigned.

Implementation correction: first text replacement was incomplete due CRLF anchors; original-after log failed3cases including a ReferenceError, retained as invalid application result. Compared exact partial bytes to baseline+ownedone-line change before reconstruction, normalized line endings, required every patch anchor, then reran unchanged proof. Not a product finding or accepted verification.

### Verification
Original corrected after3passed, both failure cases PROBLEM NOT REPRODUCED. Independent13cases3clean runs with FIX VERIFIED; actual native write/link/unlink/FD/mtime verified with one-shot publication/write barriers and controlled Date deadline (no sleep ordering). Permanent apps/server/test/lib/crossProcessLockInit.test.ts seen red against exact guarded oldsource:9failed/4controls, exit1; repairedsource restored after exact-byte no-drift check. Covers immediate retry after ENOSPC/partial/zero, hidden preparation/fulltokenpublication, EACCES/ENOTSUP failclosed, new publicowneratpublication and atfailedwrite, existing liveowner, stale takeover, privatecreatecollision preservation, transientunlinkrelease retry, heartbeatpublishedinode.
### Validation
Nearest native lock/r314/write/init/nodeLifecycle/database tests:133passed/6files (includes real second-process exclusion/crash-recovery control). GOMAXPROCS4 server typecheck/build passed. Initial scopedlint2template-styleinfos corrected in owned permanenttest, final lint/regression follow. git diff --check passed. Fullserver/rootrelease/coverage/live/nativeMac NOT RUN; R73 fullsuite nativeerror remains unresolved, invalidretry not reused.
### Boundaries
Publication now requires same-directory hard-link support and propagates unsupported errors, no unsafe rename fallback. Existing stale-takeover/release windows unchanged. Persistent inability to unlink or a crash before publication can leave a uniquely named private.pending artifact; this change does not reap abandoned private files or certify every filesystem. No real disk exhaustion or live backup/restore tested.
### Not reproduced (dropped)
None.
### Working tree
Setup clean, exact scoped source/new regression/docs/changelog/evidence only.

Final configured lint two TSfiles clean; final nearest scope133/6passed after style-only correction. Next scope: registryLock.ts serialization/failure release, concrete per-registry locking independent of filesystem locks.

Publication preflight:22exact owned staged paths; cached diff check and limited staged-content scan passed. No complete security scan. Guarded selected HEAD/remote verification follows receipt.
