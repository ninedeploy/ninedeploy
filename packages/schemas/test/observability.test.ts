import { describe, expect, it } from 'vitest';
import { observabilityPatch, observabilitySettings } from '../src/observability.js';

describe('observability settings', () => {
  it('preserves the one-day upgrade default with exporters disabled', () => {
    expect(observabilitySettings.parse({})).toEqual({ retentionDays: 1, prometheusEnabled: false, otlpEndpoint: '', otlpAuthorization: '', logQueueMaxMb: 16 });
  });
  it('keeps omitted patch fields absent instead of applying defaults', () => {
    expect(observabilityPatch.parse({ retentionDays: 90 })).toEqual({ retentionDays: 90 });
    expect(observabilityPatch.parse({})).toEqual({});
    expect(observabilityPatch.safeParse({ unknownSetting: true }).success).toBe(false);
  });
  it.each(['https://collector.example/v1/metrics', 'http://localhost:4318/v1/metrics'])('accepts HTTP metrics endpoint %s', (otlpEndpoint) => {
    expect(observabilityPatch.parse({ otlpEndpoint }).otlpEndpoint).toBe(otlpEndpoint);
  });
  it.each(['https://user:secret@collector.example/v1/metrics', 'https://collector.example/v1/metrics#fragment', 'ftp://collector.example/metrics', 'not-a-url', 'https://collector.example/' + 'a'.repeat(2048)])('rejects an unsafe or invalid endpoint %s', (otlpEndpoint) => {
    expect(observabilityPatch.safeParse({ otlpEndpoint }).success).toBe(false);
  });
  it.each([{ retentionDays: 0 }, { retentionDays: 91 }, { retentionDays: 1.5 }, { logQueueMaxMb: 0 }, { logQueueMaxMb: 257 }, { otlpAuthorization: 'Bearer a\r\nX-Evil: 1' }, { otlpAuthorization: 'a'.repeat(4097) }])('rejects invalid bounds or header data: %j', (input) => {
    expect(observabilityPatch.safeParse(input).success).toBe(false);
  });
  it('allows an explicit endpoint/credential removal and maximum bounds', () => {
    expect(observabilityPatch.parse({ retentionDays: 90, logQueueMaxMb: 256, otlpEndpoint: '', otlpAuthorization: '' })).toEqual({ retentionDays: 90, logQueueMaxMb: 256, otlpEndpoint: '', otlpAuthorization: '' });
  });
});
