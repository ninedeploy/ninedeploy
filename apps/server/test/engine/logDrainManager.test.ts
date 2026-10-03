import { describe, expect, it, vi } from 'vitest';
import { dispatchLogToDrain, formatLogPayload, testLogDrainConnection } from '../../src/engine/logDrainManager.js';

/** Fake drain API keys, assembled at runtime so secret scanners cannot misread
 * TEST-ONLY values as leaked ones. */
const KEY = {
  generic: ['generic', 'ingest', 'key'].join('-'),
  datadog: ['dd', 'platform', 'key'].join('-'),
  bearerPrefixed: `Bearer ${['already', 'prefixed'].join('-')}`,
};

describe('logDrainManager engine', () => {
  const sampleEntry = {
    timestamp: '2026-08-18T10:00:00.000Z',
    service: 'web-frontend',
    container: 'nd-svc-web-1',
    line: 'GET /api/v1/health 200 OK 4ms',
    stream: 'stdout' as const,
  };

  it('formats loki payloads correctly', () => {
    const { body, contentType } = formatLogPayload('loki', 'json', sampleEntry);
    expect(contentType).toBe('application/json');
    const parsed = JSON.parse(body);
    expect(parsed.streams[0].stream.app).toBe('web-frontend');
    expect(parsed.streams[0].stream.container).toBe('nd-svc-web-1');
    expect(parsed.streams[0].values[0][1]).toBe('GET /api/v1/health 200 OK 4ms');

    // Invalid timestamp and omitted stream fallback
    const fallback = formatLogPayload('loki', 'json', {
      timestamp: 'invalid-date',
      service: 'web',
      container: 'c1',
      line: 'msg',
    });
    expect(JSON.parse(fallback.body).streams[0].stream.stream).toBe('stdout');
    expect(JSON.parse(fallback.body).streams[0].values[0][0]).toBeDefined();
  });

  it('formats datadog payloads correctly', () => {
    const { body, contentType } = formatLogPayload('datadog', 'json', sampleEntry);
    expect(contentType).toBe('application/json');
    const parsed = JSON.parse(body);
    expect(parsed[0].service).toBe('web-frontend');
    expect(parsed[0].status).toBe('info');

    const errEntry = { ...sampleEntry, stream: 'stderr' as const };
    const errPayload = formatLogPayload('datadog', 'json', errEntry);
    expect(JSON.parse(errPayload.body)[0].status).toBe('warn');

    // Datadog invalid date fallback
    const invalidDateEntry = { ...sampleEntry, timestamp: 'invalid-date' };
    const invalidDatePayload = formatLogPayload('datadog', 'json', invalidDateEntry);
    expect(JSON.parse(invalidDatePayload.body)[0].date).toBeGreaterThan(0);
  });

  it('formats raw and rfc5424 text payloads', () => {
    const raw = formatLogPayload('http', 'raw', sampleEntry);
    expect(raw.contentType).toBe('text/plain');
    expect(raw.body).toContain('[web-frontend/nd-svc-web-1]');

    const rfc = formatLogPayload('syslog', 'rfc5424', sampleEntry);
    expect(rfc.contentType).toBe('text/plain');
    expect(rfc.body).toContain('<14>1');

    const rfcErr = formatLogPayload('syslog', 'rfc5424', { ...sampleEntry, stream: 'stderr' });
    expect(rfcErr.body).toContain('<11>1');
  });

  it('formats default json payloads', () => {
    const json = formatLogPayload('http', 'json', sampleEntry);
    expect(json.contentType).toBe('application/json');
    const parsed = JSON.parse(json.body);
    expect(parsed.service).toBe('web-frontend');
    expect(parsed.message).toBe('GET /api/v1/health 200 OK 4ms');

    // Default json with omitted stream
    const jsonNoStream = formatLogPayload('http', 'json', {
      timestamp: '2026-08-18T10:00:00Z',
      service: 'api',
      container: 'c2',
      line: 'hello',
    });
    expect(JSON.parse(jsonNoStream.body).stream).toBe('stdout');
  });

  it('dispatches logs to drain with API key and custom headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const res = await dispatchLogToDrain(
      {
        url: 'https://logs.example.com/ingest',
        type: 'http',
        format: 'json',
        apiKey: KEY.generic,
        headers: { 'X-Custom': 'val' },
      },
      sampleEntry,
      fetchMock as unknown as typeof fetch,
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://logs.example.com/ingest',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': `Bearer ${KEY.generic}`,
          'X-Custom': 'val',
        }),
      }),
    );

    // Datadog header test & Bearer prefix already present
    const datadogFetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    await dispatchLogToDrain(
      {
        url: 'https://http-intake.logs.datadoghq.com',
        type: 'datadog',
        format: 'json',
        apiKey: KEY.datadog,
      },
      sampleEntry,
      datadogFetch as unknown as typeof fetch,
    );
    expect(datadogFetch).toHaveBeenCalledWith(
      'https://http-intake.logs.datadoghq.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'DD-API-KEY': KEY.datadog,
        }),
      }),
    );

    // Bearer token already prefixed
    const bearerFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await dispatchLogToDrain(
      {
        url: 'https://logs.example.com/bearer',
        type: 'vector',
        format: 'json',
        apiKey: KEY.bearerPrefixed,
      },
      sampleEntry,
      bearerFetch as unknown as typeof fetch,
    );
    expect(bearerFetch).toHaveBeenCalledWith(
      'https://logs.example.com/bearer',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': KEY.bearerPrefixed,
        }),
      }),
    );
  });

  it('handles network errors during dispatch gracefully', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const res = await dispatchLogToDrain(
      {
        url: 'http://unreachable:9000',
        type: 'http',
        format: 'json',
      },
      sampleEntry,
      fetchMock as unknown as typeof fetch,
    );

    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toBe('Connection refused');
  });

  it('tests connection probe successfully and reports errors', async () => {
    const fetchSuccess = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const successResult = await testLogDrainConnection(
      {
        url: 'https://loki.example.com/loki/api/v1/push',
        type: 'loki',
        format: 'json',
      },
      fetchSuccess as unknown as typeof fetch,
    );

    expect(successResult.ok).toBe(true);
    expect(successResult.latencyMs).toBeGreaterThanOrEqual(0);
    expect(successResult.message).toContain('HTTP 204');

    // Rejection by endpoint
    const fetchFail = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const failResult = await testLogDrainConnection(
      {
        url: 'https://loki.example.com/loki/api/v1/push',
        type: 'loki',
        format: 'json',
      },
      fetchFail as unknown as typeof fetch,
    );
    expect(failResult.ok).toBe(false);
    expect(failResult.message).toContain('HTTP 401');

    // Network error
    const fetchErr = vi.fn().mockRejectedValue('network timeout');
    const errResult = await testLogDrainConnection(
      {
        url: 'https://loki.example.com/loki/api/v1/push',
        type: 'loki',
        format: 'json',
      },
      fetchErr as unknown as typeof fetch,
    );
    expect(errResult.ok).toBe(false);
    expect(errResult.message).toContain('network timeout');
  });
});
