import { appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiRoutes } from '../../src/modules/ai.js';
import { config } from '../../src/config.js';
import { encrypt } from '../../src/lib/crypto.js';
import { asUser, buildTestApp, createFakeDb, depRow, svcRow } from '../helpers.js';

const SVC = svcRow({ id: 5, name: 'web', slug: 'web', status: 'running' });
const TEST_KEY = 'sk-test-1234567890';

function logFile(depId: number): string {
  return path.join(config.paths.logsDir, `${depId}.log`);
}

/** settings.findFirst is read twice per request (config JSON, then key) — alternate rows. */
function alternatingSettings(): () => Record<string, unknown> {
  let n = 0;
  return () =>
    n++ === 0
      ? { key: 'ai_diagnosis_config', value: { baseUrl: 'https://ai.example.com/v1', model: 'gpt-test' } }
      : { key: 'ai_diagnosis_key_encrypted', value: encrypt(TEST_KEY) };
}

describe('AI diagnosis routes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(logFile(77), { force: true });
  });

  it('reports unconfigured state to any authenticated user', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'GET', url: '/ai/config', headers: asUser({ isOperator: false }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, baseUrl: null, model: null, hasApiKey: false });
    await app.close();
  });

  it('refuses config writes from non-operators', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({
      method: 'PUT',
      url: '/ai/config',
      headers: asUser({ isOperator: false }),
      payload: { baseUrl: 'https://ai.example.com/v1', model: 'gpt-test', apiKey: 'sk-test-1234567890' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('seals the API key at rest and never returns it', async () => {
    const settingInserts: Array<Record<string, unknown>> = [];
    const app = await buildTestApp({
      db: createFakeDb({
        insert: {
          settings: (v: Record<string, unknown>) => {
            settingInserts.push(v);
            return [{ ...v }];
          },
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({
      method: 'PUT',
      url: '/ai/config',
      headers: asUser(),
      payload: { baseUrl: 'https://ai.example.com/v1', model: 'gpt-test', apiKey: 'sk-test-1234567890' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(settingInserts).toHaveLength(2);
    const [configRow, keyRow] = settingInserts;
    expect(configRow).toMatchObject({ key: 'ai_diagnosis_config', value: { baseUrl: 'https://ai.example.com/v1', model: 'gpt-test' } });
    expect(keyRow).toMatchObject({ key: 'ai_diagnosis_key_encrypted' });
    // Sealed envelope, not the plaintext key.
    expect(String(keyRow!.value)).not.toContain('sk-test-1234567890');
    await app.close();
  });

  it('refuses to diagnose when not configured', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: SVC, deployments: depRow({ id: 77, serviceId: 5, status: 'failed' }) } }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('refuses to diagnose a deployment that did not fail', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: SVC,
          deployments: depRow({ id: 77, serviceId: 5, status: 'running' }),
          settings: alternatingSettings(),
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('refuses deployments that belong to another service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: SVC,
          deployments: depRow({ id: 77, serviceId: 9, status: 'failed' }),
          settings: alternatingSettings(),
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('refuses when the deployment has no build log', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: SVC,
          deployments: depRow({ id: 77, serviceId: 5, status: 'failed' }),
          settings: alternatingSettings(),
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('diagnoses a failed build and sanitizes the log it sends', async () => {
    appendFileSync(logFile(77), [
      'Step 4/7 RUN npm ci',
      'npm error Unauthorized — DB_PASSWORD=hunter2',
      'see https://deploy:hunter2@github.com/acme/web.git',
      '{"env":{"NODE_ENV":"production","DB_PASSWORD":"json-only-secret"}}',
      'npm error exit code 1',
    ].join('\n'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Root cause: bad credentials. Evidence: … Fix: 1. …' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: SVC,
          deployments: depRow({ id: 77, serviceId: 5, status: 'failed' }),
          settings: alternatingSettings(),
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ model: 'gpt-test' });
    expect(String(res.json().diagnosis)).toContain('Root cause');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://ai.example.com/v1/chat/completions');
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }>; model: string };
    expect(body.model).toBe('gpt-test');
    const sentLog = body.messages[1]!.content;
    expect(sentLog).toContain('DB_PASSWORD=');
    expect(sentLog).not.toContain('hunter2');
    expect(sentLog).not.toContain('json-only-secret');
    expect(sentLog).not.toContain('deploy:hunter2@');
    await app.close();
  });

  it('maps an upstream rejection to 502 without relaying the body', async () => {
    appendFileSync(logFile(77), 'boom');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: SVC,
          deployments: depRow({ id: 77, serviceId: 5, status: 'failed' }),
          settings: alternatingSettings(),
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain('sk-');
    await app.close();
  });

  it('maps a structurally unreadable provider response to 502, not 500 (r082)', async () => {
    appendFileSync(logFile(77), 'boom');
    // A provider that answers 200 with {"choices":[null]} must surface as the
    // documented ai_upstream 502 — not an unhandled TypeError 500.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [null] }) }),
    );
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: SVC,
          deployments: depRow({ id: 77, serviceId: 5, status: 'failed' }),
          settings: alternatingSettings(),
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('maps an unreachable provider to 504', async () => {
    appendFileSync(logFile(77), 'boom');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
    );
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: SVC,
          deployments: depRow({ id: 77, serviceId: 5, status: 'failed' }),
          settings: alternatingSettings(),
        },
      }),
    });
    await app.register(aiRoutes, { prefix: '/ai' });
    const res = await app.inject({ method: 'POST', url: '/ai/services/5/deploys/77/diagnose', headers: asUser() });
    expect(res.statusCode).toBe(504);
    await app.close();
  });
});
