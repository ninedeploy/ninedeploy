import { z } from 'zod';
import { STUDIO_HKDF_INFO } from './agentFrameCipher.js';

/** Separate keys and frame vocabulary for the node Studio HTTP exchange. */
export const STUDIO_RELAY_HKDF_INFO = STUDIO_HKDF_INFO;
export const STUDIO_RELAY_PATH = '/agent/studio';
export const STUDIO_RELAY_PROTOCOL_PREFIX = 'ninedeploy.agent-studio.';
export const STUDIO_RELAY_MAX_BODY = 256 * 1024 * 1024;
export const STUDIO_RELAY_MAX_HEAD = 64 * 1024;
export const STUDIO_RELAY_FRAME = {
  data: 0,
  start: 1,
  head: 2,
  close: 3,
  pause: 4,
  resume: 5,
  end: 6,
  error: 7,
} as const;
export const STUDIO_RELAY_FRAME_TYPES: ReadonlySet<number> = new Set(Object.values(STUDIO_RELAY_FRAME));

const headerName = z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i);
const headerValue = z.string().max(8192).regex(/^[\t\x20-\x7e\x80-\xff]*$/);
const headers = z.array(z.tuple([headerName, headerValue])).max(128);
export type StudioRelayHeaders = z.infer<typeof headers>;

/** Only origin-form HTTP requests; no caller-selected protocol, host or port. */
export const studioRelayRequest = z.object({
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  path: z.string().min(1).max(8192).regex(/^\/[\x21-\x7e]*$/),
  headers,
  bodyBytes: z.number().int().min(0).max(STUDIO_RELAY_MAX_BODY),
}).strict();
export type StudioRelayRequest = z.infer<typeof studioRelayRequest>;

export const studioRelayResponseHead = z.object({
  status: z.number().int().min(200).max(599),
  headers,
}).strict();
export type StudioRelayResponseHead = z.infer<typeof studioRelayResponseHead>;
const studioRelayEnd = z.object({
  bytes: z.number().int().min(0).max(STUDIO_RELAY_MAX_BODY),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type StudioRelayEnd = z.infer<typeof studioRelayEnd>;

function encodeHead(value: unknown, schema: typeof studioRelayRequest | typeof studioRelayResponseHead): Buffer {
  const data = Buffer.from(JSON.stringify(schema.parse(value)));
  if (data.length > STUDIO_RELAY_MAX_HEAD) throw new Error('Studio relay headers exceed 64 KiB');
  return data;
}

export function encodeStudioRequest(value: StudioRelayRequest): Buffer {
  return encodeHead(value, studioRelayRequest);
}

export function encodeStudioResponseHead(value: StudioRelayResponseHead): Buffer {
  return encodeHead(value, studioRelayResponseHead);
}

/** Check encoded bounds before parsing, and reject invalid UTF-8 rather than replacing it. */
function parseHead<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  if (bytes.length > STUDIO_RELAY_MAX_HEAD) throw new Error('Studio relay headers exceed 64 KiB');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return schema.parse(JSON.parse(text));
}

export const decodeStudioRequest = (bytes: Buffer): StudioRelayRequest => parseHead(bytes, studioRelayRequest);
export const decodeStudioResponseHead = (bytes: Buffer): StudioRelayResponseHead => parseHead(bytes, studioRelayResponseHead);
export const encodeStudioEnd = (value: StudioRelayEnd): Buffer => Buffer.from(JSON.stringify(studioRelayEnd.parse(value)));
export const decodeStudioEnd = (bytes: Buffer): StudioRelayEnd => parseHead(bytes, studioRelayEnd);

// A Studio receives only the HTTP context it needs, never panel credentials,
// forwarding headers or a caller's authority/framing headers. Content-Length
// is set from the actual buffered request body by the node HTTP adapter.
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'cache-control', 'content-type', 'cookie',
  'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'range', 'if-range',
]);

export function studioRequestHeaders(input: StudioRelayHeaders): StudioRelayHeaders {
  const parsed = headers.parse(input);
  const nominated = new Set(parsed.filter(([name]) => name.toLowerCase() === 'connection')
    .flatMap(([, value]) => value.split(',').map(token => token.trim().toLowerCase())));
  const output: StudioRelayHeaders = [];
  for (const [name, value] of parsed) {
    const lower = name.toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(lower) || nominated.has(lower)) continue;
    if (lower === 'cookie') {
      const cookies = value.split(';').map(cookie => cookie.trim())
        .filter(cookie => !/^nd-studio-/i.test(cookie.split('=', 1)[0] ?? ''));
      if (cookies.filter(Boolean).length) output.push([lower, cookies.filter(Boolean).join('; ')]);
    } else output.push([lower, value]);
  }
  return output;
}
