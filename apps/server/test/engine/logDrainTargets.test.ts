/** G3.4 log-drain targets: body formats, authentication, CloudWatch's create-then-retry, and Elasticsearch's bulk errors. */
import { describe, expect, it, vi } from 'vitest';
import { dispatchLogBatch } from '../../src/engine/logDrainManager.js';
import { cloudWatchCredentials, cloudWatchTarget, extraAuthHeaders, extraDrainUrlProblem, formatExtraBatch } from '../../src/engine/logDrainTargets.js';

const entries = [
  { timestamp: '2026-10-28T10:00:01.500Z', service: 'api', container: 'api-1', line: 'second', stream: 'stderr' as const },
  { timestamp: '2026-10-28T10:00:00.000Z', service: 'api', container: 'api-1', line: 'first' },
];

describe('formats', () => {
  it('writes an Elasticsearch bulk body into the index from the URL', () => {
    const { body, contentType } = formatExtraBatch('elasticsearch', 'https://es.example.com:9200/logs-nd', entries);
    expect(contentType).toBe('application/x-ndjson');
    const lines = body.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ create: { _index: 'logs-nd' } });
    expect(lines[1]).toEqual({ '@timestamp': '2026-10-28T10:00:01.500Z', message: 'second', service: 'api', container: 'api-1', stream: 'stderr' });
    expect(body.endsWith('\n')).toBe(true);
  });

  it('writes Splunk HEC events, New Relic, Axiom and Better Stack bodies', () => {
    const hec = formatExtraBatch('splunk', 'https://splunk:8088/services/collector/event', entries).body.split('\n').map((l) => JSON.parse(l));
    expect(hec[0]).toEqual({ time: Date.parse("2026-10-28T10:00:01.500Z") / 1000, host: 'api-1', source: 'api', sourcetype: 'ninedeploy', event: 'second', fields: { stream: 'stderr' } });
    const nr = JSON.parse(formatExtraBatch('newrelic', 'https://log-api.newrelic.com/log/v1', entries).body);
    expect(nr[0].logs[1]).toEqual({ timestamp: Date.parse('2026-10-28T10:00:00.000Z'), message: 'first', attributes: { service: 'api', container: 'api-1', stream: 'stdout' } });
    expect(JSON.parse(formatExtraBatch('axiom', 'https://api.axiom.co/v1/datasets/nd/ingest', entries).body)[1]).toMatchObject({ _time: '2026-10-28T10:00:00.000Z', message: 'first' });
    expect(JSON.parse(formatExtraBatch('betterstack', 'https://in.logs.betterstack.com', entries).body)[0]).toMatchObject({ dt: '2026-10-28T10:00:01.500Z', message: 'second' });
  });

  it('sorts CloudWatch events by time and reads the group and stream from the URL', () => {
    const url = 'https://logs.eu-west-1.amazonaws.com/?group=/nd/api&stream=panel-1';
    expect(cloudWatchTarget(url)).toEqual({ region: 'eu-west-1', group: '/nd/api', stream: 'panel-1', endpoint: 'https://logs.eu-west-1.amazonaws.com/' });
    const body = JSON.parse(formatExtraBatch('cloudwatch', url, entries).body);
    expect(body.logGroupName).toBe('/nd/api');
    expect(body.logEvents.map((e: { message: string }) => e.message)).toEqual(['[api/api-1] first', '[api/api-1] second']);
  });
});

describe('auth and URLs', () => {
  it('presents each key the way its service expects', () => {
    expect(extraAuthHeaders('elasticsearch', 'elastic:pw')).toEqual({ Authorization: `Basic ${Buffer.from('elastic:pw').toString('base64')}` });
    expect(extraAuthHeaders('elasticsearch', 'VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==')).toEqual({ Authorization: 'ApiKey VnVhQ2ZHY0JDZGJrUW0tZTVhT3g6dWkybHAyYXhUTm1zeWFrdzl0dk5udw==' });
    expect(extraAuthHeaders('splunk', 'abc')).toEqual({ Authorization: 'Splunk abc' });
    expect(extraAuthHeaders('newrelic', 'NRAK')).toEqual({ 'Api-Key': 'NRAK' });
    expect(extraAuthHeaders('axiom', 'xaat')).toEqual({ Authorization: 'Bearer xaat' });
    expect(cloudWatchCredentials('AKIA:secret:token:with:colons')).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token:with:colons' });
  });

  it('refuses URLs that do not name what the target needs', () => {
    expect(extraDrainUrlProblem('cloudwatch', 'https://logs.us-east-1.amazonaws.com/?group=g')).toMatch(/CloudWatch/);
    expect(extraDrainUrlProblem('cloudwatch', 'https://evil.example.com/?group=g&stream=s')).toMatch(/CloudWatch/);
    expect(extraDrainUrlProblem('elasticsearch', 'https://es.example.com:9200/')).toMatch(/index/);
    expect(extraDrainUrlProblem('elasticsearch', 'https://es.example.com:9200/_bulk')).toMatch(/index/);
    expect(extraDrainUrlProblem('elasticsearch', 'https://es.example.com:9200/logs')).toBeNull();
  });
});

describe('delivery', () => {
  it('reports the failed items of an Elasticsearch bulk request that answered 200', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: true, items: [{ create: { error: { reason: 'mapper_parsing_exception' } } }] }), { status: 200 }));
    const res = await dispatchLogBatch({ url: 'https://es.example.com/_bulk_target', type: 'elasticsearch', format: 'json', apiKey: 'k' }, entries, fetchImpl);
    expect(res).toEqual({ ok: false, status: 200, error: 'bulk request had failed items: mapper_parsing_exception' });
  });

  it('signs CloudWatch calls, and creates a missing stream once before retrying', async () => {
    const calls: Array<{ target: string; auth: string; body: string }> = [];
    let first = true;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const h = init!.headers as Record<string, string>;
      calls.push({ target: h['x-amz-target']!, auth: h['authorization']!, body: String(init!.body) });
      if (h['x-amz-target'] === 'Logs_20140328.PutLogEvents' && first) {
        first = false;
        return new Response(JSON.stringify({ __type: 'ResourceNotFoundException', message: 'The specified log stream does not exist.' }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    });
    const res = await dispatchLogBatch(
      { url: 'https://logs.eu-west-1.amazonaws.com/?group=nd&stream=s1', type: 'cloudwatch', format: 'json', apiKey: 'AKIAEXAMPLE:secret' },
      entries,
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.target)).toEqual(['Logs_20140328.PutLogEvents', 'Logs_20140328.CreateLogStream', 'Logs_20140328.PutLogEvents']);
    expect(calls[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/eu-west-1\/logs\/aws4_request/);
    expect(JSON.parse(calls[1]!.body)).toEqual({ logGroupName: 'nd', logStreamName: 's1' });
  });

  it('refuses a CloudWatch drain without key pair', async () => {
    const res = await dispatchLogBatch({ url: 'https://logs.eu-west-1.amazonaws.com/?group=nd&stream=s1', type: 'cloudwatch', format: 'json', apiKey: 'just-a-token' }, entries, vi.fn());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ACCESS_KEY_ID:SECRET_ACCESS_KEY/);
  });
});
