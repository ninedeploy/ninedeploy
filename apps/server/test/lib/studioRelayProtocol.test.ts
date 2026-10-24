import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  STUDIO_RELAY_HKDF_INFO, STUDIO_RELAY_FRAME, STUDIO_RELAY_FRAME_TYPES,
  STUDIO_RELAY_MAX_BODY, STUDIO_RELAY_MAX_HEAD,
  encodeStudioRequest, decodeStudioRequest, encodeStudioResponseHead, decodeStudioResponseHead,
  studioRequestHeaders, type StudioRelayRequest,
} from '../../src/lib/studioRelayProtocol.js';
import { deriveFrameKey, FrameOpener, FrameSealer } from '../../src/lib/agentFrameCipher.js';

const request: StudioRelayRequest = { method: 'POST', path: '/?pgsql=nd-db-orders&db=app', headers: [['content-type', 'multipart/form-data; boundary=owned']], bodyBytes: 123 };
describe('node Studio HTTP wire contract', () => {
  it('round trips an origin-form multipart request and duplicate response cookies', () => {
    expect(decodeStudioRequest(encodeStudioRequest(request))).toEqual(request);
    const head = { status: 302, headers: [['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['Location', '?server=nd-db-orders']] as [string, string][] };
    expect(decodeStudioResponseHead(encodeStudioResponseHead(head))).toEqual(head);
  });
  it.each(['http://other/path', 'https://other/path', '*', '/bad\r\nHost: other', '/bad\0path', '/raw space'])('refuses a non-origin-form or invalid path %j', path => {
    expect(() => encodeStudioRequest({ ...request, path })).toThrow();
  });
  it.each([{ method: 'CONNECT' }, { host: 'other' }, { port: 8080 }, { url: 'http://other' }, { bodyBytes: -1 }, { bodyBytes: 0.5 }, { bodyBytes: STUDIO_RELAY_MAX_BODY + 1 }])('refuses unsupported authority/framing operands %j', extra => {
    expect(() => decodeStudioRequest(Buffer.from(JSON.stringify({ ...request, ...extra })))).toThrow();
  });
  it.each([['bad name', 'a'], ['x-test', 'bad\r\nHeader: value'], ['x-test', 'bad\0value'], ['x-test', '\u0100']])('refuses invalid HTTP header bytes', (name, value) => {
    expect(() => encodeStudioResponseHead({ status: 200, headers: [[name, value]] })).toThrow();
  });
  it.each([0, STUDIO_RELAY_MAX_BODY])('accepts the exact body bound %s', bodyBytes => {
    expect(decodeStudioRequest(encodeStudioRequest({ ...request, bodyBytes })).bodyBytes).toBe(bodyBytes);
  });
  it.each([101, 199, 600, 200.5])('refuses an unsupported response status %s', status => {
    expect(() => encodeStudioResponseHead({ status, headers: [] })).toThrow();
  });
  it('rejects oversized encoded metadata, excess headers and invalid UTF-8', () => {
    const oversized = { status: 200, headers: Array.from({ length: 12 }, () => ['x-test', 'x'.repeat(8192)] as [string, string]) };
    expect(() => encodeStudioResponseHead(oversized)).toThrow('64 KiB');
    expect(() => decodeStudioResponseHead(Buffer.alloc(STUDIO_RELAY_MAX_HEAD + 1, 32))).toThrow('64 KiB');
    expect(() => encodeStudioResponseHead({ status: 200, headers: Array.from({ length: 129 }, () => ['x-test', 'ok'] as [string, string]) })).toThrow();
    expect(() => decodeStudioResponseHead(Buffer.from([0xff]))).toThrow();
    expect(() => decodeStudioResponseHead(Buffer.from('{}'))).toThrow();
  });
  it('removes panel credentials, authority/framing, forwarding and Connection-nominated headers', () => {
    expect(studioRequestHeaders([
      ['Authorization', 'Bearer panel-token'], ['Proxy-Authorization', 'private'], ['Host', 'caller'], ['Content-Length', '999'],
      ['Transfer-Encoding', 'chunked'], ['Accept-Encoding', 'gzip'], ['X-Forwarded-Host', 'caller'], ['Origin', 'http://panel'],
      ['Connection', 'keep-alive, accept-language'], ['Accept-Language', 'en'], ['Cookie', 'nd-studio-13=panel-session; adminer_sid=studio-session'],
      ['Accept', 'text/html'], ['Content-Type', 'application/octet-stream'], ['Range', 'bytes=0-99'],
    ])).toEqual([['cookie', 'adminer_sid=studio-session'], ['accept', 'text/html'], ['content-type', 'application/octet-stream'], ['range', 'bytes=0-99']]);
    expect(studioRequestHeaders([['COOKIE', 'ND-Studio-1=private; nd-studio-2=private']])).toEqual([]);
  });
  it('authenticates HTTP frames under a key independent of stream and terminal channels', () => {
    const secret = randomBytes(32).toString('hex'), salt = randomBytes(32);
    const key = deriveFrameKey(secret, salt, STUDIO_RELAY_HKDF_INFO);
    const frame = new FrameSealer(key, 'agent').seal(STUDIO_RELAY_FRAME.head, encodeStudioResponseHead({ status: 200, headers: [] }));
    const opened = new FrameOpener(key, 'agent', STUDIO_RELAY_FRAME_TYPES).open(frame);
    expect(opened.type).toBe(STUDIO_RELAY_FRAME.head);
    expect(decodeStudioResponseHead(opened.payload)).toEqual({ status: 200, headers: [] });
    for (const domain of ['ninedeploy-agent-stream-v1', 'ninedeploy-agent-terminal-v1']) {
      expect(() => new FrameOpener(deriveFrameKey(secret, salt, domain), 'agent', STUDIO_RELAY_FRAME_TYPES).open(frame)).toThrow();
    }
    const receiver = new FrameOpener(key, 'agent', STUDIO_RELAY_FRAME_TYPES);
    receiver.open(frame);
    expect(() => receiver.open(frame)).toThrow();
    expect(() => new FrameOpener(key, 'panel', STUDIO_RELAY_FRAME_TYPES).open(frame)).toThrow();
  });
});
