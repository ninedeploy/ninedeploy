import changelogData from './changelog.json' with { type: 'json' };

// Owner policy: 1.0.0 does not exist. The 0.9.x line runs to 0.9.99 and
// rolls 0.9.99 -> 0.10.0 — bumping to a 1.x major is a positioning decision
// reserved for the owner, never a release-script accident.
export const VERSION = '0.16.13';

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

/**
 * Release history shown on the About page, newest first. The data lives in
 * `changelog.json` next to this file (tsc copies it into `dist/` at build
 * time, like `templates/registry.json`); `scripts/bump-version.js` prepends
 * the stub for a new release there and `scripts/tag-release.js` checks that
 * `CHANGELOG[0].version === VERSION` before tagging.
 */
export const CHANGELOG: ChangelogEntry[] = changelogData;

export const ABOUT = {
  name: 'NineDeploy',
  version: VERSION,
  description: 'Self-hosted deployment platform — deploy apps from Git or Docker Hub in one click.',
  license: 'MIT',
  repo: 'https://github.com/ninedeploy/ninedeploy',
  docs: 'https://github.com/ninedeploy/ninedeploy#readme',
  techStack: [
    { category: 'Runtime', items: ['Node.js ≥ 22.13', 'TypeScript 7 (strict)'] },
    { category: 'Backend', items: ['Fastify 5', 'Zod 4', 'WebSocket', 'Drizzle ORM'] },
    { category: 'Database', items: ['SQLite (node:sqlite)'] },
    { category: 'Frontend', items: ['React 19', 'Vite 8', 'Tailwind v4', 'React Flow'] },
    { category: 'Deploy', items: ['Docker (BuildKit)', 'PM2', 'Traefik v3', 'Cloudflare Tunnel'] },
    { category: 'Security', items: ['AES-256-GCM', 'JWT', 'Argon2', 'HMAC webhooks'] },
  ],
  changelog: CHANGELOG,
};
