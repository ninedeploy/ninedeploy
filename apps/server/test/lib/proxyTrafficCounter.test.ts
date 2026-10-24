import { describe, expect, it } from 'vitest';
import { ProxyTrafficCounter, parseProxyAccessRecord, proxyTrafficTargetHash } from '../../src/lib/proxyTrafficCounter.js';
import type { ProxyTrafficOpen } from '@ninedeploy/schemas';

export const trafficInput: ProxyTrafficOpen = { requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4, step: 1,
  slug: 'web', durationMs: 1000, routingConfig: 'http: {}', stable: [{ name: 'web-old', id: 'a'.repeat(64), port: 8080 }], canary: [{ name: 'web-new', id: 'b'.repeat(64), port: 8080 }] };
const line = (seq: number, over: { request?: string; status?: number; router?: string; upstream?: string; ms?: number } = {}) =>
  `172.18.0.2 - - [24/Oct/2026:12:00:00 +0000] ${JSON.stringify(over.request ?? 'GET /private?token=fixture HTTP/1.1')} ${over.status ?? 200} 3 "private-referer" "private-agent" ${seq} ${JSON.stringify(over.router ?? 'web_1@file')} ${JSON.stringify(over.upstream ?? 'http://web-new:8080')} ${over.ms ?? 10}ms`;
const begin = () => { const counter = new ProxyTrafficCounter(trafficInput, 'c'.repeat(32));
  counter.ingest(line(10, { request: `GET ${counter.startPath} HTTP/1.1`, status: 404, router: '-', upstream: '-' })); return counter; };
const end = (counter: ProxyTrafficCounter, seq: number) => {
  counter.requestFinish(); counter.ingest(line(seq, { request: `GET ${counter.endPath} HTTP/1.1`, status: 404, router: '-', upstream: '-' }));
};

describe('Traefik sequence-bounded observations', () => {
  it('covers every request between markers and attributes exact runtime URLs', () => {
    const c = begin(); c.ingest(line(11, { status: 503, ms: 90 })); c.ingest(line(12, { upstream: 'http://web-old:8080' })); end(c, 13);
    expect(c.snapshot()).toMatchObject({ startCounter: '10', endCounter: '13', observed: 2, expected: 2, complete: true,
      canary: { requests: 1, errors: 1, errorRate: 100, p95Ms: 90 }, stable: { requests: 1, errors: 0 } });
    expect(JSON.stringify(c.snapshot())).not.toMatch(/private|token|referer|agent/);
  });
  it('does not treat missing records as zero successful traffic', () => {
    const c = begin(); c.ingest(line(12)); end(c, 14);
    expect(c.snapshot()).toMatchObject({ observed: 1, expected: 3, complete: false });
  });
  it('accepts out-of-order completion only after every sequence arrives', () => {
    const c = begin(); c.ingest(line(12)); end(c, 13); expect(c.snapshot().complete).toBe(false);
    c.ingest(line(11)); expect(c.snapshot()).toMatchObject({ complete: true, observed: 2 });
  });
  it('counts no post-marker responses even when they completed before the marker log', () => {
    const c = begin(); c.ingest(line(14, { status: 503 })); c.ingest(line(11)); end(c, 12);
    expect(c.snapshot()).toMatchObject({ complete: true, observed: 1, canary: { requests: 1, errors: 0 } });
  });
  it('counts requests logged before the start marker when their start sequence is inside the window', () => {
    const c = new ProxyTrafficCounter(trafficInput, 'c'.repeat(32)); c.ingest(line(11));
    c.ingest(line(10, { request: `GET ${c.startPath} HTTP/1.1`, status: 404, router: '-', upstream: '-' })); end(c, 12);
    expect(c.snapshot()).toMatchObject({ complete: true, canary: { requests: 1 } });
  });
  it('proves an actually empty window with consecutive live markers', () => {
    const c = begin(); end(c, 11); expect(c.snapshot()).toMatchObject({ complete: true, observed: 0, expected: 0, canary: { errorRate: null } });
  });
  it('excludes other routers and middleware/client refusals while preserving global coverage', () => {
    const c = begin(); c.ingest(line(11, { router: 'web-other_1@file' })); c.ingest(line(12, { status: 401, upstream: '-' })); end(c, 13);
    expect(c.snapshot()).toMatchObject({ complete: true, observed: 2, canary: { requests: 0 } });
  });
  it.each([{ status: 500, upstream: '-' }, { upstream: 'http://other:8080' }])('refuses a changed or unattributable runtime %j', over => {
    const c = begin(); expect(() => c.ingest(line(11, over))).toThrow(/cannot be attributed|route changed/);
  });
  it('refuses duplicate counters, routed markers and impossible end counters', () => {
    const c = begin(); c.ingest(line(11)); expect(() => c.ingest(line(11))).toThrow(/duplicate/);
    const d = begin(); d.requestFinish(); expect(() => d.ingest(line(12, { request: `GET ${d.endPath} HTTP/1.1` }))).toThrow(/marker was routed/);
    const e = begin(); expect(() => end(e, 9)).toThrow(/invalid end marker/);
  });
  it('bounds records and refuses an unbounded sequence gap', () => {
    const c = begin(); expect(() => end(c, 100_012)).toThrow(/limit/);
  });
  it('does not return a snapshot before a live start marker', () => {
    expect(() => new ProxyTrafficCounter(trafficInput, 'c'.repeat(32)).snapshot()).toThrow(/not observed/);
  });
  it('ignores operational lines but refuses malformed access lines without exposing their contents', () => {
    expect(parseProxyAccessRecord('INFO config reloaded')).toBeNull();
    expect(() => parseProxyAccessRecord('172.18.0.2 - - [private timestamp] broken')).toThrow('malformed access log');
    expect(() => parseProxyAccessRecord(line(1, { status: 999 }))).toThrow(/invalid response/);
    expect(() => parseProxyAccessRecord(line(1, { status: 0 }))).toThrow(/malformed access/);
    expect(() => parseProxyAccessRecord('x'.repeat(16_385))).toThrow(/oversized/);
  });
  it('parses escaped private strings without attributing them as routers or counters', () => {
    const record = parseProxyAccessRecord(line(42, { request: 'GET /a"b\\c HTTP/1.1' }));
    expect(record).toMatchObject({ sequence: 42n, router: 'web_1@file', upstream: 'http://web-new:8080' });
  });
  it('binds the entire selected placement and reservation into the target hash', () => {
    expect(proxyTrafficTargetHash(trafficInput)).toMatch(/^[a-f0-9]{64}$/);
    expect(proxyTrafficTargetHash({ ...trafficInput, nodeId: 9 })).not.toBe(proxyTrafficTargetHash(trafficInput));
  });
});
