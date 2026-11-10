## Round89 — native macOS server evidence workflow
### Setup and authorization
Main6b9cfcfa clean round89_status_before.txt. Explicit userasked macOS developmentsetup/handoff andcommit/push; continuous audit authorization persists. This is an authorized validation/setup capability, not an invented F-ID/productdefect. Existingdev-macoshelper read; it checksnativeprereqs/buildsworkspace and runsdesktopchecks, not backendregressions. ExistingCI runsUbuntu; DesktopMac lane onlydesktop. Scope confirmed new .github/workflows/macos-server-audit.yml and docs/MACOS_DEVELOPMENT.md. Existinghelpers/production read-only.
### Invariants
Manualworkflow only, contentsread, SHA-pinnedexistingactions, exacteventSHAcheckout, frozenrootlockfile, no personalcredentials/logenvdump, noDockerdaemon/GUI/deployment/release. Preserve nativeMac/fullrelease distinction. Record actualOS/arch/node/CLI versions, exactSHA andlogs; hostedresult cannotbeclaimeduntiljobfinishes. Curatedunit and controlled-nativeCLI groups sequential; no fullrootcertification.
### Tools
GitHubconnector offers read/rerun but nodispatch; authenticatedgh2.103.3 read succeeded, so useCLI dispatch/read with sameauthorizedrepository. Node/pnpm/actions versions inheritedfromexistingrepo, not updated byguesswork. No newdependencyforproduction; hostedMacDockerCLI installation is ephemeral CLI only. No newskill/approvalneeded foralreadyrequestedsetup.
### Plan
Prepare manualworkflow, staticparse and actualcuratedWindowsrecipe checks, exactownedcommit/push, dispatchnativeMac, inspectjob/step/log/artifact identity, updatehandoffwithactualpass/failure. RootservernativefaultR73 remainsunresolved evenifMacfocusedlanepasses.
### Local preparation evidence
Manual-onlyworkflow parsedwithinstalledjs-yaml; allactionreferences40hex pins alreadyusedinrepo; contentsread, exacteventSHAcheckout/persistcredentialsfalse, no daemon/UI/release/publication commands. Allbashblocks syntaxchecked viaexistingGitBash -n, no provisioningcommandexecuted locally.
ActualWindowsrecipe: pnpm --filter @ninedeploy/server... build withGOMAXPROCS4 passed5workspaceprojects inclserver; focused24files307tests passed; controllednativeCLI4files20tests passed. DOCKER_HOST pointsunreachableloopback, nativefixtures useexplicitprivatehosts/config. Logsofexactgroupsretained. Diffcheckpassed. No productsource/schema/newdependencychanges. NativeMacrun notyetdispatched; notfullrelease certification.
### Workflow publication preflight:20ownedpaths expectedblobs/indexdiff/limitedscanpassed. Initialtreeclean, currentMacresult stillpending.
