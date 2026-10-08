import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { amzDate, awsUriEncode, deriveSigningKey, sha256Hex, signRequest } from '../../src/lib/awsSigV4.js';
import { s3Request } from '../../src/lib/s3.js';

/**
 * 0.14 generic SigV4 signer (DESIGN §4.3).
 *
 * Known-answer checks: the signatures below are AWS's published values for
 * the example credentials (`AKIDEXAMPLE` / `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`,
 * 2015-08-30T12:36:00Z, us-east-1) — `get-vanilla` and
 * `post-x-www-form-urlencoded` from the SigV4 test suite, the IAM ListUsers
 * walkthrough of the SigV4 documentation, and the documented signing-key
 * derivation example. `get-header-value-trim` is pinned by its canonical
 * request (the part that vector exercises). Everything else is cross-checked
 * against `lib/s3.ts` (an independent, long-lived signer) or derived step by
 * step from a hand-written canonical request.
 */

const SUITE_CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const SUITE_DATE = new Date('2015-08-30T12:36:00Z');
const suite = { service: 'service', region: 'us-east-1', date: SUITE_DATE } as const;

describe('awsSigV4 — published SigV4 examples', () => {
  it('get-vanilla', () => {
    const signed = signRequest({ ...suite, method: 'GET', url: 'https://example.amazonaws.com/' }, SUITE_CREDS);
    expect(signed.canonicalRequest).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(signed.canonicalRequest)).toBe('bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
    expect(signed.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(signed.headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('post-x-www-form-urlencoded', () => {
    const signed = signRequest(
      {
        ...suite,
        method: 'POST',
        url: 'https://example.amazonaws.com/',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Param1=value1',
      },
      SUITE_CREDS,
    );
    expect(signed.signature).toBe('ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a');
    expect(signed.headers['authorization']).toContain('SignedHeaders=content-type;host;x-amz-date,');
  });

  it('get-header-value-trim: values trimmed and inner whitespace collapsed', () => {
    const signed = signRequest(
      { ...suite, method: 'GET', url: 'https://example.amazonaws.com/', headers: { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' } },
      SUITE_CREDS,
    );
    expect(signed.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'my-header1:value1',
        'my-header2:"a b c"',
        'x-amz-date:20150830T123600Z',
        '',
        'host;my-header1;my-header2;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
  });

  it('the IAM ListUsers documentation example (query string, content type, service iam)', () => {
    const signed = signRequest(
      {
        method: 'GET',
        url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        service: 'iam',
        region: 'us-east-1',
        date: SUITE_DATE,
      },
      SUITE_CREDS,
    );
    expect(sha256Hex(signed.canonicalRequest)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    expect(signed.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('derives the documented signing key', () => {
    expect(deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam').toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });
});

describe('awsSigV4 — canonicalisation details', () => {
  it('sorts and RFC 3986-encodes the query, and double-encodes non-S3 path segments', () => {
    const signed = signRequest(
      { ...suite, method: 'GET', url: 'https://example.amazonaws.com/a b/c%2Fd?b=2&a=x y&a=1&c=!*' },
      SUITE_CREDS,
    );
    const [, uri, query] = signed.canonicalRequest.split('\n');
    expect(uri).toBe('/a%2520b/c%252Fd');
    expect(query).toBe('a=1&a=x%20y&b=2&c=%21%2A');
    expect(awsUriEncode("!'()*~-._")).toBe('%21%27%28%29%2A~-._');
  });

  it('signs a session token and the payload hash header when asked', () => {
    const signed = signRequest(
      { ...suite, method: 'POST', url: 'https://example.amazonaws.com', body: '{}', contentSha256Header: true },
      { ...SUITE_CREDS, sessionToken: 'session-token' },
    );
    expect(signed.headers['x-amz-security-token']).toBe('session-token');
    expect(signed.headers['x-amz-content-sha256']).toBe(sha256Hex('{}'));
    expect(signed.headers['authorization']).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,');
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/');
  });

  it('formats the amz date', () => {
    expect(amzDate(new Date('2026-10-08T01:02:03.456Z'))).toBe('20261008T010203Z');
  });
});

describe('awsSigV4 — cross-check against lib/s3.ts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('signs an S3 PUT exactly as s3Request does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T09:30:00Z'));
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(''));
    vi.stubGlobal('fetch', fetchMock);
    const cfg = {
      endpoint: 'https://s3.eu-central-1.amazonaws.com',
      region: 'eu-central-1',
      bucket: 'nd-backups',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    };
    await s3Request(cfg, 'PUT', 'backups/db 1/dump(1).sql', 'payload', 'application/sql', new URLSearchParams({ partNumber: '2', uploadId: 'a/b' }));
    const [url, init] = fetchMock.mock.calls[0]!;
    const s3Headers = init!.headers as Record<string, string>;

    const ours = signRequest(
      {
        method: 'PUT',
        url: String(url),
        headers: { 'content-type': 'application/sql' },
        body: 'payload',
        service: 's3',
        region: 'eu-central-1',
        date: new Date('2026-10-08T09:30:00Z'),
        uriMode: 's3',
        contentSha256Header: true,
      },
      cfg,
    );
    expect(ours.headers['authorization']).toBe(s3Headers['authorization']);
    expect(ours.headers['x-amz-content-sha256']).toBe(s3Headers['x-amz-content-sha256']);
    expect(ours.headers['x-amz-date']).toBe(s3Headers['x-amz-date']);
  });
});

describe('awsSigV4 — GetSecretValue golden', () => {
  it('matches a step-by-step derivation from the hand-written canonical request', () => {
    const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
    const body = '{"SecretId":"prod/db"}';
    const signed = signRequest(
      {
        method: 'POST',
        url: 'https://secretsmanager.eu-west-1.amazonaws.com/',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'secretsmanager.GetSecretValue' },
        body,
        service: 'secretsmanager',
        region: 'eu-west-1',
        date: new Date('2026-10-08T12:00:00Z'),
      },
      creds,
    );
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const canonical = [
      'POST',
      '/',
      '',
      'content-type:application/x-amz-json-1.1',
      'host:secretsmanager.eu-west-1.amazonaws.com',
      'x-amz-date:20261008T120000Z',
      'x-amz-target:secretsmanager.GetSecretValue',
      '',
      'content-type;host;x-amz-date;x-amz-target',
      bodyHash,
    ].join('\n');
    expect(signed.canonicalRequest).toBe(canonical);
    const scope = '20261008/eu-west-1/secretsmanager/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', '20261008T120000Z', scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const h = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
    const key = h(h(h(h(`AWS4${creds.secretAccessKey}`, '20261008'), 'eu-west-1'), 'secretsmanager'), 'aws4_request');
    const expected = createHmac('sha256', key).update(stringToSign).digest('hex');
    expect(signed.stringToSign).toBe(stringToSign);
    expect(signed.signature).toBe(expected);
    // Regression pin of the same value.
    expect(signed.signature).toBe('26b5ec36eb1c160cd4a0aca227855940e033a01338604faf436b4476aeb4e497');
  });
});
