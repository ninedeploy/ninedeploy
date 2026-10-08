import { createHash, createHmac } from 'node:crypto';

/**
 * Generic AWS Signature Version 4 request signer (0.14) — zero dependencies,
 * node:crypto only. Used by the Secrets Manager and STS clients
 * (`lib/secretProviders/awsSecretsManager.ts`).
 *
 * `lib/s3.ts` keeps its own S3-only signer on purpose (DESIGN §4.1: not
 * refactored in 0.14); `test/lib/awsSigV4.test.ts` cross-checks both on one
 * S3 request so they cannot drift apart unnoticed.
 *
 * Canonicalisation follows the SigV4 spec:
 *   - header names lower-cased, values trimmed and inner whitespace runs
 *     collapsed to one space, sorted by name;
 *   - query parameters URI-encoded (RFC 3986 unreserved set) and sorted;
 *   - the canonical URI is the URL path with every segment encoded once
 *     more — except for S3, whose paths are used exactly as given
 *     (`uriMode: 's3'`).
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials (ASIA… keys) carry a session token. */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  url: string | URL;
  /** Extra headers to send and sign. `host` and `x-amz-date` are added. */
  headers?: Record<string, string>;
  body?: string | Buffer;
  service: string;
  region: string;
  /** Signing time; defaults to now. */
  date?: Date;
  /** Path canonicalisation: `aws` (default, double-encoded) or `s3` (as given). */
  uriMode?: 'aws' | 's3';
  /** Also send and sign `x-amz-content-sha256` (S3 requires it). */
  contentSha256Header?: boolean;
}

export interface SignedRequest {
  /** Every header to send, `authorization` included. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding of everything outside the unreserved set (`A-Za-z0-9-_.~`). */
export function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20150830T123600Z` for a date. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** The SigV4 signing key for one day, region and service. */
export function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

function canonicalUri(pathname: string, mode: 'aws' | 's3'): string {
  if (pathname === '') return '/';
  if (mode === 's3') return pathname;
  // `URL` already percent-encodes the path once; decode each segment back
  // to its raw bytes and apply the spec's double encoding from there.
  return pathname
    .split('/')
    .map((segment) => {
      let raw: string;
      try {
        raw = decodeURIComponent(segment);
      } catch {
        raw = segment;
      }
      return awsUriEncode(awsUriEncode(raw));
    })
    .join('/');
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

const canonicalHeaderValue = (value: string): string => value.trim().replace(/\s+/g, ' ');

/** Sign one request. Pure: no clock or network unless `date` is omitted. */
export function signRequest(req: SigV4Request, creds: SigV4Credentials): SignedRequest {
  const url = typeof req.url === 'string' ? new URL(req.url) : req.url;
  const date = amzDate(req.date ?? new Date());
  const dateStamp = date.slice(0, 8);
  const payloadHash = sha256Hex(req.body ?? '');

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) headers[name.toLowerCase()] = value;
  headers['host'] = url.host;
  headers['x-amz-date'] = date;
  if (req.contentSha256Header) headers['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((h) => `${h}:${canonicalHeaderValue(headers[h]!)}\n`).join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(url.pathname, req.uriMode ?? 'aws'),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', deriveSigningKey(creds.secretAccessKey, dateStamp, req.region, req.service))
    .update(stringToSign)
    .digest('hex');
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
