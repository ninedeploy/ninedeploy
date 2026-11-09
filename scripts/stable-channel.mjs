#!/usr/bin/env node
// A6 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): the `stable` release channel.
//
// `stable` is a lightweight git tag that points at a published release. The
// daily .github/workflows/stable-channel.yml runs this script to decide where
// it should point, then moves the tag. Panels on the stable channel and
// `install.sh --channel stable` offer the release the tag points at.
//
// Rules, in order:
//   - only published (not draft, not prerelease) vX.Y.Z releases count;
//   - a release whose notes contain `<!-- stable: hold -->` never becomes
//     stable (mark a release that turned out to regress);
//   - a release whose notes contain `<!-- stable: security -->` becomes
//     stable at once. Only the explicit marker counts: most CHANGELOG
//     sections carry a `### Security` heading, so matching on it would skip
//     the soak for nearly every release;
//   - any other release becomes stable once it has been published for
//     SOAK_DAYS (7) days;
//   - stable never moves backwards.
//
// Usage: node scripts/stable-channel.mjs <releases.json> [current-stable-tag] [now-iso]
// Prints the tag to promote, or nothing when stable should stay where it is.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SOAK_DAYS = 7;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

function parts(tag) {
  const m = TAG.exec(tag);
  return m ? [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])] : null;
}

export function newer(a, b) {
  const x = parts(a);
  const y = parts(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function isHeld(body) {
  return /<!--\s*stable:\s*hold\s*-->/i.test(body ?? '');
}

export function isSecurity(body) {
  return /<!--\s*stable:\s*security\s*-->/i.test(body ?? '');
}

/**
 * @param {Array<{ tag_name: string, draft?: boolean, prerelease?: boolean, published_at?: string | null, body?: string | null }>} releases
 * @param {string | null} currentStable
 * @param {Date} now
 * @returns {{ tag: string | null, reason: string }}
 */
export function pickStable(releases, currentStable, now = new Date()) {
  const soakMs = SOAK_DAYS * 24 * 60 * 60 * 1000;
  let best = null;
  let why = '';
  for (const r of releases) {
    if (!r || r.draft || r.prerelease || !TAG.test(r.tag_name ?? '') || !r.published_at) continue;
    if (isHeld(r.body)) continue;
    const age = now.getTime() - Date.parse(r.published_at);
    if (!Number.isFinite(age) || age < 0) continue;
    const security = isSecurity(r.body);
    if (age < soakMs && !security) continue;
    if (!best || newer(r.tag_name, best)) {
      best = r.tag_name;
      why = security && age < soakMs ? 'security release, promoted without waiting' : `published ${Math.floor(age / 86_400_000)} days ago`;
    }
  }
  if (!best) return { tag: null, reason: 'no release qualifies yet' };
  if (currentStable && !newer(best, currentStable)) return { tag: null, reason: `stable is already ${currentStable}` };
  return { tag: best, reason: why };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, current, nowIso] = process.argv.slice(2);
  if (!file) {
    console.error('usage: stable-channel.mjs <releases.json> [current-stable-tag] [now-iso]');
    process.exit(2);
  }
  const releases = JSON.parse(readFileSync(file, 'utf8'));
  const { tag, reason } = pickStable(Array.isArray(releases) ? releases.flat() : [], current || null, nowIso ? new Date(nowIso) : new Date());
  console.error(tag ? `promote ${tag}: ${reason}` : `no change: ${reason}`);
  if (tag) process.stdout.write(tag);
}
