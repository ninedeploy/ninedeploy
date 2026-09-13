/**
 * Scan a build log for known error patterns and produce actionable hints.
 * Pure and exported for testing — the pipeline calls this after a failed
 * build to help the operator debug faster. Hints are advisory: the original
 * error is always shown alongside them.
 */

export interface DeployHint {
  /** Short label identifying the pattern that matched. */
  label: string;
  /** Actionable fix the operator can apply. */
  hint: string;
}

interface Pattern {
  label: string;
  test: RegExp;
  hint: string;
}

const PATTERNS: Pattern[] = [
  {
    label: 'lockfile-mismatch',
    test: /EUSAGE|npm ERR.*lockfile|frozen-lockfile|--frozen-lockfile|pnpm.*ERR.*lockfile/i,
    hint: 'Lockfile mismatch — run the install command locally to update the lockfile, commit it, and push again.',
  },
  {
    label: 'typescript-error',
    test: /error TS\d+/,
    hint: 'TypeScript compilation failed — fix the type errors shown above, then push again.',
  },
  {
    label: 'missing-module',
    test: /Cannot find module ['"]([^'"]+)['"]|Module not found:/,
    hint: 'A module is missing — check that the import path is correct and the package is in package.json dependencies (not devDependencies if the build needs it).',
  },
  {
    label: 'port-conflict',
    test: /EADDRINUSE|address already in use/i,
    hint: 'Port conflict — another process is using the same port. Check the service port in Settings and make sure the app listens on the correct port.',
  },
  {
    label: 'permission-denied',
    test: /EACCES|permission denied/i,
    hint: 'Permission denied — check file permissions in the build context and make sure the build commands run as the correct user.',
  },
  {
    label: 'out-of-memory',
    test: /JavaScript heap out of memory|KILLED.*signal|OOMKilled/i,
    hint: 'Out of memory — increase the memory limit in Settings → Limits, or optimize the build (e.g. reduce TypeScript memory with --max-old-space-size).',
  },
  {
    label: 'dockerfile-not-found',
    test: /Dockerfile.*not found|failed to read dockerfile/i,
    hint: 'Dockerfile not found — check the Dockerfile path in Service → Settings → Build.',
  },
  {
    label: 'npm-404',
    test: /404 Not Found.*registry\.npmjs|npm ERR.*404/i,
    hint: 'Package not found in the npm registry — check the package name and version in package.json.',
  },
  {
    label: 'env-var-missing',
    test: /Missing environment variable|required env var/i,
    hint: 'A required environment variable is not set — add it under Service → Environment.',
  },
];

/** Scan a build log for known error patterns. Returns hints in match order. */
export function detectDeployHints(log: string): DeployHint[] {
  if (!log || log.length === 0) return [];
  return PATTERNS.filter((p) => p.test.test(log)).map((p) => ({
    label: p.label,
    hint: p.hint,
  }));
}
