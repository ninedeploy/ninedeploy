/**
 * Shared fixtures for the GitHub App tests (0.13): a migrated in-memory SQLite,
 * an RSA key pair made in the test, seed rows and a fake GitHub REST router
 * that stands in for `guardedFetch` (no network). Callers set
 * NINEDEPLOY_MASTER_KEY before the first encrypt/decrypt.
 */
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createDb, githubAppInstallations, githubApps, sources, type DB, type GithubApp, type GithubAppInstallation } from '@ninedeploy/db';
import { encrypt } from '../../src/lib/crypto.js';

const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/src/migrations', import.meta.url));

export async function migratedDb(): Promise<DB> {
  const { db } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

export function rsaKeyPair(type: 'pkcs1' | 'pkcs8' = 'pkcs1'): { privateKey: string; publicKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type, format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

let hookSeq = 0;

export async function seedApp(db: DB, privateKey: string, over: Partial<typeof githubApps.$inferInsert> = {}): Promise<GithubApp> {
  const [row] = await db
    .insert(githubApps)
    .values({
      name: 'NineDeploy test',
      appId: 4242,
      privateKeyEncrypted: encrypt(privateKey),
      webhookSecretEncrypted: encrypt('whsec_test'),
      hookKey: `hook${++hookSeq}`.padEnd(32, '0'),
      ...over,
    })
    .returning();
  return row!;
}

/** A `github_app` source plus its installation row. */
export async function seedInstallation(
  db: DB,
  app: GithubApp,
  over: Partial<typeof githubAppInstallations.$inferInsert> = {},
): Promise<{ inst: GithubAppInstallation; sourceId: number }> {
  const [src] = await db.insert(sources).values({ type: 'github_app', name: `acme (App)` }).returning();
  const [inst] = await db
    .insert(githubAppInstallations)
    .values({ githubAppId: app.id, installationId: 9001, accountLogin: 'acme', sourceId: src!.id, ...over })
    .returning();
  return { inst: inst!, sourceId: src!.id };
}

export interface FakeCall {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

type Reply = (call: FakeCall) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A fake GitHub API. `handler` has `guardedFetch`'s signature. By default
 * `POST /app/installations/:id/access_tokens` mints `ghs_<n>_SECRETTOKEN`
 * valid for an hour from `clock()`; anything unrouted answers 404.
 */
export function fakeGithub(clock: () => number = () => Date.now()) {
  const calls: FakeCall[] = [];
  const minted: string[] = [];
  const routes: Array<{ method: string; path: RegExp; reply: Reply }> = [];
  const on = (method: string, path: RegExp, reply: Reply) => {
    routes.unshift({ method, path, reply });
  };
  on('POST', /^\/app\/installations\/\d+\/access_tokens$/, () => {
    const token = `ghs_${minted.length + 1}_SECRETTOKEN`;
    minted.push(token);
    return json(201, { token, expires_at: new Date(clock() + 3600_000).toISOString() });
  });
  const handler = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: FakeCall = {
      method,
      url: u.toString(),
      path: u.pathname,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const route = routes.find((r) => r.method === method && r.path.test(u.pathname));
    return route ? route.reply(call) : json(404, { message: 'Not Found' });
  };
  return { calls, minted, on, handler };
}
