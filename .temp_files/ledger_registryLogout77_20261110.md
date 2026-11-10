## Round77 — explicit Docker Hub credential cleanup
### Summary
Scope confirmed: apps/server/src/lib/registryBinding.ts, apps/server/test/lib/registryCredentialLogout.test.ts, apps/server/test/integration/registryCredentialLogout.test.ts. Existing tenancyIsolation/artifactRegistry and nativeCLI fixture conventions read-only. Main4af7d6b4, round77_status_before.txt clean; same package instructions/toolchain, no installs.
### Toolchain
Existing TS/Vitest5.0.5/native libsql; actualDockerCLI29.9.3 with loopback controlled auth API, isolated DOCKER_CONFIG/--config, fakecredentials and explicit APIversion. Native CLI tests use existing integrationconfig, unit controls configured normalrunner. Encryption/binding resolution and SQLite actual.
### Invariants
The resolved login server must pair with the logout that removes its exact stored auth entry. Explicit docker.io image pulls and implicit Hub image pulls must both clear their own fake auth after successful logout. Preserve binding allowlist and non-Hub target spelling; do not broaden aliases without proof.
### Findings
Native inspection from76 suggests explicitdocker.io mismatch, but no current-helper beforeproof yet. Source unchanged.
### Boundaries
No realdaemon/registry/tenantcredential/globalDockerconfig, no livecredential exfiltration claim. Fake daemon validates client-side target/config persistence only.

#### F1095 — bug / ownership — Medium — explicit Docker Hub logout leaves the saved auth
Root cause recorded before edit: registryCredentialFor returns literaldocker.io for explicitimage. NativeDockerCLI29.9.3 login folds exactdocker.io tohttps://index.docker.io/v1/ but logout with literaldocker.io erasesdifferentkeys and reports success. Beforeprove_F1095_registryLogout.test.ts uses actualencryptedsource/nativeSQLite/bindingresolution, actualCLI and loopbackfakeauthAPI/disposableconfig:1failed/1implicitHubcontrolpassed, PROBLEM CONFIRMED, exit1 inround77_F1095_before_exit.txt. Matching officialCLI sources: https://github.com/docker/cli/blob/v29.9.3/cli/command/registry/login.go and logout.go. Medium: credentialcleanup contract fails, no livecompromise/accessbypass claim. Narrowpatch onlyexactdocker.io output server becomesundefined (existingHubdefault) for correctly pairedlogin/logout. Preserve allbindingdecisions and otherhostspellings/aliases. Internaloptional server normalization, no API/schema version change/dependency.

### Verification
Original after2passed, both PROBLEM NOT REPRODUCED. Independent nativeCLI verifier7cases/3runs FIX VERIFIED; implicit/explicit Hub,digest,nonHub,legacyalias,case and repeatedsession cleanup all preserveunrelatedconfigentry. ActualnativeCLI29.9.3 +loopbackauthAPI; helper uses real encryptedsource, nativeSQLite and bindings. Permanentunit7cases cross-check image/source-build/push resolver identities and unchanged revocation/multiplebinding/incompletecredential behavior; oldsource3failed/4controls. Permanentnativeintegration7cases also seenred3failed/4controls on guardedexactoldsource; repairedsource restoredafter no-drift check. Finalnativeintegration7/7passed.
### Validation
Scope registryCredentialLogout,tenancyIsolation,artifactRegistry,lib/imageTransfer.coverage,registryLock,registryLockStore:74tests/6files passed. GOMAXPROCS4 server typecheck/build passed. Configured Biomecheck3changedTSfiles clean; git diff --check passed. Nativefixture uses only private configs andfakepasswordstdin; unitfixture mocks audit sink while actualbinding/crypto/SQLite remainreal, nearesttenancytests verifypersistedaudits. Fullserver/rootrelease/coverage/live/nativeMac NOT RUN; R73 nativeworkerfault unresolved.
### Boundaries
Only exactlowercase docker.io server normalization changed. Case/legacyaliases/nonHub spellings retained andactuallytested. No actualtenantcredential compromise/privatepull/networkattack or wholeDockerCLIbugfix claim. Productionbuilder/agent primitive/manualcachedrawserver operands outside current helper are not rewritten.
### Not reproduced (dropped)
None in this scoped helperfinding; registryLockaliascandidate was dropped in76.
### Working tree
Setupclean, scoped source/newunit+integration/docs/changelog/evidence only.
### Next scope
Image registry-host classification versus actual DockerCLI accepted references, especially host-like first components without a dot; validate app input reachability before any patch.

Publication preflight:22exact owned staged paths; cached diff and limited staged-pattern scan passed. No complete security audit. Guarded selected HEAD/remote verification follows receipt.
