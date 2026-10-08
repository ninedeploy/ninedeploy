// r477: the single source of truth for the workspace's publishable/releasable
// package list. bump-version.js (what it rewrites) and tag-release.js (what
// provenance verifies) hardcoded identical 10-entry copies — an 11th package
// would ship at a stale version with every gate green. Both import this now,
// and release-workflows.test.ts pins coverage against the real workspace
// globs so the list cannot silently rot.
export const PACKAGE_JSONS = [
  'package.json',
  'apps/cli/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/db/package.json',
  'packages/mcp/package.json',
  'packages/plugin-sdk/package.json',
  'packages/schemas/package.json',
  'packages/sdk/package.json',
];
