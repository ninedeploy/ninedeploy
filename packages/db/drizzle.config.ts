import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

// Resolve the data dir relative to the repo root so it matches the server,
// regardless of which package dir the CLI is invoked from.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const defaultDb = path.join(repoRoot, '.data', 'ninedeploy.db');

// r362: a RELATIVE NINEDEPLOY_DB_PATH (.env.example ships `./.data/ninedeploy.db`)
// must also be anchored at the repo root. `pnpm db:migrate` runs drizzle-kit
// with cwd=packages/db, so the installer's migrate step — which exports .env —
// migrated a stray `packages/db/.data/ninedeploy.db` while the server (cwd =
// the install dir) kept reading the real one. The server then migrated on its
// own boot, which hid it; the installer's upgrade rollback (r357) keys its
// database handling on that step.
const rawPath = (process.env['NINEDEPLOY_DB_PATH'] ?? defaultDb).replace(/^file:/, '');
const dbPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
const cleanPath = dbPath;
try {
  mkdirSync(path.dirname(path.resolve(cleanPath)), { recursive: true });
} catch {
  // safe ignore
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'turso',
  dbCredentials: {
    url: `file:${dbPath}`,
  },
  verbose: true,
  strict: true,
});
