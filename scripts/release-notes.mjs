#!/usr/bin/env node
// A6 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): user-facing release notes.
//
// Every CHANGELOG.md version section starts with a short block for people
// who run NineDeploy, before the long lists:
//
//   ## [0.18.27] - 2026-11-20
//
//   **Highlights**
//   - one line per change a user notices, at most three
//
//   **Action needed:** No.            (or: No. <a short note>, or: Yes: <what to do, in one sentence>)
//
// CI, test and tooling entries go in a closing `### Internal` subsection.
// A stable-channel marker (`<!-- stable: security -->`, `<!-- stable: hold -->`)
// in the section is carried into the GitHub release notes, where
// scripts/stable-channel.mjs reads it.
//
// Usage:
//   node scripts/release-notes.mjs vX.Y.Z [CHANGELOG.md]          the GitHub release body (stdout)
//   node scripts/release-notes.mjs --check X.Y.Z [CHANGELOG.md]   exit 1 with the reason when the block is missing
// The body falls back to the plain notes (with a warning on stderr) for a
// section without the block, so re-running the release of an older tag works.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_HIGHLIGHTS = 3;

/** The text of `## [version]` up to the next `## [` heading, or null. */
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The block at the top of a section; throws with the reason when it is missing or malformed. */
export function releaseSummary(section) {
  const lines = section.split('\n');
  const firstHeading = lines.findIndex((l) => l.startsWith('### '));
  const head = (firstHeading < 0 ? lines : lines.slice(0, firstHeading)).map((l) => l.trimEnd());
  const h = head.findIndex((l) => l.trim() === '**Highlights**');
  if (h < 0) throw new Error('the section does not start with a **Highlights** list (before its first ### heading)');
  const highlights = [];
  for (let i = h + 1; i < head.length; i++) {
    const l = head[i];
    if (l.startsWith('- ')) highlights.push(l.slice(2).trim());
    else if (l.trim() === '' && highlights.length === 0) continue;
    else break;
  }
  if (highlights.length === 0) throw new Error('**Highlights** has no bullet');
  if (highlights.length > MAX_HIGHLIGHTS) throw new Error(`**Highlights** has ${highlights.length} bullets; keep at most ${MAX_HIGHLIGHTS} (the rest belong in the lists below)`);
  if (highlights.some((b) => b.length > 300)) throw new Error('a highlight is longer than 300 characters; keep each to one line a user reads at a glance');
  const actionLine = head.find((l) => l.startsWith('**Action needed:**'));
  if (!actionLine) throw new Error('the section has no **Action needed:** line (No. / Yes: …) before its first ### heading');
  const action = actionLine.slice('**Action needed:**'.length).trim();
  if (!/^(No\.(\s+\S.*)?|Yes:\s*\S.*)$/.test(action)) throw new Error(`**Action needed:** must read "No." (optionally with a short note) or "Yes: <what to do>", not "${action}"`);
  const markers = [...new Set(section.match(/<!-- stable: (security|hold) -->/g) ?? [])];
  return { highlights, action, markers };
}

/** The GitHub release body. `summary` null = the plain notes of a release before A6. */
export function releaseBody({ tag, repo, summary }) {
  const out = [];
  if (summary) {
    out.push('## Highlights', '', ...summary.highlights.map((b) => `- ${b}`), '', `**Action needed:** ${summary.action}`, '');
    out.push(`Everything in this release: [CHANGELOG.md](https://github.com/${repo}/blob/${tag}/CHANGELOG.md).`, '');
  } else {
    out.push(`See [CHANGELOG.md](https://github.com/${repo}/blob/${tag}/CHANGELOG.md) for the full release notes.`, '');
  }
  out.push(
    '**Pull the image:**',
    '```',
    `docker pull ghcr.io/ninedeploy/ninedeploy:${tag}`,
    'docker pull ghcr.io/ninedeploy/ninedeploy:latest',
    '```',
    '',
    `**Verify it:** the image is signed with cosign (keyless) and carries build provenance; \`SHA256SUMS\` covers the source archive, \`install.sh\` and the desktop installers, and \`SHA256SUMS.sigstore.json\` is its signature. See [Verifying a release](https://github.com/${repo}/blob/${tag}/README.md#verifying-a-release).`,
    '',
    `**Desktop app:** Windows (\`.exe\`), macOS (\`.dmg\`, Intel and Apple silicon) and Linux (\`.AppImage\`, \`.deb\`). The installers are not code-signed yet: Windows SmartScreen warns about an unknown publisher, and macOS opens the app only after you allow it under System Settings → Privacy & Security. Keeping the sign-in through the macOS Keychain is not verified yet. See [Desktop client](https://github.com/${repo}/blob/${tag}/docs/DESKTOP.md).`,
  );
  if (summary?.markers.length) out.push('', ...summary.markers);
  return `${out.join('\n')}\n`;
}

function main(argv) {
  const check = argv[0] === '--check';
  const [rawVersion, file = 'CHANGELOG.md'] = check ? argv.slice(1) : argv;
  const version = (rawVersion ?? '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('usage: release-notes.mjs vX.Y.Z [CHANGELOG.md] | --check X.Y.Z [CHANGELOG.md]');
    return 2;
  }
  const section = changelogSection(readFileSync(file, 'utf8'), version);
  if (check) {
    if (section === null) {
      console.error(`CHANGELOG has no ## [${version}] section`);
      return 1;
    }
    try {
      releaseSummary(section);
      return 0;
    } catch (err) {
      console.error(`CHANGELOG ## [${version}]: ${err.message}`);
      return 1;
    }
  }
  let summary = null;
  try {
    if (section !== null) summary = releaseSummary(section);
  } catch (err) {
    console.error(`warning: ${err.message}; the release gets the plain notes`);
  }
  process.stdout.write(releaseBody({ tag: `v${version}`, repo: process.env.GITHUB_REPOSITORY || 'ninedeploy/ninedeploy', summary }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
