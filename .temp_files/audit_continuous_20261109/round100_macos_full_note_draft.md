## Full backend unit verification on native macOS

Run **macOS server full unit audit** manually from GitHub Actions, or use:

```bash
gh workflow run macos-server-full-unit-audit.yml --ref main
```

This separate workflow uses the selected commit, the repository's Node/pnpm
versions, a frozen install, workspace dependency builds and server typecheck.
It runs the configured server unit suite with one worker and coverage disabled:

```bash
pnpm --dir apps/server exec vitest run --coverage=false --maxWorkers=1 --reporter=verbose
```

The job has a 90-minute budget; individual test/hook timeouts remain those in
`apps/server/vitest.config.ts`. Its artifact records the expected test files,
config hash, source/event SHA, environment, complete logs and workspace MCP
checks. The four controlled Docker CLI test files run separately. Docker CLI is
installed before the unit suite; no Docker daemon, GUI or deployment is started.

Use the existing **macOS server audit** for the shorter focused regression lane.
Neither workflow substitutes for coverage, the full root release gate, normal
Keychain behavior, signing/notarization or acceptance on a physical Mac.
