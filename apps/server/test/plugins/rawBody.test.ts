import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

const rawBodyPlugin = (await import('../../src/plugins/rawBody.js')).default;

async function buildApp() {
  const app = Fastify();
  await app.register(rawBodyPlugin);
  app.post('/echo-json', async (req) => ({ body: req.body, raw: (req.rawBody as Buffer | undefined)?.toString() }));
  app.post('/echo-bin', async (req) => ({ body: req.body, raw: (req.rawBody as Buffer | undefined)?.toString('latin1') }));
  return app;
}

describe('rawBody plugin', () => {
  it('captures the raw bytes for application/json while still parsing the body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
    await app.close();
  });

  it('rejects malformed JSON with a parser error', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    // r506: Fastify's own parser answers a malformed body with a 400
    // (FST_ERR_CTP_INVALID_JSON_BODY), not the bare SyntaxError's 500.
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('JSON');
    await app.close();
  });

  it('handles nested JSON payloads', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"nested":{"list":[1,2,3]}}',
    });
    expect(res.json().body).toEqual({ nested: { list: [1, 2, 3] } });
    await app.close();
  });

  it('parses application/octet-stream as a binary string', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-bin',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0x01, 0x02, 0xff]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe('\x01\x02\xff');
    await app.close();
  });

  it('still exposes the raw buffer on non-JSON content types registered by the parser', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-bin',
      headers: { 'content-type': 'application/octet-stream' },
      payload: 'hello',
    });
    expect(res.json().body).toBe('hello');
    await app.close();
  });

  // r506: the plugin replaced Fastify's secure parser with JSON.parse, so a
  // `__proto__` / `constructor.prototype` key reached handlers that merge the
  // body into other objects. Both are refused now, like stock Fastify does.
  it('refuses __proto__ poisoning instead of handing it to the handler', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1,"__proto__":{"isOperator":true}}',
    });
    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>)['isOperator']).toBeUndefined();
    await app.close();
  });

  it('refuses constructor.prototype poisoning', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"constructor":{"prototype":{"polluted":true}}}',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('still captures the raw bytes of a body that parses cleanly (webhook HMAC)', async () => {
    const app = await buildApp();
    const payload = '{"ref":"refs/heads/main", "constructor":"plain-string-is-fine"}';
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().raw).toBe(payload);
    await app.close();
  });

  it('keeps answering an empty JSON body as {} (r477)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/echo-json',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({});
    await app.close();
  });
});
