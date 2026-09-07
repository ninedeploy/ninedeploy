/**
 * r059: formatManifestYaml emits raw (unquoted) YAML scalars for
 * routes[].host, database.ref, and database.env.
 *
 * Root cause: quote() is applied to build/install/start/..., env keys,
 * route paths, and headers — but NOT to routes[].host, database.ref,
 * or database.env. Those fields use bare `${value}` interpolation.
 *
 * Proof strategy: use "true" as routes[].host — a string value that
 * YAML resolves to boolean `true`.  parseManifestYaml throws
 * ManifestValidationError on the unquoted output (expected string,
 * received boolean), which is the observable symptom of the bug.
 *
 * Before fix: formatManifestYaml emits `host: true` → round-trip fails.
 * After fix:  formatManifestYaml emits `host: "true"` → round-trip passes.
 */
import { describe, expect, it } from 'vitest';
import { parseManifestYaml, formatManifestYaml } from '../src/manifest.js';

describe('r059 — formatManifestYaml raw scalar round-trip', () => {
  it('routes[].host must round-trip as a string when the value is YAML-ambiguous', () => {
    // "true" is a valid domain name that YAML resolves to boolean.
    // The formatted YAML must quote it so the round-trip preserves the string.
    const original = parseManifestYaml(`
version: "1"
routes:
  - host: "true"
    path: /
    ssl: true
`);
    expect(typeof original.routes?.[0]?.host).toBe('string');
    expect(original.routes?.[0]?.host).toBe('true');

    const formatted = formatManifestYaml(original);
    // The formatted output must contain the quoted host so YAML parses it as string.
    // Before fix: "host: true" (bare) → parseManifestYaml throws.
    // After fix:  "host: \\"true\\"" (quoted) → round-trip succeeds.
    expect(() => parseManifestYaml(formatted)).not.toThrow();

    const reparsed = parseManifestYaml(formatted);
    expect(reparsed.routes?.[0]?.host).toBe('true');
  });

  // NOTE: database.ref and database.env are marked "latent, no realistic trigger" in
  // the r023 memory because their schema constraints (lowercase-only ref, env-var name
  // for env) naturally exclude the YAML-ambiguous values (null, true, ~, etc.) that
  // trigger the bug. The routes[].host test above is the concrete proof of the defect.
});
