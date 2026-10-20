import { describe, expect, it, vi } from 'vitest';
import { aiConfigStatus, aiConfigUpdate, ANTHROPIC_DEFAULT_MODEL, runtimeLogAnalysis } from '@ninedeploy/schemas';
import { createClient } from '../src/index.js';

/** 0.16.15: Claude as a provider in the config shapes, and `ai.analyzeLogs`. */

function client() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    calls.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ analysis: 'ok', model: 'm', lines: 3 }) } as unknown as Response;
  });
  return { api: createClient({ baseUrl: 'http://api.test', fetch: fetchMock }), calls };
}

describe('ai.analyzeLogs', () => {
  it('posts the tail, or an empty body, to the shipped route', async () => {
    const { api, calls } = client();
    await expect(api.ai.analyzeLogs(4, { tail: 100 })).resolves.toEqual({ analysis: 'ok', model: 'm', lines: 3 });
    await api.ai.analyzeLogs(4);
    expect(calls).toEqual([
      { url: '/v1/ai/services/4/logs/analyze', method: 'POST', body: { tail: 100 } },
      { url: '/v1/ai/services/4/logs/analyze', method: 'POST', body: {} },
    ]);
  });
});

describe('provider shapes', () => {
  it('accept Claude without a base URL, and refuse openai without one', () => {
    expect(aiConfigUpdate.safeParse({ provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL }).success).toBe(true);
    expect(aiConfigUpdate.safeParse({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }).success).toBe(true);
    expect(aiConfigUpdate.safeParse({ provider: 'openai', model: 'gpt-4o-mini' }).success).toBe(false);
    expect(aiConfigStatus.parse({ configured: false, baseUrl: null, model: null, hasApiKey: false }).provider).toBeUndefined();
    expect(runtimeLogAnalysis.parse({ analysis: 'a', model: 'm', lines: 1 }).lines).toBe(1);
  });
});
