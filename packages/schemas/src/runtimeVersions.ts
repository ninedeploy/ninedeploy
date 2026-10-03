/**
 * Curated runtime version catalog — the single source of truth for every
 * language version NineDeploy suggests anywhere in the product (Manifest
 * Creator presets, the CLI's `starterManifest`, the runtime version picker).
 *
 * Why this file exists: these versions used to be hand-written literals
 * duplicated across `apps/web` and `packages/sdk`. Nobody owned them, so
 * they drifted until the shipped defaults pinned runtimes that had gone
 * end-of-life. Everything now derives from this one table.
 *
 * The catalog is *advisory*, never a constraint. `runtime.version` in the
 * manifest schema stays free-form (`^\d+(?:\.\d+){0,2}$`), so an operator
 * can pin any version their build needs — including an EOL one. What the
 * catalog buys us is a sensible default plus an honest warning when the
 * pinned version is no longer supported upstream.
 *
 * ── Maintaining this file ────────────────────────────────────────────────
 * Bump `RUNTIME_CATALOG_REVIEWED` whenever you touch the table, and check
 * it against upstream release schedules:
 *   Node    https://nodejs.org/en/about/previous-releases
 *   Python  https://devguide.python.org/versions/
 *   Go      https://go.dev/doc/devel/release
 *   Ruby    https://www.ruby-lang.org/en/downloads/branches/
 *   PHP     https://www.php.net/supported-versions.php
 *   Java    https://adoptium.net/support/
 *   Rust    https://www.rust-lang.org/
 */
import type { RuntimeType } from './ninedeployManifest.js';

/**
 * ISO date the table below was last checked against upstream schedules.
 * Surfaced in the UI so a stale catalog is visible rather than silent.
 */
export const RUNTIME_CATALOG_REVIEWED = '2026-08-26';

/**
 * Upstream support state of a version, ordered from healthiest to worst.
 *
 * - `current`     — newest stable release; ahead of the recommended pin.
 * - `lts`         — long-term-support line; the safe production choice.
 * - `maintenance` — still supported, but no longer the primary line.
 * - `security`    — security fixes only; no bug fixes.
 * - `eol`         — unsupported upstream. Usable, but nothing gets patched.
 */
export type RuntimeSupport = 'current' | 'lts' | 'maintenance' | 'security' | 'eol';

export interface RuntimeVersionOption {
  /** Value written into `runtime.version` — matches the manifest regex. */
  version: string;
  /** Human label for the picker, e.g. "24 — Active LTS". */
  label: string;
  support: RuntimeSupport;
  /** ISO date support ends (or ended). Omitted when upstream has not set one. */
  eol?: string;
}

export interface RuntimeVersionCatalogEntry {
  /** Display name used in advisory messages, e.g. "Node.js". */
  name: string;
  /** The version presets and the "recommended" hint use. Must appear in `options`. */
  recommended: string;
  /** Newest first — the picker renders them in this order. */
  options: readonly RuntimeVersionOption[];
}

/**
 * Versions offered per runtime. Only runtimes we can meaningfully pin appear
 * here; `auto` and `static` have no version axis and are absent by design.
 *
 * Each list keeps a couple of EOL entries on purpose: teams migrating an
 * existing app need to reproduce their current runtime before they can move
 * off it, and an undocumented version they have to guess at is worse than a
 * documented one carrying a warning.
 */
export const RUNTIME_VERSION_CATALOG: Partial<Record<RuntimeType, RuntimeVersionCatalogEntry>> = {
  node: {
    name: 'Node.js',
    recommended: '24',
    options: [
      { version: '26', label: '26 — Current', support: 'current', eol: '2029-04-30' },
      { version: '24', label: '24 — Active LTS', support: 'lts', eol: '2028-04-30' },
      { version: '22', label: '22 — Maintenance LTS', support: 'maintenance', eol: '2027-04-30' },
      { version: '20', label: '20 — end-of-life', support: 'eol', eol: '2026-04-30' },
      { version: '18', label: '18 — end-of-life', support: 'eol', eol: '2025-04-30' },
    ],
  },
  python: {
    name: 'Python',
    recommended: '3.14',
    options: [
      { version: '3.14', label: '3.14 — latest stable', support: 'current', eol: '2030-10-31' },
      { version: '3.13', label: '3.13 — bugfix', support: 'maintenance', eol: '2029-10-31' },
      { version: '3.12', label: '3.12 — security fixes only', support: 'security', eol: '2028-10-31' },
      { version: '3.11', label: '3.11 — security fixes only', support: 'security', eol: '2027-10-31' },
    ],
  },
  go: {
    name: 'Go',
    recommended: '1.27',
    options: [
      { version: '1.27', label: '1.27 — latest stable', support: 'current' },
      { version: '1.26', label: '1.26 — supported', support: 'maintenance' },
      { version: '1.25', label: '1.25 — end-of-life', support: 'eol' },
      { version: '1.24', label: '1.24 — end-of-life', support: 'eol' },
    ],
  },
  ruby: {
    name: 'Ruby',
    recommended: '3.4',
    options: [
      { version: '4.0', label: '4.0 — latest stable', support: 'current' },
      { version: '3.4', label: '3.4 — normal maintenance', support: 'maintenance' },
      { version: '3.3', label: '3.3 — security fixes only', support: 'security', eol: '2027-03-31' },
      { version: '3.2', label: '3.2 — end-of-life', support: 'eol', eol: '2026-04-01' },
    ],
  },
  php: {
    name: 'PHP',
    recommended: '8.4',
    options: [
      { version: '8.5', label: '8.5 — active support', support: 'current', eol: '2029-12-31' },
      { version: '8.4', label: '8.4 — active support', support: 'maintenance', eol: '2028-12-31' },
      { version: '8.3', label: '8.3 — security fixes only', support: 'security', eol: '2027-12-31' },
      { version: '8.2', label: '8.2 — security fixes only', support: 'security', eol: '2026-12-31' },
      { version: '8.1', label: '8.1 — end-of-life', support: 'eol', eol: '2025-12-31' },
    ],
  },
  java: {
    name: 'Java',
    recommended: '25',
    options: [
      { version: '26', label: '26 — latest feature release (non-LTS)', support: 'current' },
      { version: '25', label: '25 — LTS', support: 'lts', eol: '2031-09-30' },
      { version: '21', label: '21 — LTS', support: 'lts', eol: '2029-12-31' },
      { version: '17', label: '17 — LTS', support: 'maintenance', eol: '2027-10-31' },
    ],
  },
  rust: {
    name: 'Rust',
    // Rust ships a new stable every six weeks and backports nothing, so any
    // version below the newest stable is unsupported by definition. Expect
    // this list to need a bump more often than the others.
    recommended: '1.98',
    options: [
      { version: '1.98', label: '1.98 — latest stable', support: 'current' },
      { version: '1.97', label: '1.97 — superseded', support: 'eol' },
      { version: '1.96', label: '1.96 — superseded', support: 'eol' },
      { version: '1.95', label: '1.95 — superseded', support: 'eol' },
    ],
  },
};

/** Versions offered for a runtime type. Empty for types with no version axis. */
export function runtimeVersionOptions(type: RuntimeType): readonly RuntimeVersionOption[] {
  return RUNTIME_VERSION_CATALOG[type]?.options ?? [];
}

/**
 * The version presets pin for a runtime, or `undefined` when the type has no
 * version axis (`auto`, `static`) — in which case the manifest should omit
 * `runtime.version` entirely and let Nixpacks decide.
 */
export function recommendedRuntimeVersion(type: RuntimeType): string | undefined {
  return RUNTIME_VERSION_CATALOG[type]?.recommended;
}

/**
 * Resolve an operator-typed version to its catalog entry.
 *
 * Matching is longest-prefix on dot boundaries, so `20.18.1` resolves to
 * Node's `20` entry and `3.12.4` to Python's `3.12` — pinning a patch
 * release still yields the right support status. The dot boundary is what
 * keeps `2` from matching `20`.
 */
export function findRuntimeVersion(
  type: RuntimeType,
  version: string,
): RuntimeVersionOption | undefined {
  return [...runtimeVersionOptions(type)]
    .sort((a, b) => b.version.length - a.version.length)
    .find((o) => version === o.version || version.startsWith(`${o.version}.`));
}

/** A note to show next to the version field. `error` is not a blocker — only a warning. */
export interface RuntimeVersionAdvisory {
  level: 'error' | 'warn' | 'info';
  message: string;
}

/**
 * Describe the health of a pinned version, or `null` when there is nothing
 * worth saying (supported version, no version pinned, runtime with no
 * version axis).
 *
 * Deliberately never rejects: an EOL pin is a warning, not an error, because
 * reproducing a legacy runtime is a legitimate reason to deploy one.
 */
export function runtimeVersionAdvisory(
  type: RuntimeType,
  version: string | undefined,
): RuntimeVersionAdvisory | null {
  const entry = RUNTIME_VERSION_CATALOG[type];
  if (!entry || !version) return null;

  const match = findRuntimeVersion(type, version);
  if (!match) {
    return {
      level: 'info',
      message: `${entry.name} ${version} is not in NineDeploy's catalog (last reviewed ${RUNTIME_CATALOG_REVIEWED}). The build will still try it — Nixpacks resolves the version itself.`,
    };
  }

  // One shared clause for both levels: upstream dates are a label, not a
  // tense, so the same wording works whether the date is past or future.
  const support = match.eol ? ` Upstream support: ${match.eol}.` : '';

  if (match.support === 'eol') {
    return {
      level: 'error',
      message: `${entry.name} ${match.version} is end-of-life and no longer receives security patches. You can still deploy it — ${entry.recommended} is the recommended pin.${support}`,
    };
  }

  if (match.support === 'security') {
    return {
      level: 'warn',
      message: `${entry.name} ${match.version} receives security fixes only — no bug fixes. Recommended pin: ${entry.recommended}.${support}`,
    };
  }

  return null;
}
