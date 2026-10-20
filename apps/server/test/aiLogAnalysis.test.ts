/**
 * 0.16.15 Claude as a provider and runtime-log analysis, against a real
 * migrated SQLite: the provider round-trips through the config routes (an
 * old row with no provider still means openai), each provider gets the
 * request it expects, and `POST /ai/services/:id/logs/analyze` reads the
 * service's runtime logs, sanitizes them and keeps a protected lane's logs
 * for its admins.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, environments, services, serviceWorkspaces, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';

const logs = vi.hoisted(() => ({ readRuntimeLogs: vi.fn(async (..._a: unknown[]) => '') }));
vi.mock('../src/lib/runtimeLogs.js', () => logs);

const { aiRoutes } = await import('../src/modules/ai.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { getSettingJson, setSettingJson, setSettingString } = await import('../src/lib/settings.js');
const { aiComplete, aiRequest, effectiveBaseUrl, parseAnthropicContent } = await import('../src/lib/aiProvider.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const KEY = ['sk', 'ant', 'test', 'key'].join('-');

let db: DB;
let close: () => void;
let dir: string;
let app: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;
const OPERATOR = asUser({ id: 1, isOperator: true });
const MEMBER = asUser({ id: 2, isOperator: false });

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ai-logs-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await db.insert(users).values([
    { id: 1, email: 'op@x.test', passwordHash: 'h', isInstanceOperator: true },
    { id: 2, email: 'member@x.test', passwordHash: 'h' },
  ]);
  await db.insert(workspaces).values({ id: 1, name: 'Team', slug: 'team', ownerId: 1 });
  await db.insert(workspaceMembers).values([
    { workspaceId: 1, userId: 1, role: 'owner' },
    { workspaceId: 1, userId: 2, role: 'member' },
  ]);
  await db.insert(environments).values({ id: 1, workspaceId: 1, name: 'production', slug: 'production' });
  await db.insert(services).values([
    { id: 5, name: 'api', slug: 'api', type: 'docker', ownerUserId: 1, runtimeId: 'api-1', environmentId: 1 },
    { id: 6, name: 'idle', slug: 'idle', type: 'docker', ownerUserId: 1 },
  ] as never);
  await db.insert(serviceWorkspaces).values([
    { serviceId: 5, workspaceId: 1 },
    { serviceId: 6, workspaceId: 1 },
  ]);
  await setSettingJson(db, 'ai_diagnosis_config', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  await setSettingString(db, 'ai_diagnosis_key_encrypted', encrypt(KEY));
  fetchMock = vi.fn().mockResolvedValue(reply({ content: [{ type: 'text', text: 'Health: degraded.' }] }));
  vi.stubGlobal('fetch', fetchMock);
  logs.readRuntimeLogs.mockReset();
  logs.readRuntimeLogs.mockResolvedValue('2026-10-20T10:00:00Z GET /health 200\n2026-10-20T10:00:01Z Error: ECONNREFUSED db:5432\nDB_PASSWORD=hunter2\n');

  app = await buildTestApp({ db });
  await app.register(aiRoutes, { prefix: '/ai' });
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the file a moment longer */
  }
});

describe('providers', () => {
  it('builds the Anthropic Messages request and reads its text blocks', async () => {
    const cfg = { provider: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/', model: 'claude-sonnet-5-5', apiKey: KEY };
    const req = aiRequest(cfg, { system: 'sys', user: 'hello' }, 300);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
    expect(req.headers).not.toHaveProperty('authorization');
    expect(req.body).toEqual({ model: 'claude-sonnet-5-5', max_tokens: 300, system: 'sys', messages: [{ role: 'user', content: 'hello' }] });
    expect(parseAnthropicContent({ content: [{ type: 'text', text: ' a' }, { type: 'tool_use' }, { type: 'text', text: 'b ' }] })).toBe('ab');
    for (const bad of [null, 'x', {}, { content: 'x' }, { content: [] }, { content: [{ type: 'text', text: '  ' }] }]) {
      expect(parseAnthropicContent(bad)).toBeNull();
    }
  });

  it('keeps the OpenAI-compatible request as it was', () => {
    const req = aiRequest({ provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: KEY }, { system: 's', user: 'u' }, 200);
    expect(req.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).toEqual({
      model: 'llama3.1',
      max_tokens: 200,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
    });
  });

  it('names the base URL a stored configuration calls', () => {
    expect(effectiveBaseUrl(null)).toBeNull();
    expect(effectiveBaseUrl({ model: 'm' })).toBeNull();
    expect(effectiveBaseUrl({ baseUrl: 'https://x/v1' })).toBe('https://x/v1');
    expect(effectiveBaseUrl({ provider: 'anthropic' })).toBe('https://api.anthropic.com');
  });

  it('turns upstream failures into errors that never echo the body', async () => {
    const cfg = { provider: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: KEY };
    await expect(aiComplete(cfg, { system: 's', user: 'u' }, 10, vi.fn().mockResolvedValue(reply({ error: KEY }, 401)) as never)).rejects.toMatchObject({
      statusCode: 502,
      message: 'The AI provider rejected the request (HTTP 401).',
    });
    await expect(aiComplete(cfg, { system: 's', user: 'u' }, 10, vi.fn().mockResolvedValue(reply({ content: [] })) as never)).rejects.toMatchObject({
      message: 'The AI provider returned an unreadable response.',
    });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    await expect(aiComplete(cfg, { system: 's', user: 'u' }, 10, vi.fn().mockRejectedValue(timeout) as never)).rejects.toMatchObject({
      statusCode: 504,
      message: 'The AI provider timed out.',
    });
    await expect(aiComplete(cfg, { system: 's', user: 'u' }, 10, vi.fn().mockRejectedValue(new Error('x')) as never)).rejects.toMatchObject({
      message: 'The AI provider is unreachable.',
    });
    const unparsable = { ok: true, status: 200, json: async () => Promise.reject(new Error('bad json')) };
    await expect(aiComplete(cfg, { system: 's', user: 'u' }, 10, vi.fn().mockResolvedValue(unparsable) as never)).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('config routes', () => {
  it('report the provider; a row from before 0.16.15 reads as openai', async () => {
    const asOp = (await app.inject({ url: '/ai/config', headers: OPERATOR })).json();
    expect(asOp).toEqual({ configured: true, provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', hasApiKey: true });
    await setSettingJson(db, 'ai_diagnosis_config', { baseUrl: 'https://ai.example.com/v1', model: 'gpt-test' });
    const old = (await app.inject({ url: '/ai/config', headers: MEMBER })).json();
    expect(old).toEqual({ configured: true, provider: 'openai', baseUrl: null, model: 'gpt-test', hasApiKey: true });
  });

  it('store Claude without a base URL, and refuse openai without one', async () => {
    const put = await app.inject({ method: 'PUT', url: '/ai/config', headers: OPERATOR, payload: { provider: 'anthropic', model: 'claude-opus-5-5' } });
    expect(put.statusCode, put.body).toBe(200);
    expect(await getSettingJson(db, 'ai_diagnosis_config', null)).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    const legacy = await app.inject({ method: 'PUT', url: '/ai/config', headers: OPERATOR, payload: { baseUrl: 'https://ai.example.com/v1', model: 'gpt-test' } });
    expect(legacy.statusCode).toBe(200);
    expect(await getSettingJson(db, 'ai_diagnosis_config', null)).toEqual({ provider: 'openai', baseUrl: 'https://ai.example.com/v1', model: 'gpt-test' });
    const missing = await app.inject({ method: 'PUT', url: '/ai/config', headers: OPERATOR, payload: { provider: 'openai', model: 'gpt-test' } });
    expect(missing.statusCode).toBe(400);
  });
});

describe('POST /ai/services/:id/logs/analyze', () => {
  it('sends the sanitized runtime log tail to Claude and answers the analysis', async () => {
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: MEMBER, payload: { tail: 100 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ analysis: 'Health: degraded.', model: 'claude-sonnet-5-5', lines: 3 });
    expect(logs.readRuntimeLogs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 5 }), 100);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const sent = JSON.parse(init.body as string);
    expect(sent.system).toContain('runtime logs of a running container service');
    expect(sent.messages[0].content).toContain('ECONNREFUSED db:5432');
    expect(sent.messages[0].content).not.toContain('hunter2');
  });

  it('defaults the tail and refuses a service with no runtime or no logs', async () => {
    await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: MEMBER });
    expect(logs.readRuntimeLogs).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 300);
    const idle = await app.inject({ method: 'POST', url: '/ai/services/6/logs/analyze', headers: MEMBER });
    expect(idle.json().error.code).toBe('not_running');
    logs.readRuntimeLogs.mockResolvedValueOnce('  \n');
    expect((await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: MEMBER })).json().error.code).toBe('no_logs');
    logs.readRuntimeLogs.mockRejectedValueOnce(new Error('docker down'));
    expect((await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: MEMBER })).json().error.code).toBe('no_logs');
    const bad = await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: MEMBER, payload: { tail: 5 } });
    expect(bad.statusCode).toBe(400);
  });

  it("keeps a protected lane's logs for its admins, and needs a configured provider", async () => {
    await db.update(environments).set({ protected: true });
    const refused = await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: MEMBER });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('protected_lane');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: OPERATOR })).statusCode).toBe(200);
    await setSettingJson(db, 'ai_diagnosis_config', { model: 'gpt-test' });
    expect((await app.inject({ method: 'POST', url: '/ai/services/5/logs/analyze', headers: OPERATOR })).json().error.message).toContain('not configured');
  });
});

describe('POST /ai/services/:id/deploys/:depId/diagnose (0.16.16 structured)', () => {
  it('redacts credentials in current settings and excludes credential-bearing settings from proposals', async () => {
    const { logBus } = await import('../src/engine/logs.js');
    const { deployments, buildConfigs } = await import('@ninedeploy/db');
    const installCmd = 'curl https://builder:inline-url-password@example.test/setup';
    const startCmd = 'NPM_TOKEN=inline-start-token npm start';
    const healthPath = '/health?token=inline-probe-token';
    await db.insert(buildConfigs).values({ serviceId: 5, buildPack: 'nixpacks', installCmd, startCmd, buildCmd: 'npm run build' } as never);
    await db.update(services).set({ healthPath }).where(eq(services.id, 5));
    const [dep] = await db.insert(deployments).values({ serviceId: 5, status: 'failed' }).returning();
    vi.spyOn(logBus, 'read').mockReturnValue('Error: listen failed\n');
    fetchMock.mockResolvedValueOnce(reply({ content: [{ type: 'text', text: JSON.stringify({
      rootCause: 'The app listens on a different port.',
      settings: { port: 8080, healthPath: '/health', build: { startCmd: 'node server.js', buildCmd: 'DATABASE_PASSWORD=proposed-password npm run build' } },
    }) }] }));
    const res = await app.inject({ method: 'POST', url: `/ai/services/5/deploys/${dep!.id}/diagnose`, headers: MEMBER });
    expect(res.statusCode, res.body).toBe(200);
    const sent = fetchMock.mock.calls[0]![1].body as string;
    for (const secret of ['inline-url-password', 'inline-start-token', 'inline-probe-token']) expect(sent).not.toContain(secret);
    expect(sent).toContain('npm run build');
    expect(sent).toContain('***');
    expect(res.json().proposal).toEqual({ settings: { port: 8080 } });
    expect(await db.query.buildConfigs.findFirst()).toMatchObject({ installCmd, startCmd, buildCmd: 'npm run build' });
    expect((await db.query.services.findFirst({ where: eq(services.id, 5) }))!.healthPath).toBe(healthPath);
  });

  it('answers the parts and a proposal that differs from the service, and the plain text for prose', async () => {
    const { appendFileSync } = await import('node:fs');
    const { config } = await import('../src/config.js');
    const { deployments, buildConfigs } = await import('@ninedeploy/db');
    await db.insert(buildConfigs).values({ serviceId: 5, buildPack: 'nixpacks', buildCmd: 'npm run build' } as never);
    const [dep] = await db.insert(deployments).values({ serviceId: 5, status: 'failed' }).returning();
    appendFileSync(path.join(config.paths.logsDir, `${dep!.id}.log`), 'Error: listen EADDRINUSE 3000\n');
    const structured = JSON.stringify({
      rootCause: 'The start command builds again instead of starting.',
      evidence: ['Error: listen EADDRINUSE 3000'],
      steps: ['Set the start command to node dist/server.js'],
      settings: { build: { buildCmd: 'npm run build', startCmd: 'node dist/server.js' } },
    });
    fetchMock.mockResolvedValueOnce(reply({ content: [{ type: 'text', text: structured }] }));
    const res = await app.inject({ method: 'POST', url: `/ai/services/5/deploys/${dep!.id}/diagnose`, headers: MEMBER });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      diagnosis: 'Root cause: The start command builds again instead of starting.\n\nEvidence:\n  Error: listen EADDRINUSE 3000\n\nFix:\n1. Set the start command to node dist/server.js',
      model: 'claude-sonnet-5-5',
      parts: { rootCause: 'The start command builds again instead of starting.', evidence: ['Error: listen EADDRINUSE 3000'], steps: ['Set the start command to node dist/server.js'] },
      proposal: { settings: { build: { startCmd: 'node dist/server.js' } } },
    });
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(sent.messages[0].content).toContain('"buildPack":"nixpacks"');

    fetchMock.mockResolvedValueOnce(reply({ content: [{ type: 'text', text: 'Root cause: the port.' }] }));
    const prose = await app.inject({ method: 'POST', url: `/ai/services/5/deploys/${dep!.id}/diagnose`, headers: MEMBER });
    expect(prose.json()).toEqual({ diagnosis: 'Root cause: the port.', model: 'claude-sonnet-5-5', parts: null, proposal: null });
  });
});
