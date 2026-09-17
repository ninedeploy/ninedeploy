import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

/**
 * Registry drift guard — the activepieces incident: a registry rewrite
 * silently stripped the template's env array and volume mount, and nothing
 * failed because the result was still schema-VALID (absent fields are
 * optional). Schema checks cannot catch LOSS; only a diff against the last
 * released definitions can.
 *
 * The baseline is the previous semver tag. A field may disappear only when
 * the removal is listed in the allowlists below — each entry needs a
 * comment naming the deliberate change, so silent drift stays impossible.
 */

interface TemplateDef {
  id: string;
  env?: Array<{ key: string }> | null;
  dbEngine?: string | null;
  databaseEnv?: Record<string, string> | null;
  volumeMount?: string | null;
}

/** Deliberate env-key removals: (templateId, oldEnvKey) → why. */
const ALLOWED_ENV_REMOVALS = new Set<string>([
  // r136: renamed to the real key VIKUNJA_SERVICE_JWTSECRET — the app
  // refuses to boot without it, so the old key was dead weight.
  'vikunja:VIKUNJA_SERVICE_SECRET',
]);

/** Deliberate engine removals: templateId → why. */
const ALLOWED_ENGINE_REMOVALS = new Set<string>([]);

/** Deliberate volume-mount removals: templateId → why. */
const ALLOWED_VOLUME_REMOVALS = new Set<string>([]);

function previousTag(): string | null {
  // No quotes around v*: execSync on Windows routes through cmd.exe, which
  // passes single quotes literally and matches nothing. Unquoted is safe —
  // git globs the pattern itself and no repo files start with "v".
  const tags = execSync('git tag --list v* --sort=-v:refname', { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  const current = VERSION.split('.').map(Number);
  const isOlder = (tag: string): boolean => {
    const parts = tag.slice(1).split('.').map(Number);
    return (
      parts[0] < current[0] ||
      (parts[0] === current[0] && parts[1] < current[1]) ||
      (parts[0] === current[0] && parts[1] === current[1] && (parts[2] ?? 0) < (current[2] ?? 0))
    );
  };
  return tags.find(isOlder) ?? null;
}

function baselineTemplates(tag: string): Map<string, TemplateDef> {
  const raw = execSync(`git show ${tag}:apps/server/src/templates/registry.json`, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as { templates: TemplateDef[] };
  return new Map(parsed.templates.map((t) => [t.id, t]));
}

describe('registry drift guard', () => {
  const current = JSON.parse(
    readFileSync(new URL('../src/templates/registry.json', import.meta.url), 'utf8'),
  ) as { templates: TemplateDef[] };
  const currentById = new Map(current.templates.map((t) => [t.id, t]));

  const tag = previousTag();
  const baseline = tag ? baselineTemplates(tag) : null;

  it.skipIf(baseline === null)('keeps released template definitions from silently losing fields', () => {
    let shared = 0;
    for (const [id, oldDef] of baseline!) {
      const newDef = currentById.get(id);
      if (!newDef) continue; // removals of whole templates are a product decision
      shared++;

      // env keys must survive unless the removal is on the allowlist
      const oldKeys = (oldDef.env ?? []).map((e) => e.key);
      const newKeys = new Set((newDef.env ?? []).map((e) => e.key));
      for (const key of oldKeys) {
        if (newKeys.has(key)) continue;
        expect(
          ALLOWED_ENV_REMOVALS.has(`${id}:${key}`),
          `${id}: env key "${key}" disappeared — add it to ALLOWED_ENV_REMOVALS if this is deliberate`,
        ).toBe(true);
      }

      // engine contracts must survive
      if (oldDef.dbEngine && !newDef.dbEngine) {
        expect(
          ALLOWED_ENGINE_REMOVALS.has(id),
          `${id}: dbEngine "${oldDef.dbEngine}" disappeared — allowlist it if deliberate`,
        ).toBe(true);
      }
      const oldDbKeys = Object.keys(oldDef.databaseEnv ?? {});
      const newDbKeys = new Set(Object.keys(newDef.databaseEnv ?? {}));
      for (const key of oldDbKeys) {
        if (newDbKeys.has(key)) continue;
        expect(
          ALLOWED_ENGINE_REMOVALS.has(`${id}:${key}`),
          `${id}: databaseEnv key "${key}" disappeared — allowlist it if deliberate`,
        ).toBe(true);
      }

      // volume mounts must survive
      if (oldDef.volumeMount && !newDef.volumeMount) {
        expect(
          ALLOWED_VOLUME_REMOVALS.has(id),
          `${id}: volumeMount "${oldDef.volumeMount}" disappeared — allowlist it if deliberate`,
        ).toBe(true);
      }
    }
    // The guard must actually compare something — a broken baseline lookup
    // would silently make this test vacuous.
    expect(shared).toBeGreaterThan(80);
  });
});
